# Updates and the release process

Minutes updates itself with [electron-updater](https://www.electron.build/auto-update)
against **GitHub Releases**. There is no update server of our own, no telemetry,
and nothing is downloaded without the user pressing "Download". This document
covers how the mechanism verifies what it installs, the exact steps to cut a
release, and the honest caveats (code signing, hosting).

The implementation lives in `src/main/services/updater.ts` (`UpdaterService`).

## What the user sees

| Situation                                   | Behaviour                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| Dev build (`electron-vite dev`, `dist:dir`) | Status `disabled` — "only available in the installed (packaged) build".      |
| Packaged build on macOS / Linux             | Status `disabled` — updates are only published for Windows.                  |
| Packaged Windows build, online              | Checks 30 s after launch and every 6 h **if** Settings → Updates → "Check automatically" is on. |
| Offline                                     | Checks are skipped (`net.isOnline()` guard); a manual check returns a non-fatal `error` state. |
| Update found                                | Status `available` with version, release date and release notes. Nothing is downloaded yet. |
| User presses Download                       | Progress events (≤ 4 per second) → status `downloaded`.                       |
| User presses Install                        | `quitAndInstall(false, true)`: app quits, NSIS installer runs, app relaunches. |
| User ignores a downloaded update            | `autoInstallOnAppQuit = true`: it installs the next time the app quits normally. |

Every state change is emitted to the renderer as `updateState`. Errors are states,
not exceptions: `check()` and `download()` always resolve.

Configuration applied once at startup: `autoDownload = false`,
`autoInstallOnAppQuit = true`, `allowPrerelease = false`, `allowDowngrade = false`,
`channel = 'latest'`, and `autoUpdater.logger` bridged to the app log
(`%APPDATA%\Minutes\logs\minutes.log`).

## How downloads are verified

1. electron-builder writes `latest.yml` next to the installer when you run
   `npm run dist:win`. It contains the version, the installer file name, its
   byte size, the release date and a **SHA-512 digest** of the installer.
2. At check time electron-updater fetches
   `https://github.com/<owner>/<repo>/releases/download/v<version>/latest.yml`
   (resolved via the GitHub Releases API, over **HTTPS only**) and compares
   `version` with `app.getVersion()` using semver.
3. At download time it fetches the `.exe` referenced in `latest.yml` (again over
   HTTPS from GitHub), streams it to a temp folder under
   `%LOCALAPPDATA%\minutes-updater\pending`, and **recomputes the SHA-512**.
   If the digest does not match the one in `latest.yml` the file is deleted and
   the updater reports an error. A tampered or truncated download is never run.
4. `.exe.blockmap` files allow differential downloads (only changed blocks are
   fetched when upgrading from the previous installer). The result is still
   verified against the full SHA-512, so the optimisation is safe to include.

What this does **not** protect against: a compromised GitHub account or a
compromised build machine. Whoever can upload to the Releases page can ship an
update. Keep the repository's release permissions tight and use 2FA.

## Release process

Prerequisites, once:

- The packaging configuration lives in `electron-builder.yml` (appId
  `com.dexteritydesign.minutes`, NSIS x64 per-user installer, `publish`
  provider `github`). Set `publish.owner` / `publish.repo` to the real GitHub
  repository and keep them in sync with the `repository` field in
  `package.json`. electron-updater reads this configuration (bundled into the
  app as `resources/app-update.yml`) to know where to look for `latest.yml`.

- The installer must bundle the whisper.cpp runtime. The app looks for it at
  `<resourcesPath>\whisper\win-x64\whisper-server.exe` (`runtimeDirFor` in
  `src/main/services/whisper/whisper-engine.ts`; in development it uses
  `resources/whisper/win-x64` under the working directory). The directory is
  ≈ 41 MB: `whisper-server.exe`, `whisper-cli.exe`, `whisper-bench.exe`,
  `libwhisper.dll`, `ggml.dll`, `ggml-base.dll`, fourteen
  `ggml-cpu-<variant>.dll` files and `VERSION`. It is shipped through an
  `extraResources` entry of the form

  ```yaml
  extraResources:
    - from: resources/whisper/win-x64
      to: whisper/win-x64
  ```

  next to the existing `resources/sapi` entry; the `*.png` filter on the
  `resources` entry does not pick it up. Without it a packaged build shows
  "Runtime not found" in Settings > Transcription and live transcription is
  refused with that reason (the app still runs). Check `release/win-unpacked/
  resources/whisper/win-x64/` after `npm run dist:dir`. The Linux runtime
  (`resources/whisper/linux-x64`, ≈ 22 MB) is for development and the
  integration tests and is not part of the Windows installer. Model files are
  **not** bundled; users download or import them, and they live in
  `%APPDATA%\Minutes\models\whisper`.

- Create a GitHub personal access token with the `repo` scope (classic) or
  "Contents: read and write" (fine-grained) and export it as `GH_TOKEN` on the
  build machine. It is only needed if you let electron-builder upload for you.

Each release:

1. **Bump the version** in `package.json` (`"version": "0.2.4"`). electron-updater
   only offers an update when the published version is *greater* than the
   installed one, so never re-publish the same version with different bits.
2. Commit, then tag: `git tag v0.2.4 && git push --tags`. The tag must be
   `v<version>` — that is the URL electron-updater resolves.
3. **Build**: `npm run dist:win`. Output in `release/`:
   - `Minutes-Setup-0.2.4.exe` — the NSIS installer (now ≈ 41 MB larger than
     a build without the runtime; the blockmap keeps differential updates
     small when the runtime is unchanged)
   - `Minutes-Setup-0.2.4.exe.blockmap` — for differential downloads
   - `latest.yml` — version + SHA-512 manifest
4. **Publish**, one of:
   - Manual: create a GitHub release for tag `v0.2.4`, paste release notes into
     the body (they are shown in-app), and upload **all three files**. Do not
     mark it as a pre-release — `allowPrerelease` is false, so it would be ignored.
   - Automatic: `GH_TOKEN=… npx electron-builder --win --x64 --publish always`
     creates a *draft* release with the assets attached; review and publish it.
5. Verify from a machine running the previous version: Settings → Updates →
   Check now should show the new version within a few seconds.

Rolling back: delete the broken release's assets (or the whole release). Installed
copies keep working; they simply stop seeing an update until the next good one.
A "downgrade" release is not offered because `allowDowngrade` is false.

## Code signing — the honest version

The Windows builds are **unsigned** unless you buy a certificate.

- On first run of an unsigned installer, Windows SmartScreen shows
  "Windows protected your PC — Unknown publisher". The user must click
  "More info → Run anyway". Expect support questions about this.
- electron-updater installs unsigned updates fine, but each installer run
  triggers the same SmartScreen prompt, because `quitAndInstall(false, …)` runs
  the installer visibly. (Silent install of unsigned binaries is also possible
  but gives the user no chance to see what is happening; we chose visible.)
- Fixing this needs an Authenticode certificate: an OV certificate costs roughly
  USD 200–400 per year, an EV certificate more and requires a hardware token
  (which is also what makes SmartScreen trust it immediately; OV builds still
  need to accumulate reputation). Microsoft's Azure Trusted Signing is a
  cheaper subscription alternative but has eligibility requirements.
- Once you have one, electron-builder picks it up through `win.certificateFile`
  / `CSC_LINK` + `CSC_KEY_PASSWORD`, or `win.signtoolOptions` for a
  cloud/HSM signer. The updater code needs no change.

Do not disable SmartScreen for users or tell them to; the correct fix is signing.

## Hosting — also honest

- GitHub Releases is free for public repositories and release assets do not
  count against Git LFS quotas. GitHub's terms allow this within
  "fair use" and asset size limits (2 GB per file). It is not a contractual
  CDN and GitHub can change the terms; a popular app with large installers
  could be asked to move. For a small internal tool this is a non-issue.
- A **private** repository still works for publishing, but the *installed app*
  then needs a token to read releases — which would ship a secret inside the
  app. Do not do that; keep the repository public or host `latest.yml` and the
  installer on a plain HTTPS server and switch `publish.provider` to `generic`.

## User data is never touched

Updates replace the program files only (`%LOCALAPPDATA%\Programs\Minutes` for a
per-user install). Everything the user owns lives in the Electron user-data
directory, **`%APPDATA%\Minutes`**:

- `data\minutes.sqlite` — notes, transcripts, calendar cache, settings and transcription jobs
- `recordings\` — WAV files
- `models\whisper\` — downloaded or imported speech models (`ggml-<id>.bin`)
- `pending-audio\` — chunk files awaiting a background transcription job
- `backups\` — database backups
- `logs\` — application log

The installer and updater do not read, write or delete anything there. In
particular an update replaces the whisper runtime under the program folder but
never touches the models, so no re-download follows an update; the catalog in
the new version decides whether an installed file is still known (a model
removed from the catalog would stop being listed but its file would stay on
disk until the user deletes it).
Schema migrations run inside the app on next launch (`src/main/db/migrations.ts`)
and are additive. Uninstalling also leaves `%APPDATA%\Minutes` in place unless the
user deletes it themselves.

## Building the Windows installer on Linux

`npm run dist:win` works on Windows out of the box. On Linux, electron-builder needs wine to stamp the
executable's icon and version resources and to generate the NSIS uninstaller:

1. Install 64-bit wine (`apt-get install wine64`) and make a `wine` command available on `PATH`
   (a wrapper script such as `exec /usr/lib/wine/wine64 "$@"` is enough; a bare symlink breaks wine's loader lookup).
2. electron-builder calls the 32-bit `rcedit-ia32.exe` even for x64 builds. Without 32-bit wine, copy the 64-bit
   tool over it once: `cp ~/.cache/electron-builder/winCodeSign/winCodeSign-*/rcedit-x64.exe ~/.cache/electron-builder/winCodeSign/winCodeSign-*/rcedit-ia32.exe`
   (the cache directory is created on the first build attempt).
3. Run `node scripts/patch-electron-builder-linux.mjs` once after `npm install`. It makes electron-builder extract the
   uninstaller with its own pure-JS reader (the code path it already uses on macOS) instead of running the installer
   stub under 32-bit wine. The resulting installer is identical to a Windows build of the same inputs.

The 0.1.0 installer shipped alongside this repository was produced exactly this way and checked for correct
version metadata and icon resources with `pefile`.

## Building the whisper.cpp runtime on Linux

The runtime under `resources/whisper/` is a build artefact of whisper.cpp
1.9.1, reproduced by `scripts/whisper/build-runtime.sh`:

```
git clone --branch v1.9.1 --depth 1 https://github.com/ggml-org/whisper.cpp /tmp/whisper.cpp
scripts/whisper/build-runtime.sh /tmp/whisper.cpp all      # or: linux | win
```

Requirements: cmake ≥ 3.5, gcc/g++ 13 for the Linux target, and
`x86_64-w64-mingw32-gcc-posix` / `g++-posix` (Debian/Ubuntu package
`g++-mingw-w64-x86-64-posix`) for the Windows target. Both targets are built
with `-DBUILD_SHARED_LIBS=ON -DGGML_NATIVE=OFF -DGGML_BACKEND_DL=ON
-DGGML_CPU_ALL_VARIANTS=ON -DGGML_OPENMP=OFF -DWHISPER_BUILD_TESTS=OFF
-DWHISPER_SDL2=OFF -DCMAKE_BUILD_TYPE=Release`, targets `whisper-server`,
`whisper-cli` and `whisper-bench`. `GGML_NATIVE=OFF` plus the CPU variants is
what makes one build run on every x86-64 CPU and pick the best code path at
start; `GGML_OPENMP=OFF` removes the `libgomp`/`libwinpthread` dependency.

For Windows the script uses the toolchain file `scripts/whisper/mingw-x64.cmake`
(static `libgcc`, `libstdc++` and `winpthread`, so the output depends only on
Windows system DLLs) and first applies `scripts/whisper/mingw-header.patch`,
which adds the `THREAD_POWER_THROTTLING_STATE` definitions that MinGW-w64
headers up to version 11 lack. The outputs are copied into
`resources/whisper/linux-x64/` (`*.so*` and the three binaries) and
`resources/whisper/win-x64/` (`*.dll` and the three `.exe`). Update the
`VERSION` file in each directory with the whisper.cpp and ggml versions, the
flags and the build date; Settings shows the first part of that string as the
runtime version. The current files were built on 2026-10-20 on a Linux
machine; `whisper-server.exe` was smoke-run under wine there but has not yet
been run on Windows hardware.
