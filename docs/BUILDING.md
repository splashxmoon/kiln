# Building Kiln

Kiln is a Vite + React front end inside a [Tauri 2](https://tauri.app) shell (Rust, in `src-tauri/`).
The same code builds for macOS, Windows and Linux. Each OS builds its own bundles: build the
Windows installer on Windows, the Linux packages on Linux, and so on. CI does all three (see
[Continuous integration](#continuous-integration)).

## Every platform

- **Node.js 22** (Vite needs 20.19+ or 22.13+).
- **Rust stable** from [rustup.rs](https://rustup.rs). The locked Tauri version needs Rust 1.90 or newer;
  `rustup update` if a build says otherwise.
- Install the npm packages once: `npm ci`

Checks that CI also runs:

```sh
npx tsc -b
npx oxlint src
cd src-tauri && cargo test --lib
```

The web app alone needs no Rust: `npm run dev` serves it at http://localhost:5173.
`npm run desktop:dev` runs the desktop app with hot reload.

## macOS

**Prerequisites:** Xcode Command Line Tools (`xcode-select --install`) and both Mac targets, for a
universal app:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

**Build:** `npm run tauri:build:mac`, a universal (Apple silicon + Intel) `.app` and `.dmg`.

**Output:** `src-tauri/target/universal-apple-darwin/release/bundle/`
- `macos/Kiln.app`
- `dmg/Kiln_<version>_universal.dmg`

**Signing:** `tauri.conf.json` names the project's Developer ID certificate. Without that
certificate in your keychain, the build fails at signing. To sign ad hoc instead (it runs on your
own Mac, but Gatekeeper warns on others):

```sh
npm run tauri:build:mac -- --config '{"bundle":{"macOS":{"signingIdentity":"-","hardenedRuntime":false}}}'
```

**Releases:** a signed and notarized release is `npm run release:mac` (`scripts/release-mac.sh`);
its header lists the one-time notary setup. The DMG lands in `release/Kiln-universal.dmg`.

## Windows

**Prerequisites:**
- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/), with the
  "Desktop development with C++" workload (MSVC and the Windows SDK).
- Rust with the MSVC toolchain (rustup's default on Windows).
- **WebView2:**
  - **Windows 11** has it built in.
  - **Windows 10** needs the
    [Evergreen WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) to run
    Kiln from source. Recent Windows 10 updates usually include it.

  The installers handle this for users: they download WebView2 if it's missing
  (`webviewInstallMode: downloadBootstrapper` in `tauri.windows.conf.json`).

**Build:** `npm run tauri:build:win`. The first build downloads NSIS and WiX by itself.

**Output:** `src-tauri/target/release/bundle/`
- `nsis/Kiln_<version>_x64-setup.exe`: installs for the current user only, no admin needed.
- `msi/Kiln_<version>_x64_en-US.msi`: for managed or IT installs.

The installers aren't code-signed, so SmartScreen warns on first run until they are.

**Window:** on Windows Kiln draws its own title bar, with Minimise, Maximise and Close at the
right of the header (`decorations: false` in `tauri.windows.conf.json`).

**Agent CLIs:** npm installs them as `.cmd` shims in `%APPDATA%\npm`. Kiln finds them there and
in the other usual install folders (see `src-tauri/src/clis.rs`).

## Linux

**Prerequisites:** on Debian or Ubuntu (22.04 or newer):

```sh
sudo apt-get update
sudo apt-get install -y build-essential curl wget file \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev libssl-dev patchelf
```

On Fedora, the matching packages are `webkit2gtk4.1-devel gtk3-devel libappindicator-gtk3-devel
librsvg2-devel libxdo-devel openssl-devel`, plus the "C Development Tools and Libraries" group.

**Build:** `npm run tauri:build:linux`

**Output:** `src-tauri/target/release/bundle/`
- `deb/Kiln_<version>_amd64.deb`
- `appimage/Kiln_<version>_amd64.AppImage`
- `rpm/Kiln-<version>-1.x86_64.rpm`

**Runtime:**
- The `.deb` and `.rpm` declare the WebKitGTK and GTK libraries they need.
- "Show in Files" uses `xdg-open`, from `xdg-utils`.
- Kiln stores files in your XDG Documents folder, or in `~/Documents` when none is set.

**Window:** Linux keeps the native title bar (`tauri.linux.conf.json`).

**Building the Linux bundles from a Mac:** `bash scripts/build-linux-docker.sh` builds the `.deb` and
the AppImage inside Docker and copies them to `dist-linux/`. The repo is mounted read-only, so your
Mac's `node_modules` and `target` aren't touched.
- It builds for the host's architecture by default: arm64 on Apple silicon.
- `PLATFORM=linux/amd64` builds x86_64 under emulation, which is much slower.
- `BUNDLES=deb` skips the AppImage.

## Checking the Windows build from a Mac

A full Windows bundle needs Windows, but the Rust code can be type-checked from a Mac:

```sh
rustup target add x86_64-pc-windows-msvc
brew install llvm                       # tauri-build compiles the icon resource with llvm-rc
export PATH="$(brew --prefix llvm)/bin:$PATH"
cd src-tauri && cargo check --lib --target x86_64-pc-windows-msvc
```

A Linux check can run in Docker:
- Start a `rust:1-bookworm` container with the apt packages above.
- Mount the repo read-only and copy it inside.
- Use a separate `CARGO_TARGET_DIR`, so your Mac build cache isn't touched.
- Run `cargo check --lib && cargo test --lib`.

## Continuous integration

`.github/workflows/build.yml` runs on every push and pull request to `main`, and by hand from the
Actions tab (workflow_dispatch). It runs on four runners:

| Runner | Builds | Artifact |
|---|---|---|
| macos-latest | Apple silicon `.dmg` (and runs the Rust tests) | `kiln-macos-aarch64` |
| macos-latest | Intel `.dmg` | `kiln-macos-x86_64` |
| windows-latest | `.msi` and NSIS `-setup.exe` | `kiln-windows-x86_64` |
| ubuntu-22.04 | `.deb`, `.AppImage` and `.rpm` | `kiln-linux-x86_64` |

Each job runs these steps:
1. `npm ci`
2. `npx tsc -b`
3. `npx oxlint src`
4. `cargo test --lib`. The unix-only tests are behind `#[cfg(unix)]`, so Windows runs the rest.
5. A build with `tauri-apps/tauri-action`, which publishes nothing.
6. An upload of the bundles as artifacts, kept for 14 days.

**Signing in CI:** Mac builds are signed ad hoc, so CI needs no certificates. Windows and Linux
bundles are unsigned.

**Caching:** npm and cargo (`Swatinem/rust-cache`) are cached per target.

## Previewing another OS's look

Kiln's look depends on the OS:
- shortcut labels (`⌘K` on the Mac, `Ctrl+K` elsewhere)
- the window controls (traffic-light inset, or Windows caption buttons)
- "Show in Finder / Explorer / Files"
- fonts and scrollbars

To check another platform's design without that machine, override the OS that Kiln reports:

- **From a link:** open the app with `?kiln-os=windows`, `?kiln-os=linux` or `?kiln-os=mac`. For
  example, http://localhost:5173/?kiln-os=windows. `?kiln-os=auto` goes back to the real OS.
- **From DevTools:**

  ```js
  localStorage.setItem('kiln.os', 'windows') // or 'linux', 'mac'
  location.reload()
  // back to the real OS:
  localStorage.removeItem('kiln.os'); location.reload()
  ```

The setting is stored in `localStorage['kiln.os']`, so it persists until cleared.

Only the look changes: the app still runs, saves and opens files on the real OS. The override is
for design checks. In the Mac desktop app, `windows` draws the Windows caption buttons and drops
the traffic-light inset, so the Mac's own window buttons overlap the logo. The logic lives in
`src/platform/os.ts` and `src/platform/keys.ts`.
