//! Bring-your-own-agent: detect and drive the vendor CLIs the user is already
//! logged in to (Claude Code, Codex, Gemini CLI, Cursor Agent, OpenCode).
//!
//! Kiln never sees the user's credentials. It spawns the official CLI, which
//! uses its own login, and points it at Kiln's local MCP server. Arguments are
//! always passed as an argv array, never through a shell.

use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::sync::oneshot;

use crate::agent::SharedHub;
use crate::storage::atomic_write;

pub const EVENT_OUTPUT: &str = "kiln://cli-output";
pub const EVENT_EXIT: &str = "kiln://cli-exit";
pub const RUN_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// Time between SIGTERM and SIGKILL when cancelling a run.
const KILL_GRACE: Duration = Duration::from_secs(3);
/// After the child exits, how long to wait for its output pipes to drain.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const WORKSPACE_NOTE: &str = "You are operating the Kiln design canvas through the `kiln` MCP tools. \
Make every change to the design with those tools. You may load and read your installed skills \
(design, UI or typography guidance, for example) and follow them, but apply their advice through \
the `kiln` tools: do not edit files in this folder or write code files.\n";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct KnownCli {
    pub id: &'static str,
    pub name: &'static str,
    pub bin: &'static str,
}

pub const KNOWN_CLIS: [KnownCli; 5] = [
    KnownCli { id: "claude", name: "Claude Code", bin: "claude" },
    KnownCli { id: "codex", name: "Codex CLI", bin: "codex" },
    KnownCli { id: "gemini", name: "Gemini CLI", bin: "gemini" },
    KnownCli { id: "cursor-agent", name: "Cursor Agent", bin: "cursor-agent" },
    KnownCli { id: "opencode", name: "OpenCode", bin: "opencode" },
];

fn known(id: &str) -> Result<&'static KnownCli, String> {
    KNOWN_CLIS
        .iter()
        .find(|c| c.id == id)
        .ok_or_else(|| format!("unknown agent CLI {id:?}"))
}

pub fn mcp_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/mcp")
}

// ---------------------------------------------------------------------------
// Blocking subprocess capture (probes, connect commands, login shell)
// ---------------------------------------------------------------------------

pub struct Captured {
    /// `None` if the process timed out and was killed.
    pub status: Option<ExitStatus>,
    pub stdout: String,
    pub stderr: String,
}

impl Captured {
    fn success(&self) -> bool {
        self.status.is_some_and(|s| s.success())
    }

    fn combined(&self) -> String {
        let (o, e) = (self.stdout.trim(), self.stderr.trim());
        match (o.is_empty(), e.is_empty()) {
            (false, false) => format!("{o}\n{e}"),
            (false, true) => o.to_string(),
            _ => e.to_string(),
        }
    }
}

/// Puts the child in its own process group (unix) / hides its console (windows),
/// so the whole tree can be killed and nothing flashes on screen.
fn isolate(cmd: &mut std::process::Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Kills the process tree rooted at `pid` immediately. On Windows this starts `taskkill /T /F`
/// without waiting for it, since it is called from async tasks and while holding the runs lock.
fn kill_tree(pid: u32) {
    #[cfg(unix)]
    signal_group(pid, libc::SIGKILL);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let spawned = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        if let Ok(mut child) = spawned {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
    }
}

#[cfg(unix)]
fn signal_group(pgid: u32, sig: libc::c_int) {
    // SAFETY: killpg has no memory-safety preconditions; errors (ESRCH) are ignored.
    unsafe {
        libc::killpg(pgid as libc::pid_t, sig);
    }
}

/// A Windows Job object holding a child and everything it starts. On Windows an agent CLI is
/// usually an npm `.cmd` shim: cmd.exe starts node, which starts more processes, so killing the
/// shim alone would leave the agent running. The job is created with KILL_ON_JOB_CLOSE, so the
/// whole tree also goes when the last handle closes, even if Kiln itself crashes.
#[cfg(windows)]
mod win_job {
    use std::os::windows::io::RawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Job(HANDLE);

    // SAFETY: a job handle is a kernel handle, usable from any thread.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        /// A new kill-on-close job with `process` in it, or None if Windows refuses.
        pub fn assign(process: RawHandle) -> Option<Job> {
            // SAFETY: plain Win32 calls on handles we own; `info` outlives the call that reads it.
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return None;
                }
                let job = Job(job);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let set = SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if set == 0 || AssignProcessToJobObject(job.0, process as HANDLE) == 0 {
                    return None;
                }
                Some(job)
            }
        }

        /// Kills every process in the job. False if Windows refused.
        pub fn terminate(&self) -> bool {
            // SAFETY: the handle is valid until Drop.
            unsafe { TerminateJobObject(self.0, 1) != 0 }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: closed exactly once; KILL_ON_JOB_CLOSE ends anything still in the job.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// A child process and everything it starts: its process group on unix, a Job object on
/// Windows (with `taskkill /T` as the fallback).
pub(crate) struct Tree {
    pid: Option<u32>,
    #[cfg(windows)]
    job: Option<win_job::Job>,
}

impl Tree {
    fn of_std(child: &std::process::Child) -> Tree {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            Tree { pid: Some(child.id()), job: win_job::Job::assign(child.as_raw_handle()) }
        }
        #[cfg(not(windows))]
        {
            Tree { pid: Some(child.id()) }
        }
    }

    fn of_tokio(child: &tokio::process::Child) -> Tree {
        #[cfg(windows)]
        {
            Tree { pid: child.id(), job: child.raw_handle().and_then(win_job::Job::assign) }
        }
        #[cfg(not(windows))]
        {
            Tree { pid: child.id() }
        }
    }

    /// Asks the tree to stop: SIGTERM to the group on unix. Windows has no such signal for
    /// console-less processes, so there it kills.
    fn stop(&self) {
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            signal_group(pid, libc::SIGTERM);
        }
        #[cfg(not(unix))]
        self.kill();
    }

    /// Kills the whole tree now.
    fn kill(&self) {
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.terminate();
        }
        // On Windows too, as a backup: the child joins its job just after it starts (std can't
        // start it suspended), and node may start processes outside the job.
        if let Some(pid) = self.pid {
            kill_tree(pid);
        }
    }

    /// After the child has exited: kills whatever it left behind (e.g. node subprocesses
    /// still holding the output pipes).
    fn reap(&self) {
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            signal_group(pid, libc::SIGKILL);
        }
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.terminate();
        }
    }
}

/// Runs `cmd` with stdin closed, collecting stdout/stderr, killing it after `timeout`.
pub fn capture(mut cmd: std::process::Command, timeout: Duration) -> std::io::Result<Captured> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    isolate(&mut cmd);
    let mut child = cmd.spawn()?;
    let tree = Tree::of_std(&child);
    let (tx, rx) = mpsc::channel::<(bool, Vec<u8>)>();
    let readers: [(bool, Option<Box<dyn Read + Send>>); 2] = [
        (true, child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>)),
        (false, child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>)),
    ];
    for (is_out, pipe) in readers {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut buf);
            }
            let _ = tx.send((is_out, buf));
        });
    }
    drop(tx);

    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(s) = child.try_wait()? {
            break Some(s);
        }
        if Instant::now() >= deadline {
            tree.kill();
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    // Grandchildren may keep a pipe open; don't wait on them forever.
    tree.reap();

    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    for _ in 0..2 {
        match rx.recv_timeout(DRAIN_TIMEOUT) {
            Ok((true, b)) => stdout = b,
            Ok((false, b)) => stderr = b,
            Err(_) => break,
        }
    }
    Ok(Captured {
        status,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

// ---------------------------------------------------------------------------
// PATH: GUI apps on macOS don't inherit the user's shell PATH
// ---------------------------------------------------------------------------

static AGENT_PATH: OnceLock<OsString> = OnceLock::new();

/// PATH used both to find agent CLIs and to run them (so `#!/usr/bin/env node`
/// resolves). Computed once; the first call may take a few seconds.
pub fn agent_path() -> &'static OsString {
    AGENT_PATH.get_or_init(|| compute_agent_path(std::env::var_os("PATH")))
}

pub fn compute_agent_path(process_path: Option<OsString>) -> OsString {
    #[cfg(unix)]
    {
        let login = login_shell_path(process_path.as_deref());
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let extras: Vec<PathBuf> = extra_dirs(home.as_deref()).into_iter().filter(|d| d.is_dir()).collect();
        merge_paths(login.as_deref().map(OsStr::new), process_path.as_deref(), &extras)
    }
    #[cfg(windows)]
    {
        // A GUI app on Windows inherits the user's PATH; add the usual install folders in case
        // a CLI was installed after login (or by a tool that doesn't touch PATH).
        let extras: Vec<PathBuf> = windows_extra_dirs(&WinDirs::from_env()).into_iter().filter(|d| d.is_dir()).collect();
        merge_paths(None, process_path.as_deref(), &extras)
    }
    #[cfg(not(any(unix, windows)))]
    {
        process_path.unwrap_or_default()
    }
}

#[cfg_attr(not(unix), allow(dead_code))]
const PATH_MARK: &str = "__KILN_PATH__";

/// The shells to ask for the login PATH, in order: `$SHELL` (interactive, so rc files that set
/// PATH run), then zsh, bash and sh as login shells, skipping any that don't exist (Linux
/// often has no zsh). On macOS that is `$SHELL -lic` then `/bin/zsh -lc`, as before.
#[cfg_attr(not(unix), allow(dead_code))]
pub fn shell_attempts(shell_env: Option<&str>, exists: impl Fn(&str) -> bool) -> Vec<(String, &'static str)> {
    let mut attempts: Vec<(String, &'static str)> = Vec::new();
    if let Some(sh) = shell_env.map(str::trim).filter(|s| !s.is_empty()) {
        attempts.push((sh.to_string(), "-lic"));
    }
    for sh in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
        if exists(sh) {
            attempts.push((sh.to_string(), "-lc"));
        }
    }
    attempts
}

/// Asks the user's login shell for its PATH. Markers make this robust to rc
/// files that print banners.
#[cfg(unix)]
fn login_shell_path(process_path: Option<&OsStr>) -> Option<String> {
    let script = format!("printf '{PATH_MARK}%s{PATH_MARK}' \"$PATH\"");
    let shell = std::env::var("SHELL").ok();
    let attempts = shell_attempts(shell.as_deref(), |p| Path::new(p).exists());
    for (shell, flags) in attempts {
        let mut cmd = std::process::Command::new(&shell);
        cmd.arg(flags).arg(&script);
        if let Some(p) = process_path {
            cmd.env("PATH", p);
        }
        match capture(cmd, PROBE_TIMEOUT) {
            Ok(c) => match extract_marked(&c.stdout) {
                Some(p) if !p.is_empty() => return Some(p),
                _ => eprintln!("[kiln] `{shell} {flags}` did not report a PATH"),
            },
            Err(e) => eprintln!("[kiln] cannot run `{shell}`: {e}"),
        }
    }
    None
}

#[cfg_attr(not(unix), allow(dead_code))]
pub fn extract_marked(out: &str) -> Option<String> {
    let start = out.find(PATH_MARK)? + PATH_MARK.len();
    let len = out[start..].find(PATH_MARK)?;
    Some(out[start..start + len].trim().to_string())
}

/// Common unix install locations, in priority order (filtered to existing dirs by the caller).
#[cfg_attr(not(unix), allow(dead_code))]
pub fn extra_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(h) = home {
        v.push(h.join(".local").join("bin"));
    }
    v.push(PathBuf::from("/opt/homebrew/bin"));
    v.push(PathBuf::from("/usr/local/bin"));
    if let Some(h) = home {
        for d in [".npm-global", ".bun", ".volta", ".cargo"] {
            v.push(h.join(d).join("bin"));
        }
        if let Some(nvm) = nvm_bin(h) {
            v.push(nvm);
        }
    }
    if cfg!(target_os = "linux") {
        v.push(PathBuf::from("/home/linuxbrew/.linuxbrew/bin"));
        v.push(PathBuf::from("/snap/bin"));
    }
    v
}

/// The Windows folders the install locations below are relative to (from the environment).
#[derive(Default)]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct WinDirs {
    /// %USERPROFILE%
    pub home: Option<PathBuf>,
    /// %APPDATA% (Roaming)
    pub appdata: Option<PathBuf>,
    /// %LOCALAPPDATA%
    pub local: Option<PathBuf>,
    /// %SCOOP%, when scoop is installed somewhere other than ~/scoop
    pub scoop: Option<PathBuf>,
    /// %ProgramFiles%
    pub program_files: Option<PathBuf>,
    /// %NVM_SYMLINK%, nvm-windows' active node folder (npm globals go there)
    pub nvm_symlink: Option<PathBuf>,
}

#[cfg_attr(not(windows), allow(dead_code))]
impl WinDirs {
    pub fn from_env() -> WinDirs {
        let var = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
        WinDirs {
            home: var("USERPROFILE"),
            appdata: var("APPDATA"),
            local: var("LOCALAPPDATA"),
            scoop: var("SCOOP"),
            program_files: var("ProgramFiles"),
            nvm_symlink: var("NVM_SYMLINK"),
        }
    }
}

/// Where agent CLIs install on Windows, in priority order (filtered to existing dirs by the caller).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn windows_extra_dirs(d: &WinDirs) -> Vec<PathBuf> {
    let mut v = Vec::new();
    // npm globals: claude.cmd, codex.cmd, gemini.cmd, opencode.cmd
    if let Some(a) = &d.appdata {
        v.push(a.join("npm"));
    }
    if let Some(h) = &d.home {
        // the native installers (Claude Code, Cursor Agent) put their launcher here
        v.push(h.join(".local").join("bin"));
    }
    if let Some(l) = &d.local {
        v.push(l.join("cursor-agent"));
        v.push(l.join("Programs"));
        v.push(l.join("pnpm"));
        v.push(l.join("Volta").join("bin"));
    }
    if let Some(h) = &d.home {
        v.push(h.join(".bun").join("bin"));
        v.push(h.join(".cargo").join("bin"));
    }
    match (&d.scoop, &d.home) {
        (Some(s), _) => v.push(s.join("shims")),
        (None, Some(h)) => v.push(h.join("scoop").join("shims")),
        _ => {}
    }
    if let Some(n) = &d.nvm_symlink {
        v.push(n.clone());
    }
    if let Some(p) = &d.program_files {
        v.push(p.join("nodejs"));
    }
    v
}

/// The bin dir of nvm's current/default node, if nvm is installed.
#[cfg_attr(not(unix), allow(dead_code))]
fn nvm_bin(home: &Path) -> Option<PathBuf> {
    let nvm = std::env::var_os("NVM_DIR").map(PathBuf::from).unwrap_or_else(|| home.join(".nvm"));
    let current = nvm.join("current/bin");
    if current.is_dir() {
        return Some(current);
    }
    // `alias/default` holds e.g. "22", "v20.11.1", "node" or "lts/*".
    let alias = fs::read_to_string(nvm.join("alias/default"))
        .ok()
        .map(|s| s.trim().trim_start_matches('v').to_string())
        .filter(|a| a.starts_with(|c: char| c.is_ascii_digit()));
    let mut best: Option<(Vec<u64>, PathBuf)> = None;
    for entry in fs::read_dir(nvm.join("versions/node")).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let ver = name.trim_start_matches('v');
        if let Some(a) = &alias {
            if ver != a && !ver.starts_with(&format!("{a}.")) {
                continue;
            }
        }
        let key: Vec<u64> = ver.split('.').map(|p| p.parse().unwrap_or(0)).collect();
        let bin = entry.path().join("bin");
        // map_or, not is_none_or: that needs Rust 1.82 and the crate's rust-version is 1.77
        if bin.is_dir() && best.as_ref().map_or(true, |(k, _)| key > *k) {
            best = Some((key, bin));
        }
    }
    best.map(|(_, b)| b)
}

/// Login-shell PATH first, then the process PATH, then extra dirs; deduped (ignoring case
/// and a trailing separator on Windows, where `C:\Tools\` and `c:\tools` are the same folder).
pub fn merge_paths(login: Option<&OsStr>, process: Option<&OsStr>, extras: &[PathBuf]) -> OsString {
    let mut seen = HashSet::new();
    let mut out: Vec<PathBuf> = Vec::new();
    let key = |p: &Path| -> String {
        // same comparison as PathBuf equality (component by component), lowercased on Windows
        let s = p.components().collect::<PathBuf>().to_string_lossy().into_owned();
        if cfg!(windows) {
            s.to_lowercase()
        } else {
            s
        }
    };
    let sources = [login, process].into_iter().flatten().flat_map(std::env::split_paths);
    for p in sources.chain(extras.iter().cloned()) {
        if !p.as_os_str().is_empty() && seen.insert(key(&p)) {
            out.push(p);
        }
    }
    std::env::join_paths(out).unwrap_or_else(|_| process.map(OsStr::to_os_string).unwrap_or_default())
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct CliInfo {
    pub id: String,
    pub name: String,
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
}

/// Extensions CreateProcess can start: real programs and batch files (which std runs
/// through cmd.exe). PATHEXT may also list .JS, .VBS, .PS1…, which it can't.
const RUNNABLE_EXTS: [&str; 4] = [".com", ".exe", ".bat", ".cmd"];

/// File names to look for: on Windows `bin` plus each runnable PATHEXT extension, in PATHEXT
/// order. Never the bare name there: npm also installs an extensionless `sh` script for Git
/// Bash next to `claude.cmd`, and Windows can't run it.
pub fn candidate_names_for(bin: &str, windows: bool, pathext: Option<&str>) -> Vec<String> {
    if !windows {
        return vec![bin.to_string()];
    }
    let mut exts: Vec<String> = Vec::new();
    let listed = pathext.filter(|p| !p.trim().is_empty()).unwrap_or(".COM;.EXE;.BAT;.CMD");
    for e in listed.split(';').map(|e| e.trim().to_ascii_lowercase()) {
        if RUNNABLE_EXTS.contains(&e.as_str()) && !exts.contains(&e) {
            exts.push(e);
        }
    }
    // PATHEXT set to something odd: still find the usual shims
    for e in RUNNABLE_EXTS {
        if !exts.iter().any(|x| x == e) {
            exts.push(e.to_string());
        }
    }
    exts.iter().map(|e| format!("{bin}{e}")).collect()
}

fn candidate_names(bin: &str) -> Vec<String> {
    let pathext = std::env::var("PATHEXT").ok();
    candidate_names_for(bin, cfg!(windows), pathext.as_deref())
}

/// A `.cmd` / `.bat` file, which Windows runs through cmd.exe.
pub fn is_batch(program: &Path) -> bool {
    program
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
}

fn is_executable(p: &Path) -> bool {
    let Ok(meta) = fs::metadata(p) else { return false };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

pub fn find_executable(bin: &str, path: &OsStr) -> Option<PathBuf> {
    let names = candidate_names(bin);
    std::env::split_paths(path)
        .filter(|d| !d.as_os_str().is_empty())
        .flat_map(|d| names.iter().map(move |n| d.join(n)))
        .find(|p| is_executable(p))
}

fn clip(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

fn first_line(s: &str) -> Option<&str> {
    s.lines().map(str::trim).find(|l| !l.is_empty())
}

/// `Error: ...`, `TypeError: ...`, `error: ...`
fn is_error_label(line: &str) -> bool {
    line.split_once(':').is_some_and(|(label, _)| {
        !label.contains(char::is_whitespace) && label.to_ascii_lowercase().ends_with("error")
    })
}

/// The most useful line of a failed command's output. Node prints a source
/// location and code excerpt before the actual `Error: ...` line, so prefer
/// lines labelled as errors, then lines mentioning one, then the first line.
pub fn error_line(stderr: &str, stdout: &str) -> Option<String> {
    let lines = || stderr.lines().chain(stdout.lines()).map(str::trim).filter(|l| !l.is_empty());
    lines()
        .find(|l| is_error_label(l))
        .or_else(|| lines().find(|l| l.to_ascii_lowercase().contains("error")))
        .or_else(|| lines().next())
        .map(|l| clip(l, 300))
}

pub fn probe(cli: &KnownCli, path: &OsStr) -> CliInfo {
    let mut info = CliInfo {
        id: cli.id.into(),
        name: cli.name.into(),
        installed: false,
        path: None,
        version: None,
        error: None,
    };
    let Some(bin) = find_executable(cli.bin, path) else { return info };
    info.installed = true;
    info.path = Some(bin.to_string_lossy().into_owned());

    let mut cmd = std::process::Command::new(&bin);
    cmd.arg("--version").env("PATH", path);
    match capture(cmd, PROBE_TIMEOUT) {
        Err(e) => info.error = Some(format!("cannot run {}: {e}", bin.display())),
        Ok(c) if c.status.is_none() => {
            info.error = Some(format!("`{} --version` timed out after {}s", cli.bin, PROBE_TIMEOUT.as_secs()))
        }
        Ok(c) if c.success() => {
            info.version = first_line(&c.stdout).or_else(|| first_line(&c.stderr)).map(|l| clip(l, 120));
        }
        Ok(c) => {
            info.error = error_line(&c.stderr, &c.stdout)
                .or_else(|| c.status.map(|s| format!("`{} --version` failed ({s})", cli.bin)));
        }
    }
    info
}

pub fn detect_all(path: &OsStr) -> Vec<CliInfo> {
    std::thread::scope(|s| {
        let handles: Vec<_> = KNOWN_CLIS.iter().map(|c| s.spawn(move || probe(c, path))).collect();
        handles.into_iter().map(|h| h.join().expect("probe thread panicked")).collect()
    })
}

// ---------------------------------------------------------------------------
// Private agent workspace
// ---------------------------------------------------------------------------

fn pretty(v: Value) -> String {
    let mut s = serde_json::to_string_pretty(&v).expect("json");
    s.push('\n');
    s
}

/// (relative path, contents) of every file in the agent workspace.
pub fn workspace_files(url: &str) -> Vec<(&'static str, String)> {
    vec![
        (".mcp.json", pretty(json!({ "mcpServers": { "kiln": { "type": "http", "url": url } } }))),
        (".cursor/mcp.json", pretty(json!({ "mcpServers": { "kiln": { "url": url } } }))),
        (".gemini/settings.json", pretty(json!({ "mcpServers": { "kiln": { "httpUrl": url, "trust": true } } }))),
        (
            "opencode.json",
            pretty(json!({
                "$schema": "https://opencode.ai/config.json",
                "mcp": { "kiln": { "type": "remote", "url": url, "enabled": true } }
            })),
        ),
        ("AGENTS.md", WORKSPACE_NOTE.to_string()),
        ("CLAUDE.md", WORKSPACE_NOTE.to_string()),
        // Gemini CLI reads GEMINI.md, not AGENTS.md
        ("GEMINI.md", WORKSPACE_NOTE.to_string()),
    ]
}

/// (Re)writes the workspace config files; the MCP port can change between launches.
pub fn write_workspace(dir: &Path, url: &str) -> Result<(), String> {
    for (rel, contents) in workspace_files(url) {
        // `rel` uses `/`; join part by part so Windows paths get `\`
        let target = rel.split('/').fold(dir.to_path_buf(), |p, part| p.join(part));
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
        }
        atomic_write(&target, contents.as_bytes())?;
    }
    Ok(())
}

pub fn workspace_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot locate the app data folder: {e}"))?;
    Ok(data.join("agent-workspace"))
}

// ---------------------------------------------------------------------------
// argv construction
// ---------------------------------------------------------------------------

pub struct RunOptions<'a> {
    pub prompt: &'a str,
    pub model: Option<&'a str>,
    /// Reasoning / effort level. Checked against each CLI's own list before use.
    pub effort: Option<&'a str>,
    pub resume: Option<&'a str>,
    pub workspace: &'a Path,
    pub url: &'a str,
    /// Whether the installed Gemini CLI accepts `--output-format`.
    pub gemini_output_format: bool,
    /// Staged image files (absolute paths) attached to this run.
    pub images: &'a [PathBuf],
    /// How the prompt reaches the CLI (see [`prompt_via`]).
    pub via: PromptVia,
    /// Where the prompt was written, when `via` is [`PromptVia::File`].
    pub prompt_file: Option<&'a Path>,
}

/// How the prompt reaches the CLI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptVia {
    /// As one argv element.
    Arg,
    /// On stdin, for CLIs that read their prompt from it when none is given as an argument.
    Stdin,
    /// Written to a file in the workspace; the argv prompt asks the agent to read it.
    File,
}

/// How the operating system starts the CLI, which decides what a prompt argument may hold.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Launch {
    /// macOS and Linux: an argv array, no quoting at all.
    Unix,
    /// A Windows `.exe`: one command line of at most 32767 UTF-16 units.
    WindowsExe,
    /// A Windows `.cmd` / `.bat` (every npm-installed CLI), run through cmd.exe.
    WindowsBatch,
}

impl Launch {
    pub fn of(program: &Path) -> Launch {
        if !cfg!(windows) {
            Launch::Unix
        } else if is_batch(program) {
            Launch::WindowsBatch
        } else {
            Launch::WindowsExe
        }
    }
}

/// Room for a batch-file prompt: cmd.exe stops at 8191 characters, and the program path,
/// the flags and the shim's own expansion need the rest.
const BATCH_PROMPT_MAX: usize = 6000;
/// Room for a prompt to a Windows `.exe`, out of CreateProcess's 32767 UTF-16 units.
const EXE_PROMPT_MAX: usize = 30000;

/// The length of `s` once std has escaped it as a batch-file argument: each `%` becomes
/// `%%cd:~,%` and each `"` is doubled; the rest counts in UTF-16 units, as Windows does.
pub fn batch_arg_len(s: &str) -> usize {
    s.chars()
        .map(|c| match c {
            '%' => 8,
            '"' => 2,
            c => c.len_utf16(),
        })
        .sum()
}

/// On macOS and Linux the prompt is always one plain argument. On Windows a command line is a
/// single string with a length limit, and for a batch file std refuses any argument with CR or
/// LF (they would end the command) while escaping quotes and `%` safely. So on Windows the
/// CLIs that read their prompt from stdin always get it there, and the others get it in a file
/// when it can't go as an argument. Never through a shell string.
pub fn prompt_via(cli: &str, launch: Launch, prompt: &str) -> PromptVia {
    let fits = match launch {
        Launch::Unix => return PromptVia::Arg,
        Launch::WindowsBatch => !prompt.contains(['\r', '\n']) && batch_arg_len(prompt) <= BATCH_PROMPT_MAX,
        Launch::WindowsExe => prompt.encode_utf16().count() <= EXE_PROMPT_MAX,
    };
    match cli {
        "claude" | "codex" | "gemini" => PromptVia::Stdin,
        _ if fits => PromptVia::Arg,
        _ => PromptVia::File,
    }
}

/// The whole prompt as the CLI should receive it: Codex takes images as flags, the others
/// read the files listed at the end of the prompt.
pub fn full_prompt(cli: &str, prompt: &str, images: &[PathBuf]) -> String {
    if cli == "codex" {
        prompt.to_string()
    } else {
        prompt_with_images(prompt, images)
    }
}

/// The short argument that stands in for a prompt written to `file`.
fn prompt_file_pointer(file: &Path) -> String {
    format!(
        "Your full message from the user is in the file {}. Read all of it now and act on it exactly as if it had been typed here.",
        file.display()
    )
}

/// The prompt file for one run, inside the workspace (the CLI's working folder, so reading it
/// needs no extra permission). Removed with its [`RunDir`] when the run ends.
pub fn prompt_dir(workspace: &Path, run_id: &str) -> PathBuf {
    run_image_dir(&workspace.join(".kiln-prompts"), run_id)
}

// ---------------------------------------------------------------------------
// Attached images
// ---------------------------------------------------------------------------

pub const MAX_IMAGES: usize = 8;
pub const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;

/// An image attached to a prompt. `data` is base64 without a `data:` prefix.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CliImage {
    pub name: String,
    pub media_type: String,
    pub data: String,
}

/// File extension for an accepted media type, or None for anything else.
fn image_extension(media_type: &str) -> Option<&'static str> {
    match media_type.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

/// Standard base64 (whitespace and padding allowed) to bytes.
pub fn decode_base64(s: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let (mut acc, mut bits, mut count, mut pad) = (0u32, 0u32, 0usize, 0usize);
    for c in s.bytes().filter(|c| !c.is_ascii_whitespace()) {
        if c == b'=' {
            pad += 1;
            continue;
        }
        if pad > 0 {
            return Err("invalid base64: data after padding".into());
        }
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return Err("invalid base64 character".into()),
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        count += 1;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    if count % 4 == 1 || pad > 2 {
        return Err("invalid base64 length".into());
    }
    Ok(out)
}

/// The file name's stem, reduced to letters, digits, `-` and `_`. Never a path.
fn image_stem(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let stem = base.rsplit_once('.').map_or(base, |(stem, _)| stem);
    let safe: String = stem
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let trimmed: String = safe.trim_matches('-').chars().take(40).collect();
    if trimmed.is_empty() {
        "image".into()
    } else {
        trimmed
    }
}

/// Checks the attachments, then writes them into `dir` as `1-name.png`, `2-name.jpg`, ...
/// Nothing is written unless every image passes the checks.
pub fn stage_images(dir: &Path, images: &[CliImage]) -> Result<Vec<PathBuf>, String> {
    if images.len() > MAX_IMAGES {
        return Err(format!("at most {MAX_IMAGES} images can be attached"));
    }
    let mut files = Vec::with_capacity(images.len());
    for (i, img) in images.iter().enumerate() {
        let ext = image_extension(&img.media_type)
            .ok_or_else(|| format!("unsupported image type {:?} (use PNG, JPEG, WebP or GIF)", img.media_type))?;
        // base64 is 4/3 the size of the bytes: refuse oversized data before decoding it
        if img.data.len() > MAX_IMAGE_BYTES / 3 * 4 + 4 {
            return Err(format!("image {:?} is larger than 10 MB", img.name));
        }
        let bytes = decode_base64(&img.data).map_err(|e| format!("image {:?}: {e}", img.name))?;
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err(format!("image {:?} is larger than 10 MB", img.name));
        }
        files.push((format!("{}-{}.{ext}", i + 1, image_stem(&img.name)), bytes));
    }
    fs::create_dir_all(dir).map_err(|e| format!("cannot create the image folder: {e}"))?;
    let mut paths = Vec::with_capacity(files.len());
    for (file, bytes) in files {
        let path = dir.join(file);
        fs::write(&path, bytes).map_err(|e| format!("cannot write the image: {e}"))?;
        paths.push(path);
    }
    Ok(paths)
}

/// Folder for one run's images, under the app cache folder. The nanosecond suffix keeps reruns apart.
fn run_image_dir(root: &Path, run_id: &str) -> PathBuf {
    let safe: String = run_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(64).collect();
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    root.join(format!("{safe}-{nanos}"))
}

/// Removes its folder when dropped. Held for the lifetime of a run, so the folder goes when the run exits or is cancelled.
pub struct RunDir(pub PathBuf);

impl Drop for RunDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// The prompt, with the attached files listed at the end. For CLIs that read files named in the prompt text.
fn prompt_with_images(prompt: &str, images: &[PathBuf]) -> String {
    if images.is_empty() {
        return prompt.to_string();
    }
    let list: Vec<String> = images.iter().map(|p| format!("- {}", p.display())).collect();
    format!("{prompt}\n\nAttached images (read these files to see them):\n{}", list.join("\n"))
}

/// Effort levels each CLI accepts. Anything else is refused rather than passed through.
fn effort_levels(cli: &str) -> &'static [&'static str] {
    match cli {
        "claude" => &["low", "medium", "high", "xhigh", "max"],
        "codex" => &["minimal", "low", "medium", "high"],
        _ => &[],
    }
}

fn clean_effort(cli: &str, v: Option<&str>) -> Result<Option<String>, String> {
    let Some(v) = v.map(str::trim).filter(|v| !v.is_empty()) else { return Ok(None) };
    if effort_levels(cli).contains(&v) {
        Ok(Some(v.to_string()))
    } else {
        Err(format!("{cli} has no effort level {v:?}"))
    }
}

/// Model names and session ids: trimmed, non-empty, no leading `-`, no control chars.
fn clean_value(what: &str, v: Option<&str>) -> Result<Option<String>, String> {
    let Some(v) = v.map(str::trim).filter(|v| !v.is_empty()) else { return Ok(None) };
    if v.starts_with('-') || v.chars().any(char::is_control) || v.len() > 200 {
        return Err(format!("invalid {what} {v:?}"));
    }
    Ok(Some(v.to_string()))
}

/// Builds the argv (excluding the program) for one agent run. The prompt is
/// always exactly one element, and is placed after `--` (or bound with `=`)
/// so a prompt starting with `-` can never be parsed as a flag.
pub fn build_args(cli: &str, o: &RunOptions) -> Result<Vec<OsString>, String> {
    if o.prompt.trim().is_empty() {
        return Err("prompt is empty".into());
    }
    if o.prompt.contains('\0') {
        return Err("prompt contains a NUL byte".into());
    }
    let model = clean_value("model", o.model)?;
    let effort = clean_effort(cli, o.effort)?;
    let resume = clean_value("session id", o.resume)?;
    // The prompt argument: the prompt itself, a pointer to the file holding it, or nothing
    // when it goes on stdin. CLIs without an image flag read the files named at its end.
    let prompt: Option<String> = match o.via {
        PromptVia::Arg => Some(full_prompt(cli, o.prompt, o.images)),
        PromptVia::Stdin if matches!(cli, "claude" | "codex" | "gemini") => None,
        PromptVia::Stdin => return Err(format!("{cli} can't read its prompt from stdin")),
        PromptVia::File => Some(prompt_file_pointer(o.prompt_file.ok_or("the prompt file is missing")?)),
    };
    let mut a: Vec<OsString> = Vec::new();
    let mut push = |s: &str| a.push(s.into());
    match cli {
        "claude" => {
            for s in ["-p", "--output-format", "stream-json", "--verbose", "--mcp-config"] {
                push(s);
            }
            a.push(o.workspace.join(".mcp.json").into_os_string());
            // Skill + Read let it load the design skills installed on this computer (-p mode denies unapproved tools)
            for s in ["--strict-mcp-config", "--allowedTools", "mcp__kiln", "Skill", "Read"] {
                a.push(s.into());
            }
            if let Some(m) = &model {
                a.push(format!("--model={m}").into());
            }
            if let Some(e) = &effort {
                a.push(format!("--effort={e}").into());
            }
            if let Some(r) = &resume {
                a.push(format!("--resume={r}").into());
            }
            // so Claude Code may read the attached files
            if let Some(dir) = o.images.first().and_then(|p| p.parent()) {
                a.push("--add-dir".into());
                a.push(dir.as_os_str().to_os_string());
            }
            // `--allowedTools`, `--mcp-config` and `--add-dir` are variadic: `--` stops them eating the prompt.
            // With no prompt argument, `claude -p` reads it from stdin.
            if let Some(p) = prompt {
                a.push("--".into());
                a.push(p.into());
            }
        }
        "codex" => {
            for s in ["exec", "--json", "--skip-git-repo-check", "-c"] {
                push(s);
            }
            // TOML value: the URL is a quoted string.
            a.push(format!("mcp_servers.kiln.url=\"{}\"", o.url).into());
            // `exec` never asks, so without this every Kiln tool call fails with
            // "MCP tool call requires approval, but approval policy is never".
            a.push("-c".into());
            a.push("mcp_servers.kiln.default_tools_approval_mode=\"approve\"".into());
            if let Some(e) = &effort {
                a.push("-c".into());
                a.push(format!("model_reasoning_effort=\"{e}\"").into());
            }
            if let Some(m) = &model {
                a.push(format!("--model={m}").into());
            }
            for img in o.images {
                a.push("--image".into());
                a.push(img.as_os_str().to_os_string());
            }
            a.push("--".into());
            // `-` tells `codex exec` to read the prompt from stdin
            a.push(prompt.unwrap_or_else(|| "-".into()).into());
        }
        "gemini" => {
            // With no --prompt and stdin not a terminal, Gemini CLI reads the prompt from stdin.
            if let Some(p) = prompt {
                a.push(format!("--prompt={p}").into());
            }
            a.push("--yolo".into());
            if o.gemini_output_format {
                a.push("--output-format".into());
                a.push("stream-json".into());
            }
            if let Some(m) = &model {
                a.push(format!("--model={m}").into());
            }
        }
        "cursor-agent" => {
            for s in ["-p", "--output-format", "stream-json", "--approve-mcps", "--force", "--trust"] {
                push(s);
            }
            if let Some(m) = &model {
                a.push(format!("--model={m}").into());
            }
            if let Some(r) = &resume {
                a.push(format!("--resume={r}").into());
            }
            a.push("--".into());
            a.push(prompt.unwrap_or_default().into());
        }
        "opencode" => {
            push("run");
            if let Some(m) = &model {
                a.push(format!("--model={m}").into());
            }
            // yargs positional: a leading space keeps a `-`-prefixed prompt from parsing as a flag.
            let prompt = prompt.unwrap_or_default();
            let prompt = if prompt.starts_with('-') { format!(" {prompt}") } else { prompt };
            a.push(prompt.into());
        }
        other => return Err(format!("unknown agent CLI {other:?}")),
    }
    Ok(a)
}

fn gemini_supports_output_format(bin: &Path, path: &OsStr) -> bool {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, bool>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(v) = cache.lock().unwrap().get(bin) {
        return *v;
    }
    let mut cmd = std::process::Command::new(bin);
    cmd.arg("--help").env("PATH", path);
    match capture(cmd, PROBE_TIMEOUT) {
        Ok(c) if c.status.is_some() => {
            let ok = c.stdout.contains("--output-format") || c.stderr.contains("--output-format");
            cache.lock().unwrap().insert(bin.to_path_buf(), ok);
            ok
        }
        // Unknown: assume a current version (which supports it).
        _ => true,
    }
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

pub type EmitFn = Arc<dyn Fn(&str, Value) + Send + Sync>;

struct RunEntry {
    tree: Arc<Tree>,
    cancel: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
pub struct CliRuns {
    runs: Mutex<HashMap<String, RunEntry>>,
}

pub type SharedRuns = Arc<CliRuns>;

impl CliRuns {
    /// Asks a run to stop. Returns false if no such run is active.
    pub fn cancel(&self, run_id: &str) -> bool {
        match self.runs.lock().unwrap().get_mut(run_id) {
            Some(entry) => {
                if let Some(tx) = entry.cancel.take() {
                    let _ = tx.send(());
                }
                true
            }
            None => false,
        }
    }

    /// Kills every run's process tree right away (used when Kiln quits, since
    /// children live in their own process groups and would otherwise survive).
    pub fn kill_all(&self) {
        for entry in self.runs.lock().unwrap().values() {
            entry.tree.kill();
        }
    }

    pub fn is_running(&self, run_id: &str) -> bool {
        self.runs.lock().unwrap().contains_key(run_id)
    }
}

enum End {
    Exited(std::io::Result<ExitStatus>),
    Cancelled,
    TimedOut,
}

async fn pump<R: AsyncRead + Unpin>(pipe: Option<R>, stream: &'static str, run_id: String, emit: EmitFn) {
    let Some(pipe) = pipe else { return };
    let mut reader = BufReader::new(pipe);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                while matches!(buf.last(), Some(b'\n' | b'\r')) {
                    buf.pop();
                }
                let line = String::from_utf8_lossy(&buf);
                emit(EVENT_OUTPUT, json!({ "runId": run_id, "stream": stream, "line": line }));
            }
        }
    }
}

async fn terminate(child: &mut tokio::process::Child, tree: &Tree) -> std::io::Result<ExitStatus> {
    tree.stop();
    match tokio::time::timeout(KILL_GRACE, child.wait()).await {
        Ok(r) => r,
        Err(_) => {
            tree.kill();
            let _ = child.start_kill();
            child.wait().await
        }
    }
}

fn describe_timeout(t: Duration) -> String {
    if t.as_secs() >= 60 {
        format!("timed out after {} minutes", t.as_secs() / 60)
    } else {
        format!("timed out after {} ms", t.as_millis())
    }
}

fn exit_payload(run_id: &str, end: &End, status: &std::io::Result<ExitStatus>, timeout: Duration) -> Value {
    let code = status.as_ref().ok().and_then(ExitStatus::code);
    let error = match (end, status) {
        (End::Cancelled, _) => Some("cancelled".to_string()),
        (End::TimedOut, _) => Some(describe_timeout(timeout)),
        (_, Err(e)) => Some(e.to_string()),
        (_, Ok(s)) if s.code().is_none() => {
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                Some(match s.signal() {
                    Some(sig) => format!("terminated by signal {sig}"),
                    None => "terminated".to_string(),
                })
            }
            #[cfg(not(unix))]
            {
                Some("terminated".to_string())
            }
        }
        _ => None,
    };
    json!({ "runId": run_id, "code": code, "error": error })
}

/// Spawns `program args` and streams its output as events until it exits,
/// is cancelled, or hits `timeout`. Emits exactly one exit event.
#[allow(clippy::too_many_arguments)]
pub fn spawn_run(
    runs: SharedRuns,
    run_id: String,
    program: &Path,
    args: &[OsString],
    cwd: &Path,
    envs: &[(&str, OsString)],
    timeout: Duration,
    emit: EmitFn,
    // the run's image and prompt folders, removed once the run has ended
    dirs: Vec<RunDir>,
    // written to the child's stdin, which is then closed (the prompt, for some CLIs on Windows)
    stdin: Option<String>,
) -> Result<(), String> {
    if run_id.is_empty() || run_id.len() > 128 {
        return Err("invalid run id".into());
    }
    let mut map = runs.runs.lock().unwrap();
    if map.contains_key(&run_id) {
        return Err(format!("run {run_id:?} is already running"));
    }
    let mut cmd = std::process::Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // A nested Claude Code refuses to start if Kiln itself was launched from one.
        .env_remove("CLAUDECODE");
    for (k, v) in envs {
        cmd.env(k, v);
    }
    isolate(&mut cmd);
    let mut cmd = tokio::process::Command::from(cmd);
    cmd.kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("cannot start {}: {e}", program.display()))?;
    let tree = Arc::new(Tree::of_tokio(&child));
    let (tx, mut cancel_rx) = oneshot::channel();
    map.insert(run_id.clone(), RunEntry { tree: tree.clone(), cancel: Some(tx) });
    drop(map);

    if let (Some(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            // a CLI that exits early closes the pipe; its exit is reported as usual
            let _ = pipe.write_all(text.as_bytes()).await;
            let _ = pipe.shutdown().await;
        });
    }

    let readers = [
        tokio::spawn(pump(child.stdout.take(), "stdout", run_id.clone(), emit.clone())),
        tokio::spawn(pump(child.stderr.take(), "stderr", run_id.clone(), emit.clone())),
    ];

    tokio::spawn(async move {
        // dropped at the end of this task, after the exit event
        let _dirs = dirs;
        let end = tokio::select! {
            r = child.wait() => End::Exited(r),
            Ok(()) = &mut cancel_rx => End::Cancelled,
            _ = tokio::time::sleep(timeout) => End::TimedOut,
        };
        let status = match end {
            End::Exited(ref r) => r.as_ref().map(|s| *s).map_err(|e| std::io::Error::new(e.kind(), e.to_string())),
            End::Cancelled | End::TimedOut => terminate(&mut child, &tree).await,
        };
        // Reap stragglers (e.g. node subprocesses) still in the run's process group / job.
        tree.reap();
        for mut h in readers {
            if tokio::time::timeout(DRAIN_TIMEOUT, &mut h).await.is_err() {
                h.abort();
            }
        }
        runs.runs.lock().unwrap().remove(&run_id);
        emit(EVENT_EXIT, exit_payload(&run_id, &end, &status, timeout));
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Connect: register Kiln in the user's own CLI config
// ---------------------------------------------------------------------------

/// Merges `kiln` into `mcpServers` of a Cursor `mcp.json`, keeping other entries.
pub fn merge_cursor_config(existing: Option<&str>, url: &str) -> Result<String, String> {
    let mut root = match existing.map(str::trim).filter(|s| !s.is_empty()) {
        None => json!({}),
        Some(s) => serde_json::from_str::<Value>(s)
            .map_err(|e| format!("~/.cursor/mcp.json is not valid JSON ({e}); add Kiln manually"))?,
    };
    let obj = root.as_object_mut().ok_or("~/.cursor/mcp.json is not a JSON object; add Kiln manually")?;
    let servers = obj.entry("mcpServers").or_insert_with(|| json!({}));
    let servers = servers
        .as_object_mut()
        .ok_or("`mcpServers` in ~/.cursor/mcp.json is not an object; add Kiln manually")?;
    servers.insert("kiln".into(), json!({ "url": url }));
    Ok(pretty(root))
}

fn connect_cursor(file: PathBuf, url: &str) -> Result<String, String> {
    // Follow a symlinked config (e.g. dotfiles) instead of replacing the link.
    let target = fs::canonicalize(&file).unwrap_or(file);
    let existing = match fs::read_to_string(&target) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("cannot read {}: {e}", target.display())),
    };
    let merged = merge_cursor_config(existing.as_deref(), url)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    atomic_write(&target, merged.as_bytes())?;
    Ok(format!("Added `kiln` ({url}) to {}", target.display()))
}

/// (add, remove) argv for CLIs that manage their own MCP config.
pub fn connect_args(cli: &str, url: &str) -> Option<(Vec<String>, Vec<String>)> {
    let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    Some(match cli {
        "claude" => (
            v(&["mcp", "add", "--transport", "http", "--scope", "user", "kiln", url]),
            v(&["mcp", "remove", "--scope", "user", "kiln"]),
        ),
        "codex" => (v(&["mcp", "add", "kiln", "--url", url]), v(&["mcp", "remove", "kiln"])),
        "gemini" => (
            v(&["mcp", "add", "--scope", "user", "--transport", "http", "kiln", url]),
            v(&["mcp", "remove", "--scope", "user", "kiln"]),
        ),
        _ => return None,
    })
}

fn connect_via_cli(cli: &KnownCli, url: &str, home: Option<PathBuf>) -> Result<String, String> {
    let (add, remove) = connect_args(cli.id, url).ok_or("unsupported")?;
    let path = agent_path();
    let bin = find_executable(cli.bin, path).ok_or_else(|| format!("{} is not installed", cli.name))?;
    let run = |args: &[String]| -> Result<Captured, String> {
        let mut cmd = std::process::Command::new(&bin);
        cmd.args(args).env("PATH", path);
        if let Some(h) = &home {
            cmd.current_dir(h);
        }
        capture(cmd, CONNECT_TIMEOUT).map_err(|e| format!("cannot run {}: {e}", bin.display()))
    };
    let first = run(&add)?;
    if first.success() {
        return Ok(first.combined());
    }
    let out = first.combined();
    if first.status.is_some() && out.to_ascii_lowercase().contains("already exists") {
        // Replace the old entry so a changed port takes effect.
        let removed = run(&remove)?;
        let again = run(&add)?;
        if again.success() {
            return Ok(format!("Replaced the existing `kiln` entry.\n{}", again.combined()).trim().to_string());
        }
        if !removed.success() {
            // Could not replace it; the existing entry stays, which still counts as connected.
            return Ok(out);
        }
        return Err(again.combined());
    }
    if first.status.is_none() {
        return Err(format!("`{} {}` timed out", cli.bin, add.join(" ")));
    }
    Err(if out.is_empty() { format!("`{} mcp add` failed", cli.bin) } else { out })
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectSnippet {
    pub cli: String,
    pub title: String,
    pub command: String,
}

pub fn connect_snippets(url: &str) -> Vec<ConnectSnippet> {
    let s = |cli: &str, title: &str, command: String| ConnectSnippet { cli: cli.into(), title: title.into(), command };
    let j = |v: Value| serde_json::to_string_pretty(&v).expect("json");
    vec![
        s("claude", "Claude Code", format!("claude mcp add --transport http --scope user kiln {url}")),
        s("codex", "Codex", format!("codex mcp add kiln --url {url}")),
        s("gemini", "Gemini CLI", format!("gemini mcp add --scope user --transport http kiln {url}")),
        s("cursor", "Cursor (~/.cursor/mcp.json)", j(json!({ "mcpServers": { "kiln": { "url": url } } }))),
        s("vscode", "VS Code (.vscode/mcp.json)", j(json!({ "servers": { "kiln": { "type": "http", "url": url } } }))),
        s("zed", "Zed (settings.json)", j(json!({ "context_servers": { "kiln": { "url": url } } }))),
        s(
            "windsurf",
            "Windsurf (~/.codeium/windsurf/mcp_config.json)",
            j(json!({ "mcpServers": { "kiln": { "serverUrl": url } } })),
        ),
        s("opencode", "OpenCode (~/.config/opencode/opencode.json)", opencode_snippet(url)),
    ]
}

fn opencode_snippet(url: &str) -> String {
    serde_json::to_string_pretty(&json!({
        "$schema": "https://opencode.ai/config.json",
        "mcp": { "kiln": { "type": "remote", "url": url, "enabled": true } }
    }))
    .expect("json")
}

// ---------------------------------------------------------------------------
// Model lists: ask the installed CLI which models this account can use
// ---------------------------------------------------------------------------

const MODELS_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_CURSOR_MODELS: usize = 200;
const MAX_OPENCODE_MODELS: usize = 400;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliModel {
    pub id: String,
    pub label: String,
    /// The CLI marks it as the current / default model.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub current: bool,
}

/// Removes ANSI escape sequences (`ESC [ … letter`) and stray escapes.
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            for n in chars.by_ref() {
                if n.is_ascii_alphabetic() {
                    break;
                }
            }
        }
    }
    out
}

/// `[A-Za-z0-9_][A-Za-z0-9_.\-/\[\]]{1,59}`, the ids Cursor prints.
fn is_cursor_model_id(id: &str) -> bool {
    let ok = |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | '/' | '[' | ']');
    id.chars().next().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
        && (2..=60).contains(&id.chars().count())
        && id.chars().all(ok)
}

/// Parses `cursor-agent models` output: one `<id> - <label> [(current, default)]` per line.
pub fn parse_cursor_models(out: &str) -> Vec<CliModel> {
    let mut rows: Vec<CliModel> = Vec::new();
    for raw in strip_ansi(out).lines() {
        let line = raw.trim();
        let Some(sp) = line.find(char::is_whitespace) else { continue };
        let (id, rest) = line.split_at(sp);
        let Some(rest) = rest.trim_start().strip_prefix('-') else { continue };
        if !rest.starts_with(char::is_whitespace) || !is_cursor_model_id(id) {
            continue;
        }
        let rest = rest.trim();
        if rest.is_empty() {
            continue;
        }
        // a trailing "(…)" holds flags such as "current, default"
        let (label, flags) = match rest.strip_suffix(')').and_then(|r| r.rfind('(').map(|i| (&r[..i], &r[i + 1..]))) {
            Some((l, f)) if !f.contains(')') => (l.trim(), f.to_ascii_lowercase()),
            _ => (rest, String::new()),
        };
        let current = flags
            .split(|c: char| !c.is_ascii_alphanumeric())
            .any(|w| w == "current" || w == "default");
        if rows.iter().any(|r| r.id == id) {
            continue;
        }
        rows.push(CliModel {
            id: id.to_string(),
            label: if label.is_empty() { id.to_string() } else { label.to_string() },
            current,
        });
        if rows.len() == MAX_CURSOR_MODELS {
            break;
        }
    }
    rows
}

/// Parses `opencode models` output: one `provider/model` id per line.
pub fn parse_opencode_models(out: &str) -> Vec<CliModel> {
    let mut rows: Vec<CliModel> = Vec::new();
    for raw in strip_ansi(out).lines() {
        let id = raw.trim();
        let plausible = id.contains('/')
            && !id.starts_with('/')
            && id.len() <= 200
            && !id.chars().any(|c| c.is_whitespace() || c.is_control());
        if !plausible || rows.iter().any(|r| r.id == id) {
            continue;
        }
        rows.push(CliModel { id: id.to_string(), label: id.to_string(), current: false });
        if rows.len() == MAX_OPENCODE_MODELS {
            break;
        }
    }
    rows
}

fn needs_login(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    ["authentication required", "not logged in", "not authenticated", "login required", "please log in"]
        .iter()
        .any(|p| t.contains(p))
}

/// The models `cli` offers this account. Claude Code, Codex and Gemini CLI have no listing
/// command (the app ships their lists), so they return an empty list, as does a CLI that
/// is not installed.
pub fn list_models(cli: &KnownCli, path: &OsStr) -> Result<Vec<CliModel>, String> {
    let attempts: &[&[&str]] = match cli.id {
        "cursor-agent" => &[&["models"], &["--list-models"]],
        "opencode" => &[&["models"]],
        _ => return Ok(Vec::new()),
    };
    let Some(bin) = find_executable(cli.bin, path) else { return Ok(Vec::new()) };
    let mut last_err: Option<String> = None;
    for args in attempts {
        let mut cmd = std::process::Command::new(&bin);
        cmd.args(*args).env("PATH", path);
        let c = match capture(cmd, MODELS_TIMEOUT) {
            Ok(c) => c,
            Err(e) => {
                last_err = Some(format!("cannot run {}: {e}", bin.display()));
                continue;
            }
        };
        if needs_login(&c.combined()) {
            return Err(format!("{} isn't signed in. Run `{} login` once in Terminal.", cli.name, cli.bin));
        }
        if c.status.is_none() {
            last_err = Some(format!("`{} {}` timed out after {}s", cli.bin, args.join(" "), MODELS_TIMEOUT.as_secs()));
            continue;
        }
        let models = match cli.id {
            "opencode" => parse_opencode_models(&c.stdout),
            _ => parse_cursor_models(&c.combined()),
        };
        if !models.is_empty() {
            return Ok(models);
        }
        if !c.success() {
            last_err = error_line(&c.stderr, &c.stdout).or(last_err);
        }
    }
    last_err.map_or(Ok(Vec::new()), Err)
}

static MODEL_CACHE: OnceLock<Mutex<HashMap<String, Vec<CliModel>>>> = OnceLock::new();

fn model_cache() -> &'static Mutex<HashMap<String, Vec<CliModel>>> {
    MODEL_CACHE.get_or_init(Default::default)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("background task failed: {e}"))?
}

fn live_url(hub: &SharedHub) -> Result<String, String> {
    let s = hub.status();
    if !s.running || s.port == 0 {
        return Err("Kiln's MCP server is not running, so agents cannot reach the canvas.".into());
    }
    Ok(mcp_url(s.port))
}

#[tauri::command]
pub async fn agent_cli_detect() -> Result<Vec<CliInfo>, String> {
    blocking(|| Ok(detect_all(agent_path()))).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_cli_run<R: Runtime>(
    app: AppHandle<R>,
    hub: State<'_, SharedHub>,
    runs: State<'_, SharedRuns>,
    run_id: String,
    cli: String,
    prompt: String,
    model: Option<String>,
    effort: Option<String>,
    resume: Option<String>,
    images: Option<Vec<CliImage>>,
) -> Result<(), String> {
    let known = known(&cli)?;
    if runs.is_running(&run_id) {
        return Err(format!("run {run_id:?} is already running"));
    }
    let url = live_url(&hub)?;
    let workspace = workspace_dir(&app)?;
    let images = images.unwrap_or_default();
    // the run's image folder; dropping this guard (on any error below, or when the run ends) removes it
    let image_dir = if images.is_empty() {
        None
    } else {
        let root = app
            .path()
            .app_cache_dir()
            .map_err(|e| format!("cannot locate the app cache folder: {e}"))?
            .join("agent-images");
        Some(RunDir(run_image_dir(&root, &run_id)))
    };
    let (ws, u) = (workspace.clone(), url.clone());
    let staged = image_dir.as_ref().map(|d| d.0.clone());
    let (program, gemini_output_format, image_paths) = blocking(move || {
        let path = agent_path();
        let bin = find_executable(known.bin, path).ok_or_else(|| format!("{} is not installed", known.name))?;
        let fmt = known.id == "gemini" && gemini_supports_output_format(&bin, path);
        write_workspace(&ws, &u)?;
        let paths = match staged {
            Some(dir) => stage_images(&dir, &images)?,
            None => Vec::new(),
        };
        Ok((bin, fmt, paths))
    })
    .await?;

    // On Windows a prompt may not fit, or be allowed, as an argument (see `prompt_via`).
    let text = full_prompt(&cli, &prompt, &image_paths);
    let via = prompt_via(&cli, Launch::of(&program), &text);
    let mut dirs: Vec<RunDir> = image_dir.into_iter().collect();
    let prompt_file = if via == PromptVia::File {
        let dir = RunDir(prompt_dir(&workspace, &run_id));
        let file = dir.0.join("prompt.md");
        fs::create_dir_all(&dir.0).map_err(|e| format!("cannot create the prompt folder: {e}"))?;
        fs::write(&file, text.as_bytes()).map_err(|e| format!("cannot write the prompt file: {e}"))?;
        dirs.push(dir);
        Some(file)
    } else {
        None
    };
    let args = build_args(
        &cli,
        &RunOptions {
            prompt: &prompt,
            model: model.as_deref(),
            effort: effort.as_deref(),
            resume: resume.as_deref(),
            workspace: &workspace,
            url: &url,
            gemini_output_format,
            images: &image_paths,
            via,
            prompt_file: prompt_file.as_deref(),
        },
    )?;
    let emit: EmitFn = Arc::new(move |event, payload| {
        let _ = app.emit(event, payload);
    });
    spawn_run(
        runs.inner().clone(),
        run_id,
        &program,
        &args,
        &workspace,
        &[("PATH", agent_path().clone()), ("KILN_MCP_URL", url.into())],
        RUN_TIMEOUT,
        emit,
        dirs,
        (via == PromptVia::Stdin).then_some(text),
    )
}

/// The models an installed CLI offers (asked once per app session unless `refresh`).
#[tauri::command]
pub async fn agent_cli_models(cli: String, refresh: Option<bool>) -> Result<Vec<CliModel>, String> {
    let known = known(&cli)?;
    if !refresh.unwrap_or(false) {
        if let Some(m) = model_cache().lock().ok().and_then(|c| c.get(known.id).cloned()) {
            return Ok(m);
        }
    }
    let models = blocking(move || list_models(known, agent_path())).await?;
    if !models.is_empty() {
        if let Ok(mut c) = model_cache().lock() {
            c.insert(known.id.to_string(), models.clone());
        }
    }
    Ok(models)
}

#[tauri::command]
pub async fn agent_cli_cancel(runs: State<'_, SharedRuns>, run_id: String) -> Result<bool, String> {
    Ok(runs.cancel(&run_id))
}

#[tauri::command]
pub async fn agent_cli_connect<R: Runtime>(
    app: AppHandle<R>,
    hub: State<'_, SharedHub>,
    cli: String,
) -> Result<String, String> {
    let known = known(&cli)?;
    let url = live_url(&hub)?;
    let home = app.path().home_dir().ok();
    match known.id {
        "cursor-agent" => {
            let home = home.ok_or("cannot locate your home folder")?;
            blocking(move || connect_cursor(home.join(".cursor").join("mcp.json"), &url)).await
        }
        "opencode" => Err(format!(
            "OpenCode has no command to add MCP servers. Add this to ~/.config/opencode/opencode.json:\n{}",
            opencode_snippet(&url)
        )),
        _ => blocking(move || connect_via_cli(known, &url, home)).await,
    }
}

#[tauri::command]
pub async fn agent_cli_connect_snippets(hub: State<'_, SharedHub>) -> Result<Vec<ConnectSnippet>, String> {
    Ok(connect_snippets(&live_url(&hub)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NASTY: &str = "Make it \"pop\" 'now'; $(rm -rf ~) `whoami` && echo $HOME | cat\nsecond line\n\t-- --help";

    fn opts<'a>(prompt: &'a str, ws: &'a Path) -> RunOptions<'a> {
        RunOptions {
            prompt,
            model: None,
            effort: None,
            resume: None,
            workspace: ws,
            url: "http://127.0.0.1:7458/mcp",
            gemini_output_format: true,
            images: &[],
            via: PromptVia::Arg,
            prompt_file: None,
        }
    }

    fn with_images<'a>(prompt: &'a str, ws: &'a Path, images: &'a [PathBuf]) -> RunOptions<'a> {
        RunOptions { images, ..opts(prompt, ws) }
    }

    fn img_paths() -> Vec<PathBuf> {
        vec![PathBuf::from("/tmp/kiln-run/1-shot.png"), PathBuf::from("/tmp/kiln-run/2-mock.jpg")]
    }

    fn b64(s: &str) -> String {
        // base64 of the given ASCII text, computed by hand so the test stays independent of decode_base64
        const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let bytes = s.as_bytes();
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
            let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            for i in 0..4 {
                if i <= chunk.len() {
                    out.push(T[((n >> (18 - 6 * i)) & 63) as usize] as char);
                } else {
                    out.push('=');
                }
            }
        }
        out
    }

    fn image(name: &str, media_type: &str, data: &str) -> CliImage {
        CliImage { name: name.into(), media_type: media_type.into(), data: data.into() }
    }

    #[test]
    fn effort_is_checked_per_cli() {
        let ws = Path::new("/tmp/ws");
        let mut o = opts("hi", ws);
        o.effort = Some("high");
        assert!(strs(build_args("claude", &o).unwrap()).contains(&"--effort=high".to_string()));
        let codex = strs(build_args("codex", &o).unwrap());
        assert!(codex.windows(2).any(|w| w[0] == "-c" && w[1] == "model_reasoning_effort=\"high\""));
        // a level another CLI does not know, or an injected value, is refused
        o.effort = Some("max");
        assert!(build_args("codex", &o).is_err());
        o.effort = Some("high\"; rm -rf ~");
        assert!(build_args("claude", &o).is_err());
        // Gemini has no effort flag, so any value is refused rather than dropped silently
        o.effort = Some("high");
        assert!(build_args("gemini", &o).is_err());
        o.effort = None;
        assert!(!strs(build_args("claude", &o).unwrap()).iter().any(|a| a.starts_with("--effort")));
    }

    fn strs(v: Vec<OsString>) -> Vec<String> {
        v.into_iter().map(|s| s.into_string().unwrap()).collect()
    }

    #[test]
    fn argv_per_cli() {
        let ws = Path::new("/tmp/ws");
        let mut o = opts(NASTY, ws);
        o.model = Some("sonnet");
        o.resume = Some("abc-123");
        // joined, not written out: Windows joins with "\"
        let mcp = ws.join(".mcp.json").to_string_lossy().into_owned();
        assert_eq!(
            strs(build_args("claude", &o).unwrap()),
            [
                "-p", "--output-format", "stream-json", "--verbose", "--mcp-config", mcp.as_str(),
                "--strict-mcp-config", "--allowedTools", "mcp__kiln", "Skill", "Read", "--model=sonnet", "--resume=abc-123", "--", NASTY,
            ]
        );
        assert_eq!(
            strs(build_args("codex", &o).unwrap()),
            [
                "exec", "--json", "--skip-git-repo-check", "-c",
                "mcp_servers.kiln.url=\"http://127.0.0.1:7458/mcp\"", "-c",
                "mcp_servers.kiln.default_tools_approval_mode=\"approve\"", "--model=sonnet", "--", NASTY,
            ]
        );
        assert_eq!(
            strs(build_args("gemini", &o).unwrap()),
            [&format!("--prompt={NASTY}"), "--yolo", "--output-format", "stream-json", "--model=sonnet"]
        );
        o.gemini_output_format = false;
        assert_eq!(strs(build_args("gemini", &o).unwrap()), [&format!("--prompt={NASTY}"), "--yolo", "--model=sonnet"]);
        assert_eq!(
            strs(build_args("cursor-agent", &o).unwrap()),
            [
                "-p", "--output-format", "stream-json", "--approve-mcps", "--force", "--trust", "--model=sonnet",
                "--resume=abc-123", "--", NASTY,
            ]
        );
        assert_eq!(strs(build_args("opencode", &o).unwrap()), ["run", "--model=sonnet", NASTY]);
    }

    #[test]
    fn prompt_is_one_argv_element() {
        let ws = Path::new("/tmp/ws");
        for prompt in [NASTY, "--dangerously-skip-permissions", "-h", "a\nb\r\nc", "$(touch /tmp/pwned)"] {
            for cli in KNOWN_CLIS.iter().map(|c| c.id) {
                let args = strs(build_args(cli, &opts(prompt, ws)).unwrap());
                let hits: Vec<_> = args.iter().filter(|a| a.contains(prompt)).collect();
                assert_eq!(hits.len(), 1, "{cli}: {args:?}");
                let hit = hits[0].as_str();
                match cli {
                    "gemini" => assert_eq!(hit, format!("--prompt={prompt}")),
                    "opencode" => {
                        assert_eq!(hit.trim_start(), prompt);
                        assert!(!hit.starts_with('-'));
                        assert_eq!(args.last().unwrap(), hit);
                    }
                    _ => {
                        assert_eq!(hit, prompt);
                        let n = args.len();
                        assert_eq!((args[n - 2].as_str(), args[n - 1].as_str()), ("--", prompt), "{cli}");
                    }
                }
            }
        }
    }

    #[test]
    fn codex_gets_one_image_flag_per_image_before_the_prompt() {
        let ws = Path::new("/tmp/ws");
        let paths = img_paths();
        let args = strs(build_args("codex", &with_images("look at these", ws, &paths)).unwrap());
        let n = args.len();
        assert_eq!(
            args[n - 6..],
            ["--image", "/tmp/kiln-run/1-shot.png", "--image", "/tmp/kiln-run/2-mock.jpg", "--", "look at these"]
        );
        // codex reads the files itself, so the prompt is left alone
        assert_eq!(args[n - 1], "look at these");
        assert_eq!(args.iter().filter(|a| *a == "--image").count(), 2);
    }

    #[test]
    fn other_clis_get_the_files_listed_in_the_prompt() {
        let ws = Path::new("/tmp/ws");
        let paths = img_paths();
        let suffix = "\n\nAttached images (read these files to see them):\n- /tmp/kiln-run/1-shot.png\n- /tmp/kiln-run/2-mock.jpg";
        let prompt = format!("Match this{suffix}");
        let o = with_images("Match this", ws, &paths);

        let claude = strs(build_args("claude", &o).unwrap());
        assert!(claude.contains(&prompt));
        assert!(claude.windows(2).any(|w| w[0] == "--add-dir" && w[1] == "/tmp/kiln-run"));
        // --add-dir comes before the `--` that ends the variadic flags
        let dash = claude.iter().position(|a| a == "--").unwrap();
        let add = claude.iter().position(|a| a == "--add-dir").unwrap();
        assert!(add < dash);
        assert_eq!(claude.last().unwrap(), &prompt);

        let gemini = strs(build_args("gemini", &o).unwrap());
        assert!(gemini.contains(&format!("--prompt={prompt}")));
        assert!(!gemini.contains(&"--add-dir".to_string()));

        let cursor = strs(build_args("cursor-agent", &o).unwrap());
        assert_eq!(cursor.last().unwrap(), &prompt);

        let opencode = strs(build_args("opencode", &o).unwrap());
        assert_eq!(opencode.last().unwrap(), &prompt);

        for cli in ["claude", "gemini", "cursor-agent", "opencode"] {
            let args = strs(build_args(cli, &o).unwrap());
            assert!(!args.contains(&"--image".to_string()), "{cli}");
        }
    }

    #[test]
    fn no_images_leaves_every_cli_unchanged() {
        let ws = Path::new("/tmp/ws");
        for cli in KNOWN_CLIS.iter().map(|c| c.id) {
            assert_eq!(
                strs(build_args(cli, &opts("hi", ws)).unwrap()),
                strs(build_args(cli, &with_images("hi", ws, &[])).unwrap()),
                "{cli}"
            );
        }
    }

    #[test]
    fn rejects_bad_media_types() {
        let dir = Path::new("/nonexistent-kiln-image-test");
        let data = b64("png bytes");
        for media in ["image/svg+xml", "application/pdf", "text/html", "image/png; charset=x", "", "image/bmp"] {
            let err = stage_images(dir, &[image("x", media, &data)]).unwrap_err();
            assert!(err.contains("unsupported image type"), "{media}: {err}");
        }
        // the four accepted types pass the media check (and then write)
        let tmp = std::env::temp_dir().join(format!("kiln-img-{}", std::process::id()));
        let ok = [("image/png", "a"), ("image/jpeg", "b"), ("IMAGE/WEBP", "c"), ("image/gif", "d")];
        let images: Vec<CliImage> = ok.iter().map(|(m, n)| image(n, m, &data)).collect();
        let paths = stage_images(&tmp, &images).unwrap();
        let names: Vec<String> = paths.iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["1-a.png", "2-b.jpg", "3-c.webp", "4-d.gif"]);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn rejects_too_many_or_oversized_images_and_bad_base64() {
        let dir = Path::new("/nonexistent-kiln-image-test");
        let data = b64("x");
        let nine: Vec<CliImage> = (0..9).map(|i| image(&format!("i{i}"), "image/png", &data)).collect();
        assert!(stage_images(dir, &nine).unwrap_err().contains("at most 8"));

        let big = "A".repeat(MAX_IMAGE_BYTES / 3 * 4 + 8);
        assert!(stage_images(dir, &[image("big", "image/png", &big)]).unwrap_err().contains("larger than 10 MB"));

        assert!(stage_images(dir, &[image("bad", "image/png", "data:image/png;base64,AAAA")]).is_err());
        assert!(stage_images(dir, &[image("bad", "image/png", "AAAAA")]).is_err());
    }

    #[test]
    fn base64_and_names() {
        assert_eq!(decode_base64(&b64("hello world")).unwrap(), b"hello world");
        assert_eq!(decode_base64("aGVs\nbG8=").unwrap(), b"hello");
        assert!(decode_base64("aGV$bG8=").is_err());
        assert_eq!(image_stem("../../evil dir/Screen Shot.PNG"), "Screen-Shot");
        assert_eq!(image_stem("C:\\pics\\mock.jpeg"), "mock");
        assert_eq!(image_stem("...."), "image");
        assert_eq!(image_stem(&"x".repeat(100)).len(), 40);
    }

    #[test]
    fn staged_files_are_removed_with_their_run_dir() {
        let root = std::env::temp_dir().join(format!("kiln-img-guard-{}", std::process::id()));
        let dir = run_image_dir(&root, "run/with bad*chars");
        assert!(!dir.to_string_lossy().contains("bad*"));
        let paths = stage_images(&dir, &[image("shot", "image/png", &b64("png"))]).unwrap();
        assert_eq!(paths[0], dir.join("1-shot.png"));
        assert_eq!(fs::read(&paths[0]).unwrap(), b"png");
        drop(RunDir(dir.clone()));
        assert!(!dir.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_bad_values() {
        let ws = Path::new("/tmp/ws");
        assert!(build_args("claude", &opts("  \n", ws)).is_err());
        assert!(build_args("claude", &opts("a\0b", ws)).is_err());
        assert!(build_args("nope", &opts("hi", ws)).is_err());
        let mut o = opts("hi", ws);
        o.model = Some("--dangerously-skip-permissions");
        assert!(build_args("claude", &o).is_err());
        o.model = Some("gpt-5\n--yolo");
        assert!(build_args("codex", &o).is_err());
        o.model = Some("   ");
        o.resume = Some("-x");
        assert!(build_args("claude", &o).is_err());
        o.resume = None;
        assert_eq!(strs(build_args("opencode", &o).unwrap()), ["run", "hi"]);
    }

    #[test]
    fn cursor_merge_preserves_entries() {
        let url = "http://127.0.0.1:7457/mcp";
        let existing = r#"{"mcpServers":{"figma":{"url":"http://x"},"kiln":{"url":"http://127.0.0.1:7460/mcp","old":1}},"other":true}"#;
        let v: Value = serde_json::from_str(&merge_cursor_config(Some(existing), url).unwrap()).unwrap();
        assert_eq!(v["mcpServers"]["figma"]["url"], "http://x");
        assert_eq!(v["mcpServers"]["kiln"], json!({ "url": url }));
        assert_eq!(v["other"], true);

        for empty in [None, Some(""), Some("  \n")] {
            let v: Value = serde_json::from_str(&merge_cursor_config(empty, url).unwrap()).unwrap();
            assert_eq!(v, json!({ "mcpServers": { "kiln": { "url": url } } }));
        }
        let v: Value = serde_json::from_str(&merge_cursor_config(Some(r#"{"x":1}"#), url).unwrap()).unwrap();
        assert_eq!(v, json!({ "x": 1, "mcpServers": { "kiln": { "url": url } } }));

        for bad in ["{nope", "[]", r#"{"mcpServers":[]}"#] {
            assert!(merge_cursor_config(Some(bad), url).is_err(), "{bad}");
        }
    }

    #[test]
    fn cursor_connect_writes_file() {
        let dir = std::env::temp_dir().join(format!("kiln-cursor-{}", std::process::id()));
        let file = dir.join(".cursor/mcp.json");
        let msg = connect_cursor(file.clone(), "http://127.0.0.1:7457/mcp").unwrap();
        assert!(msg.contains("kiln"));
        let v: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(v["mcpServers"]["kiln"]["url"], "http://127.0.0.1:7457/mcp");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn workspace_configs_use_live_url() {
        let dir = std::env::temp_dir().join(format!("kiln-ws-{}", std::process::id()));
        write_workspace(&dir, "http://127.0.0.1:7457/mcp").unwrap();
        write_workspace(&dir, "http://127.0.0.1:7459/mcp").unwrap(); // port changed: rewritten
        let read = |p: &str| serde_json::from_str::<Value>(&fs::read_to_string(dir.join(p)).unwrap()).unwrap();
        let url = "http://127.0.0.1:7459/mcp";
        assert_eq!(read(".mcp.json"), json!({ "mcpServers": { "kiln": { "type": "http", "url": url } } }));
        assert_eq!(read(".cursor/mcp.json"), json!({ "mcpServers": { "kiln": { "url": url } } }));
        assert_eq!(read(".gemini/settings.json"), json!({ "mcpServers": { "kiln": { "httpUrl": url, "trust": true } } }));
        assert_eq!(read("opencode.json")["mcp"]["kiln"], json!({ "type": "remote", "url": url, "enabled": true }));
        assert!(fs::read_to_string(dir.join("AGENTS.md")).unwrap().contains("`kiln` MCP tools"));
        assert!(fs::read_to_string(dir.join("CLAUDE.md")).unwrap().contains("do not edit files"));
        assert!(fs::read_to_string(dir.join("GEMINI.md")).unwrap().contains("installed skills"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn snippets_and_connect_args() {
        let url = "http://127.0.0.1:7458/mcp";
        let snippets = connect_snippets(url);
        let ids: Vec<_> = snippets.iter().map(|s| s.cli.as_str()).collect();
        assert_eq!(ids, ["claude", "codex", "gemini", "cursor", "vscode", "zed", "windsurf", "opencode"]);
        assert!(snippets.iter().all(|s| s.command.contains(url)));
        let vscode: Value = serde_json::from_str(&snippets[4].command).unwrap();
        assert_eq!(vscode["servers"]["kiln"]["type"], "http");

        let (add, _) = connect_args("claude", url).unwrap();
        assert_eq!(add, ["mcp", "add", "--transport", "http", "--scope", "user", "kiln", url]);
        assert_eq!(connect_args("codex", url).unwrap().0, ["mcp", "add", "kiln", "--url", url]);
        assert!(connect_args("opencode", url).is_none());
    }

    #[test]
    fn windows_names_follow_pathext_and_skip_the_sh_script() {
        assert_eq!(candidate_names_for("claude", false, Some(".EXE;.CMD")), ["claude"]);
        assert_eq!(candidate_names_for("claude", true, None), ["claude.com", "claude.exe", "claude.bat", "claude.cmd"]);
        // PATHEXT order wins; script types CreateProcess can't start are left out; the usual
        // shims are still looked for if PATHEXT forgot them
        assert_eq!(
            candidate_names_for("codex", true, Some(".CMD;.JS;.Exe;.PS1;.cmd")),
            ["codex.cmd", "codex.exe", "codex.com", "codex.bat"]
        );
        assert!(is_batch(Path::new(r"C:\Users\a\AppData\Roaming\npm\claude.CMD")));
        assert!(is_batch(Path::new("x/run.bat")));
        assert!(!is_batch(Path::new("x/claude.exe")) && !is_batch(Path::new("x/claude")));
    }

    #[test]
    fn windows_install_folders() {
        let d = WinDirs {
            home: Some(PathBuf::from("H")),
            appdata: Some(PathBuf::from("R")),
            local: Some(PathBuf::from("L")),
            scoop: None,
            program_files: Some(PathBuf::from("P")),
            nvm_symlink: Some(PathBuf::from("N")),
        };
        let dirs = windows_extra_dirs(&d);
        assert_eq!(dirs[0], Path::new("R").join("npm"), "npm globals first");
        for want in [
            Path::new("H").join(".local").join("bin"),
            Path::new("L").join("cursor-agent"),
            Path::new("L").join("Programs"),
            Path::new("H").join(".bun").join("bin"),
            Path::new("H").join(".cargo").join("bin"),
            Path::new("H").join("scoop").join("shims"),
            Path::new("P").join("nodejs"),
            PathBuf::from("N"),
        ] {
            assert!(dirs.contains(&want), "missing {}", want.display());
        }
        let custom = WinDirs { scoop: Some(PathBuf::from("S")), ..d };
        let dirs = windows_extra_dirs(&custom);
        assert!(dirs.contains(&Path::new("S").join("shims")) && !dirs.contains(&Path::new("H").join("scoop").join("shims")));
        assert!(windows_extra_dirs(&WinDirs::default()).is_empty());
    }

    #[test]
    fn login_shell_falls_back_to_bash_then_sh() {
        let all = |_: &str| true;
        let s = |v: Vec<(String, &str)>| v.into_iter().map(|(a, b)| format!("{a} {b}")).collect::<Vec<_>>();
        // macOS: $SHELL -lic, then zsh -lc, as before (bash and sh only matter if both fail)
        assert_eq!(s(shell_attempts(Some("/bin/zsh"), all)), ["/bin/zsh -lic", "/bin/zsh -lc", "/bin/bash -lc", "/bin/sh -lc"]);
        // Linux without zsh
        let no_zsh = |p: &str| p != "/bin/zsh";
        assert_eq!(s(shell_attempts(Some("/usr/bin/fish"), no_zsh)), ["/usr/bin/fish -lic", "/bin/bash -lc", "/bin/sh -lc"]);
        assert_eq!(s(shell_attempts(None, |p| p == "/bin/sh")), ["/bin/sh -lc"]);
        assert_eq!(s(shell_attempts(Some("  "), |p| p == "/bin/sh")), ["/bin/sh -lc"]);
    }

    #[test]
    fn windows_clis_get_the_prompt_on_stdin_or_in_a_file() {
        let all = ["claude", "codex", "gemini", "cursor-agent", "opencode"];
        // macOS and Linux: always one plain argument, as before
        for cli in all {
            assert_eq!(prompt_via(cli, Launch::Unix, NASTY), PromptVia::Arg);
        }
        // Windows: the CLIs that read stdin always get it there, .exe or .cmd
        for cli in ["claude", "codex", "gemini"] {
            assert_eq!(prompt_via(cli, Launch::WindowsBatch, "short"), PromptVia::Stdin);
            assert_eq!(prompt_via(cli, Launch::WindowsExe, "short"), PromptVia::Stdin);
        }
        for cli in ["cursor-agent", "opencode"] {
            let b = Launch::WindowsBatch;
            assert_eq!(prompt_via(cli, b, NASTY), PromptVia::File, "std refuses CR/LF in batch arguments");
            assert_eq!(prompt_via(cli, b, "make it \"pop\" 100%"), PromptVia::Arg, "std escapes quotes and %");
            assert_eq!(prompt_via(cli, b, &"x".repeat(BATCH_PROMPT_MAX + 1)), PromptVia::File, "cmd.exe line limit");
            // 1000 `%` are 1000 characters but 8000 once escaped
            assert_eq!(prompt_via(cli, b, &"%".repeat(1000)), PromptVia::File);
            let e = Launch::WindowsExe;
            assert_eq!(prompt_via(cli, e, NASTY), PromptVia::Arg, "an .exe takes newlines");
            assert_eq!(prompt_via(cli, e, &"x".repeat(EXE_PROMPT_MAX + 1)), PromptVia::File, "CreateProcess limit");
        }
        assert_eq!(batch_arg_len("a%\"b"), 1 + 8 + 2 + 1);
        assert_eq!(batch_arg_len("🔥"), 2, "UTF-16 units");
        assert_eq!(Launch::of(Path::new("x/claude.cmd")), if cfg!(windows) { Launch::WindowsBatch } else { Launch::Unix });
    }

    #[test]
    fn stdin_prompts_leave_no_prompt_argument() {
        let ws = PathBuf::from("/tmp/kiln-ws");
        let o = RunOptions { via: PromptVia::Stdin, ..opts(NASTY, &ws) };
        let claude = strs(build_args("claude", &o).unwrap());
        assert!(!claude.iter().any(|a| a == "--" || a.contains("pop")), "{claude:?}");
        assert_eq!(claude.last().unwrap(), "Read");
        let codex = strs(build_args("codex", &o).unwrap());
        assert_eq!(&codex[codex.len() - 2..], ["--", "-"]);
        let gemini = strs(build_args("gemini", &o).unwrap());
        assert!(!gemini.iter().any(|a| a.starts_with("--prompt")), "{gemini:?}");
        assert!(build_args("cursor-agent", &o).is_err() && build_args("opencode", &o).is_err());
        // the text that goes on stdin: images listed for every CLI but Codex
        let imgs = img_paths();
        assert!(full_prompt("claude", NASTY, &imgs).ends_with("2-mock.jpg"));
        assert_eq!(full_prompt("codex", NASTY, &imgs), NASTY);
    }

    #[test]
    fn file_prompts_pass_a_one_line_pointer() {
        let ws = PathBuf::from("/tmp/kiln-ws");
        let file = prompt_dir(&ws, "run-1").join("prompt.md");
        let o = RunOptions { via: PromptVia::File, prompt_file: Some(&file), ..opts(NASTY, &ws) };
        for cli in ["cursor-agent", "opencode", "gemini"] {
            let args = strs(build_args(cli, &o).unwrap());
            let last = args.iter().find(|a| a.contains("prompt.md")).unwrap_or_else(|| panic!("{cli}: {args:?}"));
            assert!(!last.contains(['\n', '\r']) && !last.contains("pop"), "{cli}: {last}");
        }
        let missing = RunOptions { prompt_file: None, ..o };
        assert!(build_args("cursor-agent", &missing).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn path_helpers() {
        let noisy = "Welcome!\n__KILN_PATH__/a/bin:/usr/bin__KILN_PATH__\nbye";
        assert_eq!(extract_marked(noisy).as_deref(), Some("/a/bin:/usr/bin"));
        assert_eq!(extract_marked("no markers"), None);

        let merged = merge_paths(
            Some(OsStr::new("/login/bin:/usr/bin")),
            Some(OsStr::new("/usr/bin:/bin")),
            &[PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/login/bin")],
        );
        assert_eq!(merged, OsString::from("/login/bin:/usr/bin:/bin:/opt/homebrew/bin"));
        let extras = extra_dirs(Some(Path::new("/h")));
        assert_eq!(extras[0], PathBuf::from("/h/.local/bin"));
        assert!(extras.contains(&PathBuf::from("/h/.volta/bin")));
    }

    #[test]
    fn error_line_prefers_errors() {
        let trace = "file:///x/codex.js:108\n  throw new Error(\n        ^\n\nError: Missing optional dependency\n    at foo";
        assert_eq!(error_line(trace, "").as_deref(), Some("Error: Missing optional dependency"));
        assert_eq!(error_line("warn\nTypeError: x is undefined", "").as_deref(), Some("TypeError: x is undefined"));
        assert_eq!(error_line("could not find an error handler", "").as_deref(), Some("could not find an error handler"));
        assert_eq!(error_line("", "\n  boom\n").as_deref(), Some("boom"));
        assert_eq!(error_line("", ""), None);
    }

    #[cfg(unix)]
    #[cfg(unix)]
    #[test]
    fn finds_only_executables() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("kiln-bin-{}", std::process::id()));
        let (a, b) = (dir.join("a"), dir.join("b"));
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::write(a.join("tool"), "not executable").unwrap();
        fs::write(b.join("tool"), "#!/bin/sh\necho 1.2.3\n").unwrap();
        fs::set_permissions(b.join("tool"), fs::Permissions::from_mode(0o755)).unwrap();
        let path = std::env::join_paths([&a, &b]).unwrap();
        assert_eq!(find_executable("tool", &path), Some(b.join("tool")));
        assert_eq!(find_executable("missing", &path), None);
        fs::remove_dir_all(&dir).unwrap();
    }

    // ---- run lifecycle (unix: uses /bin/sh as a stand-in agent) ----------------

    #[cfg(unix)]
    struct Recorder {
        events: Arc<Mutex<Vec<(String, Value)>>>,
        exit: tokio::sync::mpsc::UnboundedReceiver<Value>,
        emit: EmitFn,
    }

    #[cfg(unix)]
    fn recorder() -> Recorder {
        let events = Arc::new(Mutex::new(Vec::new()));
        let (tx, exit) = tokio::sync::mpsc::unbounded_channel();
        let ev = events.clone();
        let emit: EmitFn = Arc::new(move |event, payload| {
            ev.lock().unwrap().push((event.to_string(), payload.clone()));
            if event == EVENT_EXIT {
                let _ = tx.send(payload);
            }
        });
        Recorder { events, exit, emit }
    }

    #[cfg(unix)]
    fn sh(runs: &SharedRuns, id: &str, script: &str, timeout: Duration, emit: EmitFn) -> Result<(), String> {
        let args: Vec<OsString> = vec!["-c".into(), script.into()];
        spawn_run(
            runs.clone(),
            id.into(),
            Path::new("/bin/sh"),
            &args,
            &std::env::temp_dir(),
            &[("KILN_MCP_URL", "http://127.0.0.1:1/mcp".into())],
            timeout,
            emit,
            Vec::new(),
            None,
        )
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_streams_lines_and_exit_code() {
        let runs = SharedRuns::default();
        let mut rec = recorder();
        sh(&runs, "r1", "echo \"$KILN_MCP_URL\"; printf 'two\\r\\n'; echo oops >&2; exit 3", RUN_TIMEOUT, rec.emit.clone())
            .unwrap();
        assert!(sh(&runs, "r1", "true", RUN_TIMEOUT, rec.emit.clone()).is_err(), "duplicate run id");
        let exit = tokio::time::timeout(Duration::from_secs(10), rec.exit.recv()).await.unwrap().unwrap();
        assert_eq!(exit, json!({ "runId": "r1", "code": 3, "error": null }));
        assert!(!runs.is_running("r1"));

        let events = rec.events.lock().unwrap();
        let lines = |stream: &str| -> Vec<String> {
            events
                .iter()
                .filter(|(e, p)| e == EVENT_OUTPUT && p["stream"] == stream)
                .map(|(_, p)| p["line"].as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(lines("stdout"), ["http://127.0.0.1:1/mcp", "two"]);
        assert_eq!(lines("stderr"), ["oops"]);
        assert_eq!(events.last().unwrap().0, EVENT_EXIT, "exit is emitted after all output");
    }

    #[cfg(unix)]
    fn alive(pid: i32) -> bool {
        unsafe { libc::kill(pid, 0) == 0 }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancel_kills_process_group() {
        let runs = SharedRuns::default();
        let mut rec = recorder();
        // The grandchild `sleep` stands in for a node subprocess.
        sh(&runs, "c1", "sleep 30 & echo $!; wait", RUN_TIMEOUT, rec.emit.clone()).unwrap();
        let grandchild = loop {
            let found = rec.events.lock().unwrap().iter().find_map(|(e, p)| {
                (e == EVENT_OUTPUT).then(|| p["line"].as_str().unwrap().parse::<i32>().ok()).flatten()
            });
            if let Some(pid) = found {
                break pid;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        assert!(alive(grandchild));
        assert!(runs.cancel("c1"));
        assert!(!runs.cancel("nope"));
        let exit = tokio::time::timeout(Duration::from_secs(10), rec.exit.recv()).await.unwrap().unwrap();
        assert_eq!(exit["error"], "cancelled");
        let deadline = Instant::now() + Duration::from_secs(3);
        while alive(grandchild) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(!alive(grandchild), "grandchild {grandchild} survived cancel");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn prompt_on_stdin_reaches_the_child_unchanged() {
        let runs = SharedRuns::default();
        let mut rec = recorder();
        let args: Vec<OsString> = vec!["-c".into(), "cat".into()];
        spawn_run(runs.clone(), "s1".into(), Path::new("/bin/sh"), &args, &std::env::temp_dir(), &[], RUN_TIMEOUT, rec.emit.clone(), Vec::new(), Some(NASTY.into()))
            .unwrap();
        let exit = tokio::time::timeout(Duration::from_secs(10), rec.exit.recv()).await.unwrap().unwrap();
        assert_eq!(exit["code"], 0, "{exit}");
        let out: Vec<String> = rec
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|(e, p)| e == EVENT_OUTPUT && p["stream"] == "stdout")
            .map(|(_, p)| p["line"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(out, NASTY.lines().collect::<Vec<_>>());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_dirs_are_removed_when_the_run_ends() {
        let runs = SharedRuns::default();
        let mut rec = recorder();
        let ws = std::env::temp_dir().join(format!("kiln-prompt-ws-{}", std::process::id()));
        let dir = prompt_dir(&ws, "p1");
        assert!(dir.starts_with(ws.join(".kiln-prompts")));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("prompt.md"), NASTY).unwrap();
        let args: Vec<OsString> = vec!["-c".into(), "true".into()];
        spawn_run(runs.clone(), "p1".into(), Path::new("/bin/sh"), &args, &std::env::temp_dir(), &[], RUN_TIMEOUT, rec.emit.clone(), vec![RunDir(dir.clone())], None)
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), rec.exit.recv()).await.unwrap().unwrap();
        assert!(!dir.exists());
        let _ = fs::remove_dir_all(&ws);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_times_out() {
        let runs = SharedRuns::default();
        let mut rec = recorder();
        sh(&runs, "t1", "sleep 30", Duration::from_millis(200), rec.emit.clone()).unwrap();
        let exit = tokio::time::timeout(Duration::from_secs(10), rec.exit.recv()).await.unwrap().unwrap();
        assert!(exit["error"].as_str().unwrap().starts_with("timed out"), "{exit}");
        assert!(!runs.is_running("t1"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_failure_is_an_error() {
        let runs = SharedRuns::default();
        let rec = recorder();
        let r = spawn_run(runs.clone(), "x".into(), Path::new("/nonexistent/agent"), &[], &std::env::temp_dir(), &[], RUN_TIMEOUT, rec.emit, Vec::new(), None);
        assert!(r.is_err());
        assert!(!runs.is_running("x"));
    }

    /// Machine-specific: run with `cargo test detect_real -- --ignored --nocapture`.
    /// Starts from the bare PATH a macOS GUI app gets, then relies on the login
    /// shell + common dirs to find the CLIs. Only runs `--version`.
    #[test]
    #[ignore]
    fn detect_real_clis_from_gui_path() {
        let path = compute_agent_path(Some("/usr/bin:/bin:/usr/sbin:/sbin".into()));
        println!("agent PATH = {}", path.to_string_lossy());
        let infos = detect_all(&path);
        for i in &infos {
            println!("{}", serde_json::to_string(i).unwrap());
        }
        for id in ["claude", "cursor-agent"] {
            let i = infos.iter().find(|i| i.id == id).unwrap();
            assert!(i.installed && i.version.is_some(), "{i:?}");
        }
    }

    #[test]
    fn cursor_model_list_is_parsed() {
        let out = "\u{1b}[1mAvailable models\u{1b}[0m\n\
                   \n\
                   auto - Auto\n\
                   gpt-5 - GPT-5 (current, default)\n\
                   \u{1b}[36mclaude-opus[1m]\u{1b}[0m - Opus 1M\n\
                   sonnet-4.5-thinking - Sonnet 4.5 Thinking (preview)\n\
                   gpt-5 - duplicate\n\
                   Tip: use --model <id> to pick one\n\
                   x - too short\n\
                   -bad - leading dash\n";
        let m = parse_cursor_models(out);
        let ids: Vec<&str> = m.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["auto", "gpt-5", "claude-opus[1m]", "sonnet-4.5-thinking"]);
        assert_eq!(m[1], CliModel { id: "gpt-5".into(), label: "GPT-5".into(), current: true });
        assert_eq!(m[2].label, "Opus 1M");
        assert!(!m[0].current);
        // a trailing note that isn't a flag is dropped from the label but doesn't mark it current
        assert_eq!(m[3].label, "Sonnet 4.5 Thinking");
        assert!(!m[3].current);
    }

    #[test]
    fn cursor_model_list_is_capped() {
        let out: String = (0..300).map(|i| format!("m{i} - Model {i}\n")).collect();
        assert_eq!(parse_cursor_models(&out).len(), MAX_CURSOR_MODELS);
    }

    #[test]
    fn opencode_model_list_is_parsed() {
        let out = "anthropic/claude-sonnet-5\nopenai/gpt-6.1-sol\n\nopenrouter/meta-llama/llama-4:free\nINFO loading config from /x/y\n/abs/path\nanthropic/claude-sonnet-5\n";
        let ids: Vec<String> = parse_opencode_models(out).into_iter().map(|m| m.id).collect();
        assert_eq!(ids, ["anthropic/claude-sonnet-5", "openai/gpt-6.1-sol", "openrouter/meta-llama/llama-4:free"]);
    }

    #[test]
    fn login_errors_are_recognised() {
        assert!(needs_login("Error: Authentication required. Run 'agent login', pass --api-key"));
        assert!(needs_login("You are not logged in"));
        assert!(!needs_login("gpt-5 - GPT-5"));
    }

    #[test]
    fn clis_without_a_listing_command_return_nothing() {
        for id in ["claude", "codex", "gemini"] {
            assert_eq!(list_models(known(id).unwrap(), OsStr::new("")).unwrap(), Vec::<CliModel>::new());
        }
        // not installed: empty PATH finds nothing
        assert!(list_models(known("cursor-agent").unwrap(), OsStr::new("/nonexistent")).unwrap().is_empty());
    }
}
