//! Native file storage under `<Documents>/Kiln`:
//!
//! - Drafts: `<root>/<id>.kiln`, one JSON document per file.
//! - Projects: `<root>/<Folder Name>/project.json` plus that project's `<id>.kiln` files.
//! - Trash: `<root>/.trash/<id>-<ms>.kiln` plus a `<id>-<ms>.json` sidecar.
//! - Index: `<root>/.kiln-index.json`, a metadata cache so listing avoids re-parsing.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;

const EXT: &str = "kiln";
const TRASH: &str = ".trash";
const INDEX: &str = ".kiln-index.json";
const PROJECT_FILE: &str = "project.json";
const DEFAULT_COLOR: &str = "#ff5b1f";
const UNTITLED_PROJECT: &str = "Untitled project";
const MAX_FOLDER_CHARS: usize = 80;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    pub id: String,
    pub name: String,
    pub updated_at: serde_json::Number,
    pub thumbnail: Option<String>,
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    pub id: String,
    pub name: String,
    pub color: String,
    pub created_at: serde_json::Number,
    pub updated_at: serde_json::Number,
    pub file_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub trash_id: String,
    pub id: String,
    pub name: String,
    pub deleted_at: u64,
    pub thumbnail: Option<String>,
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExportFile {
    pub path: String,
    pub contents: String,
    /// `contents` is base64 (PNG / JPG exports): written as the decoded bytes.
    #[serde(default)]
    pub base64: bool,
}

/// On-disk `project.json`. Unknown keys are preserved on rewrite.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectFile {
    id: String,
    name: String,
    #[serde(default = "default_color")]
    color: String,
    #[serde(default = "zero")]
    created_at: serde_json::Number,
    #[serde(flatten)]
    extra: serde_json::Map<String, Value>,
}

fn default_color() -> String {
    DEFAULT_COLOR.to_string()
}

fn zero() -> serde_json::Number {
    serde_json::Number::from(0)
}

/// A project folder found on disk.
#[derive(Debug, Clone)]
struct Project {
    file: ProjectFile,
    dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexEntry {
    id: String,
    name: String,
    updated_at: serde_json::Number,
    thumbnail: Option<String>,
    mtime: f64,
    size: u64,
    project_id: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sidecar {
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    deleted_at: Option<Value>,
    /// The document's id, name and thumbnail, so listing the trash never parses whole
    /// documents. Absent in sidecars written before they were added (backfilled on list).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thumbnail: Option<String>,
}

type DirCache = Mutex<HashMap<PathBuf, HashMap<String, PathBuf>>>;

/// root -> (file id -> folder holding `<id>.kiln`), refreshed on every list.
/// (OnceLock rather than LazyLock: the crate's rust-version is 1.77.)
static DIR_CACHE: OnceLock<DirCache> = OnceLock::new();

/// One listing at a time: the home screen lists files and projects together, and the second
/// listing then finds a fresh index instead of re-parsing the same changed files in parallel.
static LIST_LOCK: Mutex<()> = Mutex::new(());

/// (root, file id) -> the `updatedAt` last written. Two autosaves can overlap (a slow save of a
/// big document, then the next one); a save older than what is on disk is dropped.
static SAVED: OnceLock<Mutex<HashMap<(PathBuf, String), f64>>> = OnceLock::new();

fn saved() -> std::sync::MutexGuard<'static, HashMap<(PathBuf, String), f64>> {
    SAVED.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

fn dir_cache() -> &'static DirCache {
    DIR_CACHE.get_or_init(Default::default)
}

static ID_COUNTER: AtomicU64 = AtomicU64::new(0);

/// File ids become file names, so only allow a conservative alphabet.
pub fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn check_id(id: &str) -> Result<(), String> {
    if is_valid_id(id) {
        Ok(())
    } else {
        Err(format!("invalid id {id:?}: expected [A-Za-z0-9_-]+"))
    }
}

/// Validates a path relative to the export folder: no absolute paths, no `..`.
pub fn safe_relative_path(p: &str) -> Result<PathBuf, String> {
    safe_relative_path_for(p, cfg!(windows))
}

/// [`safe_relative_path`], with Windows' extra rules when `windows`: no `:` (a drive or an
/// alternate data stream), no characters Windows forbids, no device names, no trailing dot or space.
pub fn safe_relative_path_for(p: &str, windows: bool) -> Result<PathBuf, String> {
    if p.is_empty() || p.contains('\0') || p.contains('\\') {
        return Err(format!("invalid export path {p:?}"));
    }
    let path = Path::new(p);
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::Normal(c) if windows => {
                let s = c.to_string_lossy();
                if s.contains(WINDOWS_FORBIDDEN) || s.chars().any(char::is_control) || s.ends_with(['.', ' ']) || is_windows_reserved(&s) {
                    return Err(format!("export path {p:?} has a name Windows can't use"));
                }
                out.push(c)
            }
            Component::Normal(c) => out.push(c),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!("export path {p:?} must be relative and stay inside the folder"));
            }
        }
    }
    if out.as_os_str().is_empty() {
        return Err(format!("invalid export path {p:?}"));
    }
    Ok(out)
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn now_millis() -> u64 {
    (now_nanos() / 1_000_000) as u64
}

fn base36(mut n: u128) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// Generates an id like `p<base36 time><base36 counter>`.
fn gen_id(prefix: &str) -> String {
    let c = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}{}{}", base36(now_nanos()), base36(c as u128))
}

pub fn files_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let docs = documents_or_home(app.path().document_dir().ok(), app.path().home_dir().ok())
        .ok_or("cannot locate your Documents or home folder")?;
    let dir = docs.join("Kiln");
    // also creates ~/Documents when it is the fallback
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// The Documents folder, or `~/Documents` when the system names none (Linux without XDG
/// user dirs configured).
pub fn documents_or_home(docs: Option<PathBuf>, home: Option<PathBuf>) -> Option<PathBuf> {
    docs.filter(|d| !d.as_os_str().is_empty())
        .or_else(|| home.filter(|h| !h.as_os_str().is_empty()).map(|h| h.join("Documents")))
}

/// Names Windows reserves for devices, with or without an extension (`con`, `NUL.txt`, `com1`).
pub fn is_windows_reserved(name: &str) -> bool {
    let base = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    let numbered = |p: &str| base.len() == 4 && base.starts_with(p) && matches!(base.as_bytes()[3], b'1'..=b'9');
    matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL") || numbered("COM") || numbered("LPT")
}

/// Characters Windows doesn't allow in a file or folder name (besides control characters).
const WINDOWS_FORBIDDEN: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

fn file_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.{EXT}"))
}

/// Writes `bytes` to `target` atomically: temp file in the same folder, fsync, rename.
pub fn atomic_write(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = target.parent().ok_or("target has no parent folder")?;
    let fname = target
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(".{fname}.{}.tmp", now_nanos()));
    let write = || -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, target)
    };
    write().map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("failed to write {}: {e}", target.display())
    })
}

fn write_json<T: Serialize + ?Sized>(target: &Path, v: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?;
    atomic_write(target, &bytes)
}

fn read_json(path: &Path) -> Result<Value, String> {
    let bytes = fs::read(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("{} is corrupt: {e}", path.display()))
}

pub fn meta_from_value(v: &Value, fallback_id: &str) -> FileMeta {
    let id = v
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or(fallback_id)
        .to_string();
    let name = v
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Untitled")
        .to_string();
    let updated_at = match v.get("updatedAt") {
        Some(Value::Number(n)) => n.clone(),
        _ => zero(),
    };
    let thumbnail = v
        .get("thumbnail")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    FileMeta { id, name, updated_at, thumbnail, project_id: None }
}

fn num_f64(n: &serde_json::Number) -> f64 {
    n.as_f64().unwrap_or(0.0)
}

// ---------------------------------------------------------------------------
// Folder names
// ---------------------------------------------------------------------------

/// Turns a project display name into a safe folder name.
pub fn sanitize_folder_name(name: &str) -> String {
    sanitize_folder_name_for(name, cfg!(windows))
}

/// [`sanitize_folder_name`]; with `windows`, also drops the characters Windows forbids, trailing
/// dots, and device names (`CON` becomes `_CON`), so Windows can create the folder.
pub fn sanitize_folder_name_for(name: &str, windows: bool) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':') && !c.is_control())
        .filter(|c| !windows || !WINDOWS_FORBIDDEN.contains(c))
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.').trim();
    let truncated: String = trimmed.chars().take(MAX_FOLDER_CHARS).collect();
    let mut out = truncated.trim_end();
    if windows {
        out = out.trim_end_matches(['.', ' ']);
    }
    if out.is_empty() {
        UNTITLED_PROJECT.to_string()
    } else if windows && is_windows_reserved(out) {
        format!("_{out}")
    } else {
        out.to_string()
    }
}

/// `base`, or `base 2`, `base 3`… so it does not collide (case-insensitively) with any
/// entry in `root` other than `exclude` (the folder being renamed).
fn unique_folder_name(root: &Path, base: &str, exclude: Option<&str>) -> String {
    let exclude = exclude.map(str::to_lowercase);
    let taken: HashSet<String> = fs::read_dir(root)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.file_name().to_string_lossy().to_lowercase())
                .filter(|n| Some(n) != exclude.as_ref())
                .collect()
        })
        .unwrap_or_default();
    if !taken.contains(&base.to_lowercase()) {
        return base.to_string();
    }
    (2u64..)
        .map(|n| format!("{base} {n}"))
        .find(|c| !taken.contains(&c.to_lowercase()))
        .unwrap_or_else(|| base.to_string())
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

fn read_project_file(dir: &Path) -> Option<ProjectFile> {
    let bytes = fs::read(dir.join(PROJECT_FILE)).ok()?;
    let pf: ProjectFile = serde_json::from_slice(&bytes).ok()?;
    is_valid_id(&pf.id).then_some(pf)
}

/// All project folders directly under `root`, sorted by folder name. Dot-folders and folders
/// without a readable `project.json` are ignored; a duplicated project id keeps the first.
fn read_projects(root: &Path) -> Vec<Project> {
    let Ok(rd) = fs::read_dir(root) else { return Vec::new() };
    let mut dirs: Vec<PathBuf> = rd
        .flatten()
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .collect();
    dirs.sort();
    let mut seen = HashSet::new();
    dirs.into_iter()
        .filter_map(|dir| read_project_file(&dir).map(|file| Project { file, dir }))
        .filter(|p| seen.insert(p.file.id.clone()))
        .collect()
}

fn find_project(root: &Path, id: &str) -> Result<Project, String> {
    check_id(id)?;
    read_projects(root)
        .into_iter()
        .find(|p| p.file.id == id)
        .ok_or_else(|| format!("project {id:?} not found"))
}

fn project_dir_for(root: &Path, project_id: Option<&str>) -> Result<PathBuf, String> {
    match project_id {
        Some(pid) => find_project(root, pid).map(|p| p.dir),
        None => Ok(root.to_path_buf()),
    }
}

// ---------------------------------------------------------------------------
// Resolving files
// ---------------------------------------------------------------------------

fn cache_get(root: &Path, id: &str) -> Option<PathBuf> {
    dir_cache().lock().ok()?.get(root)?.get(id).cloned()
}

fn cache_set(root: &Path, id: &str, dir: &Path) {
    if let Ok(mut c) = dir_cache().lock() {
        c.entry(root.to_path_buf()).or_default().insert(id.to_string(), dir.to_path_buf());
    }
}

fn cache_replace(root: &Path, map: HashMap<String, PathBuf>) {
    if let Ok(mut c) = dir_cache().lock() {
        c.insert(root.to_path_buf(), map);
    }
}

/// Drops (or repoints, when `to` is given) every cache entry living in `from`.
fn cache_move_dir(root: &Path, from: &Path, to: Option<&Path>) {
    if let Ok(mut c) = dir_cache().lock() {
        if let Some(m) = c.get_mut(root) {
            match to {
                Some(to) => m.values_mut().filter(|d| d.as_path() == from).for_each(|d| *d = to.to_path_buf()),
                None => m.retain(|_, d| d.as_path() != from),
            }
        }
    }
}

/// Finds `<id>.kiln`: top level, then the cache, then each project folder.
fn resolve(root: &Path, id: &str) -> Option<PathBuf> {
    let top = file_path(root, id);
    if top.is_file() {
        return Some(top);
    }
    if let Some(dir) = cache_get(root, id) {
        let p = file_path(&dir, id);
        if p.is_file() {
            return Some(p);
        }
    }
    for proj in read_projects(root) {
        let p = file_path(&proj.dir, id);
        if p.is_file() {
            cache_set(root, id, &proj.dir);
            return Some(p);
        }
    }
    None
}

/// The project id owning the folder that holds `path` (None for top level / unknown).
fn project_of_path(root: &Path, path: &Path) -> Option<String> {
    let parent = path.parent()?;
    if parent == root {
        return None;
    }
    read_project_file(parent).map(|p| p.id)
}

/// `.kiln` files (non-dot stems) directly inside `dir`.
fn kiln_files(dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    rd.flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some(EXT) && p.is_file())
        .filter_map(|p| {
            let stem = p.file_stem()?.to_string_lossy().into_owned();
            (!stem.starts_with('.')).then_some((stem, p))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Listing + index
// ---------------------------------------------------------------------------

fn read_index(root: &Path) -> HashMap<String, IndexEntry> {
    fs::read(root.join(INDEX))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn mtime_ms(md: &fs::Metadata) -> f64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// Lists drafts and project files, newest first. Uses (and refreshes) the index so only
/// changed files are re-parsed; the index never makes listing fail.
pub fn list_in(root: &Path) -> Result<Vec<FileMeta>, String> {
    let _one_at_a_time = LIST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    fs::read_dir(root).map_err(|e| format!("cannot read {}: {e}", root.display()))?;
    let old = read_index(root);
    let mut index = HashMap::new();
    let mut dirs = HashMap::new();
    let mut out = Vec::new();

    let mut folders: Vec<(String, PathBuf, Option<String>)> = vec![(String::new(), root.to_path_buf(), None)];
    for p in read_projects(root) {
        let rel = p.dir.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        folders.push((rel, p.dir, Some(p.file.id)));
    }

    for (rel, dir, project_id) in folders {
        for (stem, path) in kiln_files(&dir) {
            let key = if rel.is_empty() { stem.clone() } else { format!("{rel}/{stem}") };
            let Ok(md) = fs::metadata(&path) else { continue };
            let (mtime, size) = (mtime_ms(&md), md.len());
            let entry = match old.get(&key) {
                // within a microsecond: the f64 can come back from the JSON index a last digit
                // off (serde_json's default float parsing), which would defeat the cache
                Some(e) if (e.mtime - mtime).abs() < 0.001 && e.size == size => {
                    IndexEntry { project_id: project_id.clone(), ..e.clone() }
                }
                _ => {
                    let parsed = fs::read(&path)
                        .map_err(|e| e.to_string())
                        .and_then(|b| serde_json::from_slice::<Value>(&b).map_err(|e| e.to_string()));
                    let m = match parsed {
                        Ok(v) if v.is_object() => meta_from_value(&v, &stem),
                        Ok(_) => {
                            eprintln!("[kiln] skipping {}: not a JSON object", path.display());
                            continue;
                        }
                        Err(e) => {
                            eprintln!("[kiln] skipping corrupt file {}: {e}", path.display());
                            continue;
                        }
                    };
                    IndexEntry {
                        id: m.id,
                        name: m.name,
                        updated_at: m.updated_at,
                        thumbnail: m.thumbnail,
                        mtime,
                        size,
                        project_id: project_id.clone(),
                    }
                }
            };
            dirs.insert(stem, dir.clone());
            out.push(FileMeta {
                id: entry.id.clone(),
                name: entry.name.clone(),
                updated_at: entry.updated_at.clone(),
                thumbnail: entry.thumbnail.clone(),
                project_id: entry.project_id.clone(),
            });
            index.insert(key, entry);
        }
    }

    if index != old {
        // compact: the index is a cache nobody reads by hand, and it carries every thumbnail
        let bytes = serde_json::to_vec(&index).map_err(|e| e.to_string());
        if let Err(e) = bytes.and_then(|b| atomic_write(&root.join(INDEX), &b)) {
            eprintln!("[kiln] cannot update index: {e}");
        }
    }
    cache_replace(root, dirs);

    out.sort_by(|a, b| num_f64(&b.updated_at).total_cmp(&num_f64(&a.updated_at)));
    Ok(out)
}

pub fn load_in(root: &Path, id: &str) -> Result<Option<Value>, String> {
    check_id(id)?;
    match resolve(root, id) {
        Some(path) => read_json(&path).map(Some),
        None => Ok(None),
    }
}

/// Writes `doc` in place if it exists anywhere, else into `project_id`'s folder (or top level).
/// When the newest automatic version is ten minutes old (or there is none), the save is also
/// kept as one.
pub fn save_in(root: &Path, doc: &Value, project_id: Option<&str>) -> Result<(), String> {
    save_in_at(root, doc, project_id, now_millis())
}

fn save_in_at(root: &Path, doc: &Value, project_id: Option<&str>, now: u64) -> Result<(), String> {
    let id = doc
        .get("id")
        .and_then(Value::as_str)
        .ok_or("document has no string `id`")?;
    check_id(id)?;
    let stamp = doc.get("updatedAt").and_then(Value::as_f64);
    let key = (root.to_path_buf(), id.to_string());
    // held through the write, so saves of a file land in order
    let mut saved = saved();
    if let (Some(new), Some(&old)) = (stamp, saved.get(&key)) {
        if new < old {
            return Ok(()); // an older save that lost the race: what is on disk is newer
        }
    }
    let bytes = serde_json::to_vec_pretty(doc).map_err(|e| e.to_string())?;
    if let Some(path) = resolve(root, id) {
        atomic_write(&path, &bytes)?;
    } else {
        let dir = project_dir_for(root, project_id)?;
        atomic_write(&file_path(&dir, id), &bytes)?;
        cache_set(root, id, &dir);
    }
    if let Some(new) = stamp {
        saved.insert(key, new);
    }
    // still under the lock, so two saves can't both decide a snapshot is due
    auto_version(root, id, doc, &bytes, now);
    Ok(())
}

// ---------------------------------------------------------------------------
// Trash
// ---------------------------------------------------------------------------

fn trash_dir(root: &Path) -> PathBuf {
    root.join(TRASH)
}

/// Moves `src` into the trash as `<id>-<ms>.kiln` with a sidecar; returns the trash id.
fn move_to_trash(root: &Path, src: &Path, id: &str, project_id: Option<&str>) -> Result<String, String> {
    let trash = trash_dir(root);
    fs::create_dir_all(&trash).map_err(|e| format!("cannot create trash folder: {e}"))?;
    let deleted_at = now_millis();
    let mut ms = deleted_at;
    let mut stem = format!("{id}-{ms}");
    while file_path(&trash, &stem).exists() {
        ms += 1;
        stem = format!("{id}-{ms}");
    }
    // the name and thumbnail come from the index when it has them (no parse of a big document)
    let meta = trashed_meta(root, src, id);
    fs::rename(src, file_path(&trash, &stem)).map_err(|e| format!("cannot move {id} to trash: {e}"))?;
    saved().remove(&(root.to_path_buf(), id.to_string()));
    let sidecar = Sidecar {
        project_id: project_id.map(str::to_string),
        deleted_at: Some(Value::from(deleted_at)),
        id: Some(meta.id),
        name: Some(meta.name),
        thumbnail: meta.thumbnail,
    };
    if let Err(e) = write_json(&trash.join(format!("{stem}.json")), &sidecar) {
        eprintln!("[kiln] cannot write trash sidecar: {e}");
    }
    Ok(stem)
}

/// A file's id, name and thumbnail for its trash sidecar: from the index if it is current there,
/// else read from the file.
fn trashed_meta(root: &Path, src: &Path, stem: &str) -> FileMeta {
    // current only if both size and mtime match, as in list_in: a same-length rename keeps the size
    let md = fs::metadata(src).ok();
    let indexed = md.and_then(|md| {
        let (mtime, size) = (mtime_ms(&md), md.len());
        read_index(root).into_values().find(|e| e.id == stem && e.size == size && (e.mtime - mtime).abs() < 0.001)
    });
    match indexed {
        Some(e) => FileMeta { id: e.id, name: e.name, updated_at: e.updated_at, thumbnail: e.thumbnail, project_id: None },
        None => match read_json(src) {
            Ok(v) if v.is_object() => meta_from_value(&v, stem),
            _ => FileMeta { id: stem.to_string(), name: "Untitled".into(), updated_at: zero(), thumbnail: None, project_id: None },
        },
    }
}

pub fn delete_in(root: &Path, id: &str) -> Result<(), String> {
    check_id(id)?;
    let Some(path) = resolve(root, id) else { return Ok(()) };
    let project_id = project_of_path(root, &path);
    move_to_trash(root, &path, id, project_id.as_deref()).map(|_| ())
}

fn read_sidecar(path: &Path) -> Option<Sidecar> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// `abc-1700000000000` -> ("abc", Some(1700000000000)).
fn split_trash_stem(stem: &str) -> (&str, Option<u64>) {
    match stem.rsplit_once('-') {
        Some((id, ms)) if !id.is_empty() && !ms.is_empty() && ms.bytes().all(|b| b.is_ascii_digit()) => {
            (id, ms.parse().ok())
        }
        _ => (stem, None),
    }
}

pub fn list_trash_in(root: &Path) -> Result<Vec<TrashItem>, String> {
    let trash = trash_dir(root);
    let mut out = Vec::new();
    for (stem, path) in kiln_files(&trash) {
        if !is_valid_id(&stem) {
            continue;
        }
        let (fallback_id, suffix_ms) = split_trash_stem(&stem);
        let sidecar_path = trash.join(format!("{stem}.json"));
        let mut sidecar = read_sidecar(&sidecar_path).unwrap_or_default();
        let meta = match (&sidecar.id, &sidecar.name) {
            (Some(id), Some(name)) => FileMeta {
                id: id.clone(),
                name: name.clone(),
                updated_at: zero(),
                thumbnail: sidecar.thumbnail.clone(),
                project_id: None,
            },
            // an older sidecar: read the document once, and keep what it says for next time
            _ => {
                let v = match read_json(&path) {
                    Ok(v) if v.is_object() => v,
                    _ => continue,
                };
                let meta = meta_from_value(&v, fallback_id);
                sidecar.id = Some(meta.id.clone());
                sidecar.name = Some(meta.name.clone());
                sidecar.thumbnail = meta.thumbnail.clone();
                if sidecar.deleted_at.is_none() {
                    sidecar.deleted_at = suffix_ms.map(Value::from);
                }
                if let Err(e) = write_json(&sidecar_path, &sidecar) {
                    eprintln!("[kiln] cannot update trash sidecar: {e}");
                }
                meta
            }
        };
        let deleted_at = sidecar
            .deleted_at
            .as_ref()
            .and_then(|d| d.as_u64().or_else(|| d.as_f64().map(|f| f as u64)))
            .or(suffix_ms)
            .or_else(|| fs::metadata(&path).ok().map(|m| mtime_ms(&m) as u64))
            .unwrap_or(0);
        out.push(TrashItem {
            trash_id: stem,
            id: meta.id,
            name: meta.name,
            deleted_at,
            thumbnail: meta.thumbnail,
            project_id: sidecar.project_id,
        });
    }
    out.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(out)
}

/// Restores into the original project (if it still exists) else top level; returns the
/// restored file id (a new one if the original id is taken).
pub fn restore_trash_in(root: &Path, trash_id: &str) -> Result<String, String> {
    check_id(trash_id)?;
    let trash = trash_dir(root);
    let src = file_path(&trash, trash_id);
    let sidecar_path = trash.join(format!("{trash_id}.json"));
    if !src.is_file() {
        return Err(format!("trash item {trash_id:?} not found"));
    }
    let mut doc = read_json(&src)?;
    if !doc.is_object() {
        return Err(format!("trash item {trash_id:?} is not a document"));
    }
    let sidecar = read_sidecar(&sidecar_path).unwrap_or_default();
    let dir = sidecar
        .project_id
        .as_deref()
        .and_then(|pid| find_project(root, pid).ok())
        .map(|p| p.dir)
        .unwrap_or_else(|| root.to_path_buf());

    let doc_id = doc.get("id").and_then(Value::as_str).map(str::to_string);
    let mut id = doc_id.clone().unwrap_or_else(|| split_trash_stem(trash_id).0.to_string());
    if !is_valid_id(&id) || resolve(root, &id).is_some() {
        id = gen_id("f");
    }
    if doc_id.as_deref() == Some(id.as_str()) {
        fs::rename(&src, file_path(&dir, &id)).map_err(|e| format!("cannot restore {trash_id}: {e}"))?;
    } else {
        doc["id"] = Value::String(id.clone());
        write_json(&file_path(&dir, &id), &doc)?;
        fs::remove_file(&src).map_err(|e| format!("cannot remove {}: {e}", src.display()))?;
    }
    let _ = fs::remove_file(&sidecar_path);
    cache_set(root, &id, &dir);
    Ok(id)
}

pub fn purge_trash_in(root: &Path, trash_id: Option<&str>) -> Result<(), String> {
    let trash = trash_dir(root);
    let ignore_missing = |r: std::io::Result<()>, p: &Path| match r {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("cannot remove {}: {e}", p.display())),
        _ => Ok(()),
    };
    // a file's versions go with it once nothing by that id is left, in the files or the trash
    match trash_id {
        Some(tid) => {
            check_id(tid)?;
            let file_id = trashed_file_id(&trash, tid);
            let kiln = file_path(&trash, tid);
            let side = trash.join(format!("{tid}.json"));
            ignore_missing(fs::remove_file(&kiln), &kiln)?;
            ignore_missing(fs::remove_file(&side), &side)?;
            if let Some(id) = file_id {
                drop_orphan_versions(root, &id);
            }
            Ok(())
        }
        None => {
            let ids: HashSet<String> = kiln_files(&trash).into_iter().filter_map(|(stem, _)| trashed_file_id(&trash, &stem)).collect();
            ignore_missing(fs::remove_dir_all(&trash), &trash)?;
            for id in ids {
                drop_orphan_versions(root, &id);
            }
            Ok(())
        }
    }
}

/// The id of the file a trash entry holds: from its sidecar, else from the entry's name.
fn trashed_file_id(trash: &Path, stem: &str) -> Option<String> {
    let id = read_sidecar(&trash.join(format!("{stem}.json")))
        .and_then(|s| s.id)
        .unwrap_or_else(|| split_trash_stem(stem).0.to_string());
    is_valid_id(&id).then_some(id)
}

/// Removes a file's versions when no file and no trash entry by that id is left.
fn drop_orphan_versions(root: &Path, file_id: &str) {
    if !is_valid_id(file_id) || resolve(root, file_id).is_some() {
        return;
    }
    let trash = trash_dir(root);
    if kiln_files(&trash).iter().any(|(stem, _)| trashed_file_id(&trash, stem).as_deref() == Some(file_id)) {
        return;
    }
    let dir = versions_dir(root, file_id);
    if let Err(e) = fs::remove_dir_all(&dir) {
        if e.kind() != std::io::ErrorKind::NotFound {
            eprintln!("[kiln] cannot remove versions of {file_id}: {e}");
        }
    }
}

// ---------------------------------------------------------------------------
// Versions: `<root>/.versions/<fileId>/<versionId>.kiln`, each with a `<versionId>.json` holding
// its meta, so listing never reads whole documents. A version id is `a<ms>-<n>` (automatic) or
// `n<ms>-<n>` (named), so the newest automatic one is found from file names alone.
// ---------------------------------------------------------------------------

const VERSIONS: &str = ".versions";
/// A save is also kept as a version when the newest automatic one is at least this old.
const AUTO_EVERY_MS: u64 = 10 * 60 * 1000;
/// Automatic versions kept: the newest this many, plus the newest of each of the last KEEP_DAYS days.
const KEEP_RECENT: usize = 30;
const KEEP_DAYS: u64 = 30;
const DAY_MS: u64 = 86_400_000;
const MAX_VERSION_NAME: usize = 120;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionMeta {
    pub version_id: String,
    pub file_id: String,
    /// None for an automatic (timed) version.
    pub name: Option<String>,
    pub created_at: u64,
    /// bytes on disk
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
}

fn versions_dir(root: &Path, file_id: &str) -> PathBuf {
    root.join(VERSIONS).join(file_id)
}

fn new_version_id(named: bool, created_at: u64) -> String {
    let c = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}{created_at}-{}", if named { 'n' } else { 'a' }, base36(c as u128))
}

/// `a1700000000000-3` -> Some((true, 1700000000000)): whether it is automatic, and when it was made.
fn parse_version_id(id: &str) -> Option<(bool, u64)> {
    let auto = match id.as_bytes().first()? {
        b'a' => true,
        b'n' => false,
        _ => return None,
    };
    let (ms, _) = id[1..].split_once('-')?;
    Some((auto, ms.parse().ok()?))
}

fn check_version_id(id: &str) -> Result<(), String> {
    check_id(id)?;
    parse_version_id(id).map(|_| ()).ok_or_else(|| format!("invalid version id {id:?}"))
}

/// Automatic versions of a file as (version id, created at), from file names only.
fn auto_versions(root: &Path, file_id: &str) -> Vec<(String, u64)> {
    kiln_files(&versions_dir(root, file_id))
        .into_iter()
        .filter_map(|(stem, _)| match parse_version_id(&stem) {
            Some((true, at)) => Some((stem, at)),
            _ => None,
        })
        .collect()
}

/// The automatic versions to drop: every one except the newest `keep_recent` and the newest of
/// each day (UTC) within the last `keep_days` days.
pub fn autos_to_prune(autos: &[(String, u64)], now: u64, keep_recent: usize, keep_days: u64) -> Vec<String> {
    let mut sorted: Vec<&(String, u64)> = autos.iter().collect();
    sorted.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.cmp(&a.0)));
    let mut days = HashSet::new();
    let mut out = Vec::new();
    for (i, (id, at)) in sorted.into_iter().enumerate() {
        let day_keeper = now.saturating_sub(*at) < keep_days * DAY_MS && days.insert(at / DAY_MS);
        if i >= keep_recent && !day_keeper {
            out.push(id.clone());
        }
    }
    out
}

fn remove_version_files(dir: &Path, version_id: &str) -> Result<(), String> {
    for p in [file_path(dir, version_id), dir.join(format!("{version_id}.json"))] {
        if let Err(e) = fs::remove_file(&p) {
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(format!("cannot remove {}: {e}", p.display()));
            }
        }
    }
    Ok(())
}

fn prune_versions(root: &Path, file_id: &str, now: u64) {
    let dir = versions_dir(root, file_id);
    for id in autos_to_prune(&auto_versions(root, file_id), now, KEEP_RECENT, KEEP_DAYS) {
        if let Err(e) = remove_version_files(&dir, &id) {
            eprintln!("[kiln] cannot prune version: {e}");
        }
    }
}

/// Writes the document bytes, then the meta (both atomically); a version without its meta is
/// still listed, so a crash between the two loses nothing.
fn write_version(
    root: &Path,
    file_id: &str,
    bytes: &[u8],
    thumbnail: Option<String>,
    name: Option<String>,
    created_at: u64,
) -> Result<VersionMeta, String> {
    let dir = versions_dir(root, file_id);
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let meta = VersionMeta {
        version_id: new_version_id(name.is_some(), created_at),
        file_id: file_id.to_string(),
        name,
        created_at,
        size: bytes.len() as u64,
        thumbnail,
    };
    atomic_write(&file_path(&dir, &meta.version_id), bytes)?;
    write_json(&dir.join(format!("{}.json", meta.version_id)), &meta)?;
    Ok(meta)
}

/// The timed snapshot taken on save. Never fails the save: a problem is only logged.
fn auto_version(root: &Path, file_id: &str, doc: &Value, bytes: &[u8], now: u64) {
    let newest = auto_versions(root, file_id).into_iter().map(|(_, at)| at).max();
    if newest.is_some_and(|at| now.saturating_sub(at) < AUTO_EVERY_MS) {
        return;
    }
    let thumbnail = meta_from_value(doc, file_id).thumbnail;
    match write_version(root, file_id, bytes, thumbnail, None, now) {
        Ok(_) => prune_versions(root, file_id, now),
        Err(e) => eprintln!("[kiln] cannot keep an automatic version of {file_id}: {e}"),
    }
}

/// A file's versions, newest first.
pub fn list_versions_in(root: &Path, file_id: &str) -> Result<Vec<VersionMeta>, String> {
    check_id(file_id)?;
    let dir = versions_dir(root, file_id);
    let mut out = Vec::new();
    for (stem, path) in kiln_files(&dir) {
        let Some((auto, created_at)) = parse_version_id(&stem) else { continue };
        let side: Option<VersionMeta> = fs::read(dir.join(format!("{stem}.json"))).ok().and_then(|b| serde_json::from_slice(&b).ok());
        let meta = side.filter(|m| m.version_id == stem).unwrap_or_else(|| VersionMeta {
            version_id: stem.clone(),
            file_id: file_id.to_string(),
            name: (!auto).then(|| "Untitled version".to_string()),
            created_at,
            size: fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
            thumbnail: None,
        });
        out.push(VersionMeta { file_id: file_id.to_string(), ..meta });
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| b.version_id.cmp(&a.version_id)));
    Ok(out)
}

/// Keeps `doc` (without one, the file as saved) as a version of `file_id`. A name makes it a named
/// version, kept until deleted; without one (or a blank one) it is automatic and may be pruned.
pub fn save_version_in(root: &Path, file_id: &str, name: Option<&str>, doc: Option<&Value>) -> Result<VersionMeta, String> {
    save_version_at(root, file_id, name, doc, now_millis())
}

fn save_version_at(root: &Path, file_id: &str, name: Option<&str>, doc: Option<&Value>, now: u64) -> Result<VersionMeta, String> {
    check_id(file_id)?;
    let loaded;
    let doc = match doc {
        Some(d) => d,
        None => {
            loaded = load_in(root, file_id)?.ok_or_else(|| format!("file {file_id:?} not found"))?;
            &loaded
        }
    };
    if doc.get("id").and_then(Value::as_str) != Some(file_id) {
        return Err("the document's id doesn't match the file".into());
    }
    let name = name.map(str::trim).filter(|n| !n.is_empty()).map(|n| n.chars().take(MAX_VERSION_NAME).collect::<String>());
    let auto = name.is_none();
    let bytes = serde_json::to_vec(doc).map_err(|e| e.to_string())?;
    let meta = write_version(root, file_id, &bytes, meta_from_value(doc, file_id).thumbnail, name, now)?;
    if auto {
        prune_versions(root, file_id, now);
    }
    Ok(meta)
}

pub fn load_version_in(root: &Path, file_id: &str, version_id: &str) -> Result<Option<Value>, String> {
    check_id(file_id)?;
    check_version_id(version_id)?;
    let path = file_path(&versions_dir(root, file_id), version_id);
    if !path.is_file() {
        return Ok(None);
    }
    read_json(&path).map(Some)
}

pub fn delete_version_in(root: &Path, file_id: &str, version_id: &str) -> Result<(), String> {
    check_id(file_id)?;
    check_version_id(version_id)?;
    let dir = versions_dir(root, file_id);
    remove_version_files(&dir, version_id)?;
    let _ = fs::remove_dir(&dir); // only goes when empty
    Ok(())
}

/// Writes a version back as the file (keeping the file's id) and returns it. The file as it was
/// becomes an automatic version first, so a restore can itself be taken back.
pub fn restore_version_in(root: &Path, file_id: &str, version_id: &str) -> Result<Value, String> {
    let mut doc = load_version_in(root, file_id, version_id)?.ok_or("that version no longer exists")?;
    if !doc.is_object() {
        return Err(format!("version {version_id:?} is not a document"));
    }
    let now = now_millis();
    if resolve(root, file_id).is_some() {
        save_version_at(root, file_id, None, None, now)?;
    }
    // newer than anything saved, so an older save still in flight doesn't land over it
    let last = saved().get(&(root.to_path_buf(), file_id.to_string())).copied().unwrap_or(0.0);
    doc["id"] = Value::String(file_id.to_string());
    doc["updatedAt"] = Value::from((now as f64).max(last.floor() + 1.0) as u64);
    save_in_at(root, &doc, None, now)?;
    Ok(doc)
}

// ---------------------------------------------------------------------------
// Project operations
// ---------------------------------------------------------------------------

pub fn list_projects_in(root: &Path) -> Result<Vec<ProjectMeta>, String> {
    let files = list_in(root)?;
    let mut out: Vec<ProjectMeta> = read_projects(root)
        .into_iter()
        .map(|p| {
            let mine: Vec<&FileMeta> = files.iter().filter(|f| f.project_id.as_deref() == Some(p.file.id.as_str())).collect();
            let updated_at = mine
                .iter()
                .map(|f| &f.updated_at)
                .max_by(|a, b| num_f64(a).total_cmp(&num_f64(b)))
                .cloned()
                .unwrap_or_else(|| p.file.created_at.clone());
            ProjectMeta {
                id: p.file.id,
                name: p.file.name,
                color: p.file.color,
                created_at: p.file.created_at,
                updated_at,
                file_count: mine.len(),
            }
        })
        .collect();
    out.sort_by(|a, b| num_f64(&b.updated_at).total_cmp(&num_f64(&a.updated_at)));
    Ok(out)
}

fn project_meta(root: &Path, id: &str) -> Result<ProjectMeta, String> {
    list_projects_in(root)?
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("project {id:?} not found"))
}

pub fn create_project_in(root: &Path, name: &str, color: Option<&str>) -> Result<ProjectMeta, String> {
    let name = match name.trim() {
        "" => UNTITLED_PROJECT,
        n => n,
    };
    let existing: HashSet<String> = read_projects(root).into_iter().map(|p| p.file.id).collect();
    let id = loop {
        let id = gen_id("p");
        if !existing.contains(&id) {
            break id;
        }
    };
    let folder = unique_folder_name(root, &sanitize_folder_name(name), None);
    let dir = root.join(&folder);
    fs::create_dir(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let created_at = serde_json::Number::from(now_millis());
    let file = ProjectFile {
        id: id.clone(),
        name: name.to_string(),
        color: color.filter(|c| !c.trim().is_empty()).unwrap_or(DEFAULT_COLOR).to_string(),
        created_at: created_at.clone(),
        extra: Default::default(),
    };
    if let Err(e) = write_json(&dir.join(PROJECT_FILE), &file) {
        let _ = fs::remove_dir_all(&dir);
        return Err(e);
    }
    Ok(ProjectMeta {
        id,
        name: file.name,
        color: file.color,
        created_at: created_at.clone(),
        updated_at: created_at,
        file_count: 0,
    })
}

pub fn update_project_in(
    root: &Path,
    id: &str,
    name: Option<&str>,
    color: Option<&str>,
) -> Result<ProjectMeta, String> {
    let Project { mut file, mut dir } = find_project(root, id)?;
    if let Some(n) = name.map(str::trim).filter(|n| !n.is_empty()) {
        file.name = n.to_string();
        let current = dir.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let base = sanitize_folder_name(n);
        if base != current {
            let folder = unique_folder_name(root, &base, Some(&current));
            if folder != current {
                let new_dir = root.join(&folder);
                fs::rename(&dir, &new_dir)
                    .map_err(|e| format!("cannot rename {} to {folder:?}: {e}", dir.display()))?;
                cache_move_dir(root, &dir, Some(&new_dir));
                dir = new_dir;
            }
        }
    }
    if let Some(c) = color.filter(|c| !c.trim().is_empty()) {
        file.color = c.to_string();
    }
    write_json(&dir.join(PROJECT_FILE), &file)?;
    project_meta(root, id)
}

pub fn remove_project_in(root: &Path, id: &str, mode: &str) -> Result<(), String> {
    let keep = match mode {
        "keep-files" => true,
        "trash-files" => false,
        _ => return Err(format!("unknown remove mode {mode:?}: expected \"keep-files\" or \"trash-files\"")),
    };
    let proj = find_project(root, id)?;
    // Only ever delete a folder that is a direct child of root.
    if proj.dir.parent() != Some(root) || proj.dir == root {
        return Err(format!("refusing to remove {}", proj.dir.display()));
    }
    let others: Vec<PathBuf> = read_projects(root)
        .into_iter()
        .filter(|p| p.dir != proj.dir)
        .map(|p| p.dir)
        .collect();
    for (stem, path) in kiln_files(&proj.dir) {
        if !keep {
            move_to_trash(root, &path, &stem, Some(id))?;
            continue;
        }
        let taken = |fid: &str| file_path(root, fid).exists() || others.iter().any(|d| file_path(d, fid).exists());
        if is_valid_id(&stem) && !taken(&stem) {
            fs::rename(&path, file_path(root, &stem)).map_err(|e| format!("cannot move {stem}: {e}"))?;
            continue;
        }
        let new_id = loop {
            let n = gen_id("f");
            if !taken(&n) {
                break n;
            }
        };
        let dest = file_path(root, &new_id);
        match read_json(&path) {
            Ok(mut doc) if doc.is_object() => {
                doc["id"] = Value::String(new_id.clone());
                write_json(&dest, &doc)?;
                fs::remove_file(&path).map_err(|e| format!("cannot remove {}: {e}", path.display()))?;
            }
            _ => fs::rename(&path, &dest).map_err(|e| format!("cannot move {stem}: {e}"))?,
        }
    }
    // The folder is the user's: drop only what Kiln (and Finder) put there. Without project.json
    // it is no longer a project; if the user kept other files in it, the folder stays with them.
    fs::remove_file(proj.dir.join(PROJECT_FILE))
        .map_err(|e| format!("cannot remove {}: {e}", proj.dir.join(PROJECT_FILE).display()))?;
    if let Ok(rd) = fs::read_dir(&proj.dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let ours = name == ".DS_Store" || (name.starts_with('.') && name.ends_with(".tmp"));
            if ours && e.file_type().map(|t| t.is_file()).unwrap_or(false) {
                let _ = fs::remove_file(e.path());
            }
        }
    }
    if let Err(e) = fs::remove_dir(&proj.dir) {
        eprintln!("[kiln] kept {} (it holds other files): {e}", proj.dir.display());
    }
    cache_move_dir(root, &proj.dir, None);
    Ok(())
}

pub fn move_file_in(root: &Path, id: &str, project_id: Option<&str>) -> Result<(), String> {
    check_id(id)?;
    let src = resolve(root, id).ok_or_else(|| format!("file {id:?} not found"))?;
    let dir = project_dir_for(root, project_id)?;
    let dest = file_path(&dir, id);
    if src == dest {
        return Ok(());
    }
    if dest.exists() {
        return Err(format!("{} already exists", dest.display()));
    }
    fs::rename(&src, &dest).map_err(|e| format!("cannot move {id}: {e}"))?;
    cache_set(root, id, &dir);
    Ok(())
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("background task failed: {e}"))?
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_files<R: Runtime>(app: AppHandle<R>) -> Result<Vec<FileMeta>, String> {
    let dir = files_dir(&app)?;
    blocking(move || list_in(&dir)).await
}

#[tauri::command]
pub async fn load_file<R: Runtime>(app: AppHandle<R>, id: String) -> Result<Option<Value>, String> {
    let dir = files_dir(&app)?;
    blocking(move || load_in(&dir, &id)).await
}

#[tauri::command]
pub async fn save_file<R: Runtime>(
    app: AppHandle<R>,
    doc: Value,
    project_id: Option<String>,
) -> Result<(), String> {
    let dir = files_dir(&app)?;
    blocking(move || save_in(&dir, &doc, project_id.as_deref())).await
}

#[tauri::command]
pub async fn delete_file<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    let dir = files_dir(&app)?;
    blocking(move || delete_in(&dir, &id)).await
}

#[tauri::command]
pub async fn list_projects<R: Runtime>(app: AppHandle<R>) -> Result<Vec<ProjectMeta>, String> {
    let dir = files_dir(&app)?;
    blocking(move || list_projects_in(&dir)).await
}

#[tauri::command]
pub async fn create_project<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    color: Option<String>,
) -> Result<ProjectMeta, String> {
    let dir = files_dir(&app)?;
    blocking(move || create_project_in(&dir, &name, color.as_deref())).await
}

#[tauri::command]
pub async fn update_project<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    name: Option<String>,
    color: Option<String>,
) -> Result<ProjectMeta, String> {
    let dir = files_dir(&app)?;
    blocking(move || update_project_in(&dir, &id, name.as_deref(), color.as_deref())).await
}

#[tauri::command]
pub async fn remove_project<R: Runtime>(app: AppHandle<R>, id: String, mode: String) -> Result<(), String> {
    let dir = files_dir(&app)?;
    blocking(move || remove_project_in(&dir, &id, &mode)).await
}

#[tauri::command]
pub async fn move_file<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    project_id: Option<String>,
) -> Result<(), String> {
    let dir = files_dir(&app)?;
    blocking(move || move_file_in(&dir, &id, project_id.as_deref())).await
}

#[tauri::command]
pub async fn list_trash<R: Runtime>(app: AppHandle<R>) -> Result<Vec<TrashItem>, String> {
    let dir = files_dir(&app)?;
    blocking(move || list_trash_in(&dir)).await
}

#[tauri::command]
pub async fn restore_trash<R: Runtime>(app: AppHandle<R>, trash_id: String) -> Result<(), String> {
    let dir = files_dir(&app)?;
    blocking(move || restore_trash_in(&dir, &trash_id).map(|_| ())).await
}

#[tauri::command]
pub async fn purge_trash<R: Runtime>(app: AppHandle<R>, trash_id: Option<String>) -> Result<(), String> {
    let dir = files_dir(&app)?;
    blocking(move || purge_trash_in(&dir, trash_id.as_deref())).await
}

#[tauri::command]
pub async fn list_versions<R: Runtime>(app: AppHandle<R>, file_id: String) -> Result<Vec<VersionMeta>, String> {
    let dir = files_dir(&app)?;
    blocking(move || list_versions_in(&dir, &file_id)).await
}

/// `doc` is the open document (newer than the saved file while an autosave is pending); without
/// it the file as saved is kept. A null name makes an automatic version.
#[tauri::command]
pub async fn save_version<R: Runtime>(
    app: AppHandle<R>,
    file_id: String,
    name: Option<String>,
    doc: Option<Value>,
) -> Result<VersionMeta, String> {
    let dir = files_dir(&app)?;
    blocking(move || save_version_in(&dir, &file_id, name.as_deref(), doc.as_ref())).await
}

#[tauri::command]
pub async fn load_version<R: Runtime>(app: AppHandle<R>, file_id: String, version_id: String) -> Result<Option<Value>, String> {
    let dir = files_dir(&app)?;
    blocking(move || load_version_in(&dir, &file_id, &version_id)).await
}

#[tauri::command]
pub async fn delete_version<R: Runtime>(app: AppHandle<R>, file_id: String, version_id: String) -> Result<(), String> {
    let dir = files_dir(&app)?;
    blocking(move || delete_version_in(&dir, &file_id, &version_id)).await
}

#[tauri::command]
pub async fn restore_version<R: Runtime>(app: AppHandle<R>, file_id: String, version_id: String) -> Result<Value, String> {
    let dir = files_dir(&app)?;
    blocking(move || restore_version_in(&dir, &file_id, &version_id)).await
}

#[tauri::command]
pub async fn reveal_files_folder<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let dir = files_dir(&app)?;
    let mut child = reveal_command(&dir).spawn().map_err(|e| {
        let hint = if cfg!(target_os = "linux") { " (is xdg-utils installed?)" } else { "" };
        format!("cannot open {}: {e}{hint}", dir.display())
    })?;
    // wait for it off-thread so it doesn't linger as a zombie
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Finder on macOS, Explorer (with the folder selected) on Windows, the file manager via
/// `xdg-open` elsewhere.
fn reveal_command(dir: &Path) -> std::process::Command {
    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        cmd.arg(dir);
        cmd
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // Explorer parses `/select,"<path>"` itself, so it is passed verbatim; a Windows path
        // can't contain `"`.
        let mut cmd = std::process::Command::new("explorer");
        cmd.raw_arg(format!("/select,\"{}\"", dir.display()));
        cmd
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let mut cmd = std::process::Command::new("xdg-open");
        cmd.arg(dir);
        cmd
    }
}

#[tauri::command]
pub async fn export_to_folder<R: Runtime>(
    app: AppHandle<R>,
    files: Vec<ExportFile>,
) -> Result<Option<String>, String> {
    // Validate every path (and decode every image) before asking the user for anything.
    let checked = prepare_export(files)?;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Export to folder")
        .pick_folder(move |picked| {
            let _ = tx.send(picked);
        });
    let Some(picked) = rx.await.map_err(|_| "folder picker closed unexpectedly".to_string())? else {
        return Ok(None);
    };
    let root = picked.into_path().map_err(|e| format!("invalid folder: {e}"))?;

    let root2 = root.clone();
    blocking(move || {
        for (rel, contents) in checked {
            let target = root2.join(rel);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
            }
            fs::write(&target, contents)
                .map_err(|e| format!("cannot write {}: {e}", target.display()))?;
        }
        Ok(())
    })
    .await?;
    Ok(Some(root.to_string_lossy().into_owned()))
}

/// Each export file as a safe relative path and the bytes to write.
fn prepare_export(files: Vec<ExportFile>) -> Result<Vec<(PathBuf, Vec<u8>)>, String> {
    files
        .into_iter()
        .map(|f| {
            let path = safe_relative_path(&f.path)?;
            let bytes = if f.base64 {
                decode_base64(&f.contents).map_err(|e| format!("{}: {e}", f.path))?
            } else {
                f.contents.into_bytes()
            };
            Ok((path, bytes))
        })
        .collect()
}

/// Standard or URL-safe base64, padding optional, whitespace ignored.
fn decode_base64(s: &str) -> Result<Vec<u8>, String> {
    fn value(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a') as u32 + 26),
            b'0'..=b'9' => Some((c - b'0') as u32 + 52),
            b'+' | b'-' => Some(62),
            b'/' | b'_' => Some(63),
            _ => None,
        }
    }
    let bytes: Vec<u8> = s.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    let body = bytes
        .strip_suffix(b"==")
        .or_else(|| bytes.strip_suffix(b"="))
        .unwrap_or(&bytes);
    if body.len() % 4 == 1 {
        return Err("invalid base64 length".into());
    }
    let mut out = Vec::with_capacity(body.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for &c in body {
        let v = value(c).ok_or_else(|| format!("invalid base64 character {:?}", c as char))?;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kiln-test-{}", gen_id("t")));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn doc(id: &str, name: &str, updated: u64) -> Value {
        json!({"id": id, "name": name, "updatedAt": updated, "pages": []})
    }

    fn ids(list: &[FileMeta]) -> Vec<&str> {
        list.iter().map(|m| m.id.as_str()).collect()
    }

    fn pid_of<'a>(list: &'a [FileMeta], id: &str) -> Option<&'a str> {
        list.iter().find(|m| m.id == id).unwrap().project_id.as_deref()
    }

    #[test]
    fn id_validation() {
        assert!(is_valid_id("abc_DEF-123"));
        assert!(is_valid_id("V1StGXR8_Z5jdHi6B-myT"));
        for bad in ["", "../etc", "a/b", "a.b", "a b", "..", "a\\b", "é", "a\0"] {
            assert!(!is_valid_id(bad), "{bad:?} should be rejected");
        }
        assert!(!is_valid_id(&"a".repeat(129)));
        assert!(is_valid_id(&gen_id("p")));
    }

    #[test]
    fn export_paths() {
        assert_eq!(safe_relative_path("index.html").unwrap(), PathBuf::from("index.html"));
        assert_eq!(safe_relative_path("./assets/a.css").unwrap(), PathBuf::from("assets/a.css"));
        for bad in ["", "/etc/passwd", "../x", "a/../../x", "a\\..\\x", ".", "a/.."] {
            assert!(safe_relative_path(bad).is_err(), "{bad:?} should be rejected");
        }
        // Windows' rules apply only there
        for ok in ["assets/a.css", "con-tact/index.html", "a.b/c"] {
            assert!(safe_relative_path_for(ok, true).is_ok(), "{ok:?}");
        }
        for bad in ["a:b.txt", "assets/x:stream", "con", "assets/NUL.css", "Com1.txt", "dir./x", "x ", "a?b", "a|b", "a\"b"] {
            assert!(safe_relative_path_for(bad, true).is_err(), "{bad:?} should be rejected on Windows");
        }
        // on a Windows host "a:" parses as a drive prefix whatever the flag says, so check it elsewhere only
        if cfg!(not(windows)) {
            assert!(safe_relative_path_for("a:b.txt", false).is_ok(), "unchanged on macOS and Linux");
        }
    }

    #[test]
    fn base64_decoding() {
        let d = |s: &str| decode_base64(s).unwrap();
        assert_eq!(d(""), b"");
        assert_eq!(d("Zg=="), b"f");
        assert_eq!(d("Zm8="), b"fo");
        assert_eq!(d("Zm9v"), b"foo");
        assert_eq!(d("Zm9vYg"), b"foob"); // padding left off
        assert_eq!(d("SGVs\nbG8s IEtp bG4h"), b"Hello, Kiln!");
        assert_eq!(d("+/+/"), [0xfb, 0xff, 0xbf]);
        assert_eq!(d("-_-_"), [0xfb, 0xff, 0xbf]); // URL-safe alphabet
        // a real PNG header survives the round trip
        assert_eq!(d("iVBORw0KGgo="), [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
        for bad in ["Z", "Zm9vY", "Zm*v", "Zg==Zg==", "data:image/png;base64,Zg=="] {
            assert!(decode_base64(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn export_files_decode_images_and_keep_text() {
        let file = |path: &str, contents: &str, base64: bool| ExportFile { path: path.into(), contents: contents.into(), base64 };
        let out = prepare_export(vec![file("Card@2x.png", "iVBORw0KGgo=", true), file("index.html", "<p>hi</p>", false)]).unwrap();
        assert_eq!(out[0], (PathBuf::from("Card@2x.png"), vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]));
        assert_eq!(out[1], (PathBuf::from("index.html"), b"<p>hi</p>".to_vec()));
        // an old caller that sends no flag still writes text
        let old: ExportFile = serde_json::from_value(json!({"path": "a.css", "contents": "b{}"})).unwrap();
        assert!(!old.base64);
        // bad paths and bad base64 fail before anything is written
        assert!(prepare_export(vec![file("../x.png", "Zg==", true)]).is_err());
        let err = prepare_export(vec![file("ok.txt", "x", false), file("broken.png", "Zm*v", true)]).unwrap_err();
        assert!(err.contains("broken.png"), "{err}");
    }

    #[test]
    fn documents_fall_back_to_home() {
        let (docs, home) = (Some(PathBuf::from("/d/Docs")), Some(PathBuf::from("/h")));
        assert_eq!(documents_or_home(docs.clone(), home.clone()), docs);
        assert_eq!(documents_or_home(None, home.clone()), Some(Path::new("/h").join("Documents")));
        assert_eq!(documents_or_home(Some(PathBuf::new()), home), Some(Path::new("/h").join("Documents")));
        assert_eq!(documents_or_home(None, None), None);
    }

    #[test]
    fn windows_folder_names() {
        let w = |s: &str| sanitize_folder_name_for(s, true);
        assert_eq!(w("Client <Acme> | \"Q3\"?*"), "Client Acme  Q3");
        assert_eq!(w("Ends with dots..."), "Ends with dots");
        assert_eq!(w("con"), "_con");
        assert_eq!(w("LPT1.final"), "_LPT1.final");
        assert_eq!(w("console"), "console");
        assert_eq!(w("***"), UNTITLED_PROJECT);
        // macOS and Linux keep what they allow
        assert_eq!(sanitize_folder_name_for("Client <Acme>?", false), "Client <Acme>?");
        assert_eq!(sanitize_folder_name_for("con", false), "con");
        assert!(is_windows_reserved("aux.txt") && is_windows_reserved("COM9") && !is_windows_reserved("COM0") && !is_windows_reserved("com10"));
    }

    #[test]
    fn save_list_load_delete_roundtrip() {
        let dir = temp_root();

        save_in(&dir, &json!({"id": "old", "name": "Old", "updatedAt": 1, "pages": []}), None).unwrap();
        save_in(&dir, &json!({"id": "new", "name": "New", "updatedAt": 5, "thumbnail": "data:x"}), None).unwrap();
        fs::write(dir.join("broken.kiln"), b"{nope").unwrap();
        assert!(save_in(&dir, &json!({"id": "../escape"}), None).is_err());
        assert!(save_in(&dir, &json!({"name": "no id"}), None).is_err());

        let list = list_in(&dir).unwrap();
        assert_eq!(ids(&list), ["new", "old"]);
        assert_eq!(list[0].thumbnail.as_deref(), Some("data:x"));
        let meta = serde_json::to_value(&list[0]).unwrap();
        assert_eq!(meta["updatedAt"], json!(5));
        assert_eq!(meta["projectId"], Value::Null);

        assert_eq!(load_in(&dir, "old").unwrap().unwrap()["name"], "Old");
        assert!(load_in(&dir, "missing").unwrap().is_none());
        assert!(load_in(&dir, "../x").is_err());

        delete_in(&dir, "old").unwrap();
        assert!(load_in(&dir, "old").unwrap().is_none());
        let trash = list_trash_in(&dir).unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].id, "old");
        assert_eq!(trash[0].project_id, None);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn sanitize_and_unique_folder_names() {
        assert_eq!(sanitize_folder_name("a/b:c"), "abc");
        assert_eq!(sanitize_folder_name("a\\b\0c\n"), "abc");
        assert_eq!(sanitize_folder_name("..hidden"), "hidden");
        assert_eq!(sanitize_folder_name("  . spaced  "), "spaced");
        assert_eq!(sanitize_folder_name(""), UNTITLED_PROJECT);
        assert_eq!(sanitize_folder_name("../.."), UNTITLED_PROJECT);
        let long = "é".repeat(200);
        assert_eq!(sanitize_folder_name(&long).chars().count(), MAX_FOLDER_CHARS);

        let root = temp_root();
        fs::create_dir(root.join("Work")).unwrap();
        assert_eq!(unique_folder_name(&root, "Work", None), "Work 2");
        assert_eq!(unique_folder_name(&root, "work", None), "work 2");
        fs::create_dir(root.join("work 2")).unwrap();
        assert_eq!(unique_folder_name(&root, "Work", None), "Work 3");
        assert_eq!(unique_folder_name(&root, "Work", Some("Work")), "Work");
        assert_eq!(unique_folder_name(&root, "Other", None), "Other");

        let a = create_project_in(&root, "Work", None).unwrap();
        assert_eq!(a.color, DEFAULT_COLOR);
        assert!(root.join("Work 3").join(PROJECT_FILE).is_file());
        let b = create_project_in(&root, " a/b:c ", Some("#00ff00")).unwrap();
        assert_eq!(b.name, "a/b:c");
        assert!(root.join("abc").is_dir());
        assert_ne!(a.id, b.id);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn project_save_load_move_rename() {
        let root = temp_root();
        let p = create_project_in(&root, "Client", None).unwrap();
        // A folder without project.json and a dot-folder are ignored.
        fs::create_dir(root.join("Random")).unwrap();
        fs::write(root.join("Random").join("x.kiln"), serde_json::to_vec(&doc("x", "X", 1)).unwrap()).unwrap();

        save_in(&root, &doc("f1", "One", 10), Some(&p.id)).unwrap();
        save_in(&root, &doc("f2", "Two", 20), None).unwrap();
        assert!(save_in(&root, &doc("f3", "Three", 1), Some("nope")).is_err());
        assert!(root.join("Client").join("f1.kiln").is_file());

        let list = list_in(&root).unwrap();
        assert_eq!(ids(&list), ["f2", "f1"]);
        assert_eq!(pid_of(&list, "f1"), Some(p.id.as_str()));
        assert_eq!(pid_of(&list, "f2"), None);
        assert_eq!(load_in(&root, "f1").unwrap().unwrap()["name"], "One");

        // Saving an existing file writes in place regardless of project_id.
        save_in(&root, &doc("f1", "One v2", 30), None).unwrap();
        assert!(!root.join("f1.kiln").exists());
        let projects = list_projects_in(&root).unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].file_count, 1);
        assert_eq!(projects[0].updated_at, serde_json::Number::from(30));

        // Move between project and drafts.
        move_file_in(&root, "f1", None).unwrap();
        assert!(root.join("f1.kiln").is_file());
        assert_eq!(pid_of(&list_in(&root).unwrap(), "f1"), None);
        move_file_in(&root, "f1", None).unwrap(); // no-op
        move_file_in(&root, "f2", Some(&p.id)).unwrap();
        assert_eq!(pid_of(&list_in(&root).unwrap(), "f2"), Some(p.id.as_str()));
        assert!(move_file_in(&root, "missing", None).is_err());
        assert!(move_file_in(&root, "f1", Some("nope")).is_err());
        let projects = list_projects_in(&root).unwrap();
        assert_eq!(projects[0].updated_at, serde_json::Number::from(20));

        // Rename moves the folder; files still resolve.
        let renamed = update_project_in(&root, &p.id, Some("Client: Acme"), Some("#123456")).unwrap();
        assert_eq!(renamed.name, "Client: Acme");
        assert_eq!(renamed.color, "#123456");
        assert!(!root.join("Client").exists());
        assert!(root.join("Client Acme").join("f2.kiln").is_file());
        assert_eq!(load_in(&root, "f2").unwrap().unwrap()["name"], "Two");
        save_in(&root, &doc("f2", "Two v2", 40), None).unwrap();
        assert!(root.join("Client Acme").join("f2.kiln").is_file());
        assert_eq!(pid_of(&list_in(&root).unwrap(), "f2"), Some(p.id.as_str()));
        // Color-only update keeps the folder.
        update_project_in(&root, &p.id, None, Some("#000000")).unwrap();
        assert!(root.join("Client Acme").is_dir());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn trash_lists_from_sidecars_without_reading_documents() {
        let root = temp_root();
        let mut d = doc("big", "Big file", 5);
        d["thumbnail"] = json!("data:image/png;base64,AAAA");
        save_in(&root, &d, None).unwrap();
        list_in(&root).unwrap(); // the index now knows the file
        delete_in(&root, "big").unwrap();
        // make the trashed document unreadable: listing must not need it
        let item = list_trash_in(&root).unwrap().remove(0);
        fs::write(file_path(&trash_dir(&root), &item.trash_id), b"{not json").unwrap();
        let again = list_trash_in(&root).unwrap();
        assert_eq!((again[0].id.as_str(), again[0].name.as_str()), ("big", "Big file"));
        assert_eq!(again[0].thumbnail.as_deref(), Some("data:image/png;base64,AAAA"));

        // a sidecar from before names were stored: read once, then remembered
        let trash = trash_dir(&root);
        fs::write(file_path(&trash, "old-1700000000000"), serde_json::to_vec(&doc("old", "Old one", 1)).unwrap()).unwrap();
        fs::write(trash.join("old-1700000000000.json"), br#"{"projectId":null,"deletedAt":1700000000000}"#).unwrap();
        let listed = list_trash_in(&root).unwrap();
        let old = listed.iter().find(|t| t.id == "old").unwrap();
        assert_eq!((old.name.as_str(), old.deleted_at), ("Old one", 1700000000000));
        let side = read_sidecar(&trash.join("old-1700000000000.json")).unwrap();
        assert_eq!(side.name.as_deref(), Some("Old one"));
        // restore still finds its way back
        let restored = restore_trash_in(&root, "old-1700000000000").unwrap();
        assert_eq!(load_in(&root, &restored).unwrap().unwrap()["name"], "Old one");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_older_save_never_overwrites_a_newer_one() {
        let root = temp_root();
        save_in(&root, &doc("race", "Newer", 200), None).unwrap();
        save_in(&root, &doc("race", "Older", 100), None).unwrap(); // lost the race
        assert_eq!(load_in(&root, "race").unwrap().unwrap()["name"], "Newer");
        save_in(&root, &doc("race", "Same time", 200), None).unwrap(); // a flush of the same edit
        save_in(&root, &doc("race", "Latest", 300), None).unwrap();
        assert_eq!(load_in(&root, "race").unwrap().unwrap()["name"], "Latest");
        // deleted and restored: its older timestamp saves again
        delete_in(&root, "race").unwrap();
        let tid = list_trash_in(&root).unwrap().remove(0).trash_id;
        restore_trash_in(&root, &tid).unwrap();
        save_in(&root, &doc("race", "After restore", 250), None).unwrap();
        assert_eq!(load_in(&root, "race").unwrap().unwrap()["name"], "After restore");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn trash_restore_purge() {
        let root = temp_root();
        let p = create_project_in(&root, "Temp", None).unwrap();
        save_in(&root, &doc("a", "A", 1), Some(&p.id)).unwrap();
        delete_in(&root, "a").unwrap();
        let trash = list_trash_in(&root).unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].project_id.as_deref(), Some(p.id.as_str()));
        assert!(trash[0].deleted_at > 0);

        // The project is gone, so restore lands in Drafts.
        remove_project_in(&root, &p.id, "keep-files").unwrap();
        restore_trash_in(&root, &trash[0].trash_id).unwrap();
        assert!(root.join("a.kiln").is_file());
        assert!(list_trash_in(&root).unwrap().is_empty());
        assert_eq!(fs::read_dir(root.join(TRASH)).unwrap().count(), 0);

        // Restoring into an existing project goes back to its folder.
        let q = create_project_in(&root, "Keep", None).unwrap();
        save_in(&root, &doc("b", "B", 1), Some(&q.id)).unwrap();
        delete_in(&root, "b").unwrap();
        let tid = list_trash_in(&root).unwrap()[0].trash_id.clone();
        restore_trash_in(&root, &tid).unwrap();
        assert!(root.join("Keep").join("b.kiln").is_file());

        // Restoring when the id already exists gives a new id.
        delete_in(&root, "a").unwrap();
        save_in(&root, &doc("a", "A again", 2), None).unwrap();
        let tid = list_trash_in(&root).unwrap()[0].trash_id.clone();
        let new_id = restore_trash_in(&root, &tid).unwrap();
        assert_ne!(new_id, "a");
        assert_eq!(load_in(&root, &new_id).unwrap().unwrap()["id"], json!(new_id));
        assert_eq!(load_in(&root, "a").unwrap().unwrap()["name"], "A again");
        assert!(restore_trash_in(&root, &tid).is_err());
        assert!(restore_trash_in(&root, "../x").is_err());

        // Purge one, then all.
        delete_in(&root, "a").unwrap();
        delete_in(&root, "b").unwrap();
        let items = list_trash_in(&root).unwrap();
        assert_eq!(items.len(), 2);
        purge_trash_in(&root, Some(&items[0].trash_id)).unwrap();
        assert_eq!(list_trash_in(&root).unwrap().len(), 1);
        assert!(!root.join(TRASH).join(format!("{}.json", items[0].trash_id)).exists());
        purge_trash_in(&root, None).unwrap();
        assert!(list_trash_in(&root).unwrap().is_empty());
        purge_trash_in(&root, None).unwrap();
        assert!(purge_trash_in(&root, Some("a/b")).is_err());

        // deletedAt falls back to the stem suffix without a sidecar.
        fs::create_dir_all(root.join(TRASH)).unwrap();
        fs::write(root.join(TRASH).join("z-1234.kiln"), serde_json::to_vec(&doc("z", "Z", 1)).unwrap()).unwrap();
        fs::write(root.join(TRASH).join("bad-1.kiln"), b"{nope").unwrap();
        let items = list_trash_in(&root).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].deleted_at, 1234);
        assert_eq!(items[0].project_id, None);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn list_survives_corrupt_index_and_uses_cache() {
        let root = temp_root();
        let p = create_project_in(&root, "P", None).unwrap();
        save_in(&root, &doc("a", "A", 1), None).unwrap();
        save_in(&root, &doc("b", "B", 2), Some(&p.id)).unwrap();
        fs::write(root.join(INDEX), b"{corrupt").unwrap();
        let list = list_in(&root).unwrap();
        assert_eq!(ids(&list), ["b", "a"]);
        let index = read_index(&root);
        assert!(index.contains_key("a"));
        assert!(index.contains_key("P/b"));

        // Unchanged files come from the index (proved by editing the index only).
        let mut idx: Value = serde_json::from_slice(&fs::read(root.join(INDEX)).unwrap()).unwrap();
        idx["a"]["name"] = json!("Cached");
        fs::write(root.join(INDEX), serde_json::to_vec(&idx).unwrap()).unwrap();
        let list = list_in(&root).unwrap();
        assert_eq!(list.iter().find(|m| m.id == "a").unwrap().name, "Cached");

        // A changed file is re-parsed.
        save_in(&root, &doc("a", "Changed name", 3), None).unwrap();
        let list = list_in(&root).unwrap();
        assert_eq!(list.iter().find(|m| m.id == "a").unwrap().name, "Changed name");

        fs::remove_file(root.join(INDEX)).unwrap();
        assert_eq!(list_in(&root).unwrap().len(), 2);
        assert!(root.join(INDEX).is_file());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn remove_project_modes() {
        let root = temp_root();
        let p = create_project_in(&root, "Keep me", None).unwrap();
        save_in(&root, &doc("x", "X in project", 1), Some(&p.id)).unwrap();
        save_in(&root, &doc("y", "Y", 1), Some(&p.id)).unwrap();
        // Collides with a top-level draft of the same id (written directly).
        fs::write(root.join("x.kiln"), serde_json::to_vec(&doc("x", "X draft", 1)).unwrap()).unwrap();
        assert!(remove_project_in(&root, &p.id, "bogus").is_err());
        remove_project_in(&root, &p.id, "keep-files").unwrap();
        assert!(!root.join("Keep me").exists());
        let list = list_in(&root).unwrap();
        assert_eq!(list.len(), 3);
        assert!(list.iter().all(|m| m.project_id.is_none()));
        let moved = list.iter().find(|m| m.name == "X in project").unwrap();
        assert_ne!(moved.id, "x");
        assert!(root.join(format!("{}.kiln", moved.id)).is_file());
        assert_eq!(load_in(&root, "x").unwrap().unwrap()["name"], "X draft");
        assert!(list_projects_in(&root).unwrap().is_empty());

        let q = create_project_in(&root, "Trash me", None).unwrap();
        save_in(&root, &doc("t1", "T1", 1), Some(&q.id)).unwrap();
        save_in(&root, &doc("t2", "T2", 1), Some(&q.id)).unwrap();
        remove_project_in(&root, &q.id, "trash-files").unwrap();
        assert!(!root.join("Trash me").exists());
        let trash = list_trash_in(&root).unwrap();
        assert_eq!(trash.len(), 2);
        assert!(trash.iter().all(|t| t.project_id.as_deref() == Some(q.id.as_str())));
        assert!(load_in(&root, "t1").unwrap().is_none());
        assert!(remove_project_in(&root, &q.id, "keep-files").is_err());

        // The user's own files in a project folder survive: the folder stays, as a plain folder.
        let r = create_project_in(&root, "Has notes", None).unwrap();
        save_in(&root, &doc("n1", "N1", 1), Some(&r.id)).unwrap();
        fs::write(root.join("Has notes").join("notes.txt"), b"mine").unwrap();
        fs::write(root.join("Has notes").join(".DS_Store"), b"").unwrap();
        remove_project_in(&root, &r.id, "keep-files").unwrap();
        assert_eq!(fs::read(root.join("Has notes").join("notes.txt")).unwrap(), b"mine");
        assert!(!root.join("Has notes").join(PROJECT_FILE).exists());
        assert!(list_projects_in(&root).unwrap().is_empty());
        assert!(root.join("n1.kiln").is_file());

        fs::remove_dir_all(&root).unwrap();
    }

    const MIN: u64 = 60_000;
    const T0: u64 = 1_700_000_000_000;

    fn names(list: &[VersionMeta]) -> Vec<Option<&str>> {
        list.iter().map(|v| v.name.as_deref()).collect()
    }

    #[test]
    fn versions_save_list_load_delete() {
        let root = temp_root();
        // the first save of a file is kept as an automatic version
        save_in_at(&root, &doc("f", "First", 1), None, T0).unwrap();
        let list = list_versions_in(&root, "f").unwrap();
        assert_eq!(names(&list), [None]);
        assert_eq!(list[0].file_id, "f");
        assert_eq!(list[0].created_at, T0);
        assert!(list[0].size > 0);

        // named: the open document when given, else the file as saved; newest first
        let mut open = doc("f", "Open, unsaved", 2);
        open["thumbnail"] = json!("data:image/png;base64,AAAA");
        let named = save_version_at(&root, "f", Some("  Before the redesign  "), Some(&open), T0 + MIN).unwrap();
        assert_eq!(named.name.as_deref(), Some("Before the redesign"));
        assert_eq!(named.thumbnail.as_deref(), Some("data:image/png;base64,AAAA"));
        let from_disk = save_version_at(&root, "f", Some("Saved"), None, T0 + 2 * MIN).unwrap();
        assert_eq!(names(&list_versions_in(&root, "f").unwrap()), [Some("Saved"), Some("Before the redesign"), None]);
        assert_eq!(load_version_in(&root, "f", &named.version_id).unwrap().unwrap()["name"], "Open, unsaved");
        assert_eq!(load_version_in(&root, "f", &from_disk.version_id).unwrap().unwrap()["name"], "First");
        // a blank name is an automatic version
        assert_eq!(save_version_at(&root, "f", Some("  "), None, T0 + 3 * MIN).unwrap().name, None);

        // a version listed without its meta file is still there
        fs::remove_file(versions_dir(&root, "f").join(format!("{}.json", named.version_id))).unwrap();
        let again = list_versions_in(&root, "f").unwrap();
        let bare = again.iter().find(|v| v.version_id == named.version_id).unwrap();
        assert_eq!((bare.name.as_deref(), bare.created_at), (Some("Untitled version"), T0 + MIN));

        delete_version_in(&root, "f", &named.version_id).unwrap();
        delete_version_in(&root, "f", &named.version_id).unwrap(); // already gone: fine
        assert_eq!(list_versions_in(&root, "f").unwrap().len(), 3);
        assert_eq!(load_version_in(&root, "f", &named.version_id).unwrap(), None);

        // bad input
        assert!(save_version_at(&root, "f", Some("x"), Some(&doc("other", "O", 1)), T0).is_err());
        assert!(save_version_in(&root, "missing", Some("x"), None).is_err());
        for bad in ["../f", "a/b", ""] {
            assert!(list_versions_in(&root, bad).is_err());
            assert!(load_version_in(&root, "f", bad).is_err());
            assert!(delete_version_in(&root, bad, &from_disk.version_id).is_err());
        }
        assert!(load_version_in(&root, "f", "x123-1").is_err()); // not a version id
        assert!(list_versions_in(&root, "never-saved").unwrap().is_empty());
        // versions never show up as files or projects
        assert_eq!(ids(&list_in(&root).unwrap()), ["f"]);
        assert!(list_projects_in(&root).unwrap().is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn timed_snapshots_every_ten_minutes() {
        let root = temp_root();
        save_in_at(&root, &doc("t", "T", 1), None, T0).unwrap();
        save_in_at(&root, &doc("t", "T", 2), None, T0 + 5 * MIN).unwrap();
        save_in_at(&root, &doc("t", "T", 3), None, T0 + 9 * MIN).unwrap();
        assert_eq!(list_versions_in(&root, "t").unwrap().len(), 1);
        save_in_at(&root, &doc("t", "T", 4), None, T0 + 10 * MIN).unwrap();
        let list = list_versions_in(&root, "t").unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(load_version_in(&root, "t", &list[0].version_id).unwrap().unwrap()["updatedAt"], 4);
        // a named version doesn't reset the clock
        save_version_at(&root, "t", Some("Named"), None, T0 + 15 * MIN).unwrap();
        save_in_at(&root, &doc("t", "T", 5), None, T0 + 20 * MIN).unwrap();
        assert_eq!(list_versions_in(&root, "t").unwrap().iter().filter(|v| v.name.is_none()).count(), 3);
        // a save that lost the race to a newer one keeps no version either
        save_in_at(&root, &doc("t", "T", 1), None, T0 + 60 * MIN).unwrap();
        assert_eq!(list_versions_in(&root, "t").unwrap().len(), 4);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn pruning_keeps_recent_autos_one_per_day_and_every_named() {
        let hour = 60 * MIN;
        let now = T0 - T0 % DAY_MS + 23 * hour; // late in a day, so "today" holds 24 hourly autos
        // pure rule: 3 recent, then the newest of each day within 2 days
        let autos: Vec<(String, u64)> = (0..72).map(|h| (format!("a{h}"), now - h * hour)).collect();
        let drop = autos_to_prune(&autos, now, 3, 2);
        let kept: Vec<&str> = autos.iter().map(|(id, _)| id.as_str()).filter(|id| !drop.iter().any(|d| d == id)).collect();
        // a0..a2 recent; a0 is also today's keeper; yesterday's newest is a24; the day before is out of the window
        assert_eq!(kept, ["a0", "a1", "a2", "a24"]);

        // on disk: 50 days of autos, 4 a day, and named versions as old as the oldest
        let root = temp_root();
        save_in_at(&root, &doc("p", "P", 1), None, now).unwrap();
        for d in 0..50u64 {
            for q in 0..4u64 {
                save_version_at(&root, "p", None, None, now - d * DAY_MS - q * 6 * hour - 1).unwrap();
            }
        }
        save_version_at(&root, "p", Some("Old but named"), None, now - 49 * DAY_MS).unwrap();
        // each save above pruned as of its own time; now prune as of today
        prune_versions(&root, "p", now);
        let list = list_versions_in(&root, "p").unwrap();
        let autos: Vec<&VersionMeta> = list.iter().filter(|v| v.name.is_none()).collect();
        // 30 newest (the save plus 29 more, covering days 0..7), plus one for each of days 8..29
        assert_eq!(autos.len(), 30 + 22);
        assert!(autos.iter().all(|v| now - v.created_at < KEEP_DAYS * DAY_MS));
        assert!(list.iter().any(|v| v.name.as_deref() == Some("Old but named")));
        // every pruned version is gone from disk too, meta and all
        let files = fs::read_dir(versions_dir(&root, "p")).unwrap().count();
        assert_eq!(files, 2 * list.len());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn restore_version_keeps_the_file_and_its_id() {
        let root = temp_root();
        let p = create_project_in(&root, "Work", None).unwrap();
        save_in_at(&root, &doc("r", "Draft one", 100), Some(&p.id), T0).unwrap();
        let v1 = save_version_at(&root, "r", Some("One"), None, T0 + MIN).unwrap();
        save_in_at(&root, &doc("r", "Draft two", 200), None, T0 + 2 * MIN).unwrap();

        let restored = restore_version_in(&root, "r", &v1.version_id).unwrap();
        assert_eq!(restored["name"], "Draft one");
        assert_eq!(restored["id"], "r");
        let on_disk = load_in(&root, "r").unwrap().unwrap();
        assert_eq!(on_disk["name"], "Draft one");
        assert!(on_disk["updatedAt"].as_u64().unwrap() > 200);
        // still in its project, and what it replaced was kept as an automatic version
        assert!(root.join("Work").join("r.kiln").is_file());
        let list = list_versions_in(&root, "r").unwrap();
        let before = list.iter().find(|v| v.name.is_none() && v.created_at > T0 + MIN).unwrap();
        assert_eq!(load_version_in(&root, "r", &before.version_id).unwrap().unwrap()["name"], "Draft two");
        // an older autosave still in flight doesn't overwrite the restore
        save_in(&root, &doc("r", "Draft two", 200), None).unwrap();
        assert_eq!(load_in(&root, "r").unwrap().unwrap()["name"], "Draft one");

        assert!(restore_version_in(&root, "r", "n1-1").is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn trash_keeps_versions_and_purge_removes_them() {
        let root = temp_root();
        for id in ["k", "g"] {
            save_in(&root, &doc(id, id, 1), None).unwrap();
            save_version_in(&root, id, Some("Named"), None).unwrap();
        }
        delete_in(&root, "k").unwrap();
        delete_in(&root, "g").unwrap();
        assert_eq!(list_versions_in(&root, "k").unwrap().len(), 2);
        let trash = list_trash_in(&root).unwrap();
        let k = trash.iter().find(|t| t.id == "k").unwrap().trash_id.clone();
        // restored and deleted again: purging one of two "k" entries keeps the versions
        restore_trash_in(&root, &k).unwrap();
        delete_in(&root, "k").unwrap();
        save_in(&root, &doc("k", "k again", 2), None).unwrap();
        delete_in(&root, "k").unwrap();
        let ks: Vec<String> = list_trash_in(&root).unwrap().into_iter().filter(|t| t.id == "k").map(|t| t.trash_id).collect();
        assert_eq!(ks.len(), 2);
        purge_trash_in(&root, Some(&ks[0])).unwrap();
        assert!(!list_versions_in(&root, "k").unwrap().is_empty());
        purge_trash_in(&root, Some(&ks[1])).unwrap();
        assert!(list_versions_in(&root, "k").unwrap().is_empty());
        assert!(!versions_dir(&root, "k").exists());

        // a live file by the same id keeps them through purge-all
        save_in(&root, &doc("g", "g is back", 3), None).unwrap();
        purge_trash_in(&root, None).unwrap();
        assert!(!list_versions_in(&root, "g").unwrap().is_empty());
        delete_in(&root, "g").unwrap();
        purge_trash_in(&root, None).unwrap();
        assert!(list_versions_in(&root, "g").unwrap().is_empty());
        fs::remove_dir_all(&root).unwrap();
    }
}
