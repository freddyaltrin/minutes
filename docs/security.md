# Security

Minutes is a local application with no server component. The attack surface
is the renderer (a Chromium page that displays user-written and imported
text), the IPC boundary between that page and the Node main process, and the
files on disk. This document lists what the code enforces and, just as
importantly, what it does not. Line references are to `src/main/index.ts`
unless stated.

## What is enforced

### Process isolation

The main window is created with `contextIsolation: true`, `sandbox: true`,
`nodeIntegration: false`, `webSecurity: true` and
`allowRunningInsecureContent: false`. The renderer has no access to Node or
Electron APIs. The only bridge is the preload (`src/preload/index.ts`), which
exposes exactly two things through `contextBridge`: `window.minutes`, the
typed `MinutesApi` surface, and `window.minutesPlatform`, a string. It does
not expose `ipcRenderer`, and every method is a thin wrapper that forwards its
arguments to a fixed channel name.

`will-attach-webview` is cancelled, so no `<webview>` can be created.

### Content Security Policy

`configureSession()` injects this header on every response in the default
session. In a packaged build the policy is exactly:

```
default-src 'self'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

In development (`!app.isPackaged`) `script-src` and `connect-src` additionally
allow ` http://localhost:* ws://localhost:* http://127.0.0.1:*` for the Vite
dev server.

Consequences: the page cannot load scripts, styles, fonts or images from the
network, cannot `fetch` anything, cannot embed plugins and cannot be framed.
`blob:` in `script-src` and `worker-src` exists for the inline AudioWorklet
module used by audio capture; if a stricter policy rejects it the capture code
falls back to a `ScriptProcessorNode`. `'unsafe-inline'` for styles is needed
by the editor and by React inline styles; it does not permit script
execution.

### Permissions

`setPermissionRequestHandler` and `setPermissionCheckHandler` grant only the
`media` and `display-capture` permissions and deny everything else
(notifications, geolocation, clipboard-read, pointer lock, and so on). The
`media` class covers both microphone and camera requests from the page; the
application's own code only ever requests `audio`.

`setDisplayMediaRequestHandler` never returns a screen or window source. On
Windows it answers with `{ audio: 'loopback' }` so that `getDisplayMedia`
yields the system-audio mix and nothing else; on other platforms it answers
with an empty object, which fails the request. The renderer stops and removes
any video track it receives regardless. `useSystemPicker` is false, so no OS
picker is shown.

### Navigation and new windows

`will-navigate` cancels any navigation away from the app's own `file://`
origin (or the dev-server URL in development). If the target is an `http(s)`
URL it is handed to the operating system browser via `shell.openExternal`;
anything else is dropped. `setWindowOpenHandler` always returns
`{ action: 'deny' }`, again opening `http(s)` targets externally.

The `app.openExternal` IPC method is the only way the renderer can ask main to
open a URL; it accepts `http://`, `https://` and `mailto:` only and returns
`false` for anything else. The editor's link mark restricts protocols to the
same set and does not open links on click.

### IPC validation

Every invoke channel is registered through `reg()` in
`src/main/ipc/handlers.ts`, which:

- rejects the call with "Untrusted sender" unless `isTrustedSender(senderFrame.url)` holds — the sender must be a `file://` page or, in development, `http(s)://localhost` / `127.0.0.1`;
- rejects calls with more arguments than the handler declares;
- runs each argument through a validator from `src/main/ipc/validate.ts` (`v.string` with length limits, `v.id` matching `^[A-Za-z0-9_-]{1,64}$`, `v.number` with range and integer checks, `v.literal` for enums, `v.object`/`partial` that copy only declared keys, `v.array` with item limits, `v.arrayBuffer` with a byte cap, `v.record` with key pattern checks), failing closed on any unexpected shape;
- catches every error and rethrows `new Error(e.message)` so only the message string crosses to the renderer; stack traces and non-validation errors go to the log file.

The two fire-and-forget channels (`recording:pushChunk` and the three window
controls) are registered with `ipcMain.on` and apply the same sender check;
bad audio chunks are dropped with a log line, never processed.

Identifiers are validated before they reach SQL, and every query uses bound
parameters. FTS5 MATCH expressions are built by `buildFtsQuery`, which quotes
each term and strips operator characters so user input cannot inject FTS
syntax.

### Network

The renderer makes no network requests (CSP `connect-src 'self'`). The main
process makes requests in three places only:

- `ModelManager.download` (`src/main/services/whisper/model-manager.ts`): a
  Node `fetch` of `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-<id>.bin`
  for a model the user asked to install. The URL, byte size and SHA-256 digest
  of every downloadable file are pinned in `model-catalog.ts`; the response is
  streamed to a `.part` file (never buffered whole), hashed incrementally, and
  installed only if both the size and the digest match, otherwise deleted with
  an error shown to the user. Redirects are followed (Hugging Face serves
  files from a CDN host); nothing but the bytes is used. This is the only
  network use added by the transcription subsystem; the worker process itself
  makes no outbound connections. A model imported from a file goes through the
  same size and digest check.
- `CalendarService.fetchIcs`: Node `fetch` of a user-supplied `http(s)` URL,
  20 s timeout, 10 MB cap, body read in a capped stream, response must contain
  `BEGIN:VCALENDAR`.
- `UpdaterService`: electron-updater against GitHub Releases over HTTPS,
  SHA-512 verification of the downloaded installer, packaged Windows builds
  only, and only when the setting is on or the user presses Check.

Calendar and update requests are skipped when `net.isOnline()` is false.
There is no telemetry, crash reporting or analytics of any kind. Audio never
leaves the machine.

### Model files

Model files are data, never code. `ggml-<id>.bin` files are read by
`whisper-server` with its own parser; the app never executes, `require`s or
evaluates them. A corrupt or malicious file can at worst crash the worker
process, which runs out of process and is restarted or given up on (see
"Process and file hygiene"); it cannot run code inside the app. Files are
stored under `<userData>\models\whisper`; "Verify" re-hashes an installed
file against the pinned digest and marks it corrupt on mismatch.

### The whisper worker and localhost HTTP

`whisper-server(.exe)` from `resources/whisper/<platform>-x64` is spawned by
`WhisperEngine` with `-m <model> -t <threads> --host 127.0.0.1 --port <port>
--no-gpu` and `windowsHide`. The port is chosen at start by binding an
ephemeral port on 127.0.0.1 and releasing it; it changes on every load. The
server binds to 127.0.0.1 only, so it is not reachable from other machines,
and the main process talks to it with `fetch` over plain HTTP (`/inference`,
multipart WAV upload, JSON back). The traffic is **unauthenticated**: any
process running on the same machine as the same or another user that can
connect to 127.0.0.1 could post audio to that port while the worker is
running, or read the response if it could intercept loopback traffic. This is
the accepted risk of the design — the alternative (a token or named pipe)
would require changing whisper.cpp's server — and it is bounded: the worker
holds no notes or secrets, only the model and the window being transcribed;
the process exists only while a model is loaded; the app's own requests carry
no identifying data beyond the audio and the prompt text (custom vocabulary
and the previous chunk's text). Transcript storage happens in the main
process, not in the worker. There is also a small window at start between
releasing the probe port and the server binding it in which another local
process could take the port; the load would then fail or time out and be
reported, not silently talk to the wrong process.

The worker's stdout/stderr are parsed only with regular expressions for the
CPU-variant line and kept as a 60-line tail for error messages; they are not
executed or rendered as HTML.

### Process and file hygiene

The whisper worker is a plain child process; it reads the model file and the
WAV bodies posted to it and writes nothing. A crash is contained to the worker
(the app restarts it at most twice per recording, then defers the audio to a
background job). Loading never leaves a process behind: a failed or timed-out
load stops the child first. `shutdown()` stops the worker when the app quits.

When the optional Windows recognizer engine is selected, its worker is spawned
as Windows PowerShell 5.1 with `-NoProfile -NonInteractive -ExecutionPolicy
Bypass -File <script>` and `windowsHide`. `-ExecutionPolicy Bypass` applies
only to that process and only to the bundled script; it does not change the
machine's policy.

Chunk WAV files live in a per-recording temp directory; each is deleted after
its segments are stored, the directory is removed when the recording ends and
swept on startup. Chunks a live session could not finish are moved to
`<userData>\pending-audio\<noteId>\` and deleted when their background job
completes or is removed; files no job refers to are swept on startup. Model
downloads write only inside `<userData>\models\whisper`; the import path
copies the chosen file there after verifying it and never executes it. The
model file picker is an OS open dialog; the renderer cannot pass a path.

Export and backup paths come from OS save/open dialogs; the renderer cannot
pass an arbitrary destination path except to `backup.restore`, whose argument
is validated as a string and then verified to be a readable SQLite file with
the app's schema before anything is replaced, with a safety copy of the live
database made first.

The app requests a single-instance lock; a second launch focuses the existing
window. The Windows `AppUserModelId` is fixed to
`com.dexteritydesign.minutes`.

## What is not enforced

No encryption at rest. `minutes.sqlite`, the backups, kept recordings and the
log are plain files under `%APPDATA%\Minutes`. Anyone with read access to the
Windows user profile, including malware running as that user, backup
software and administrators, can read every note and transcript. The
operating-system account boundary is the only protection. Use BitLocker or
EFS if that is not enough.

Calendar secrets. ICS feed URLs, which for Google and Outlook are
capability URLs (whoever has the link can read the calendar), are stored in
plain text in the `calendar_sources` table. They are copied into every backup.
Removing a source deletes the row but does not revoke the link; do that from
the calendar provider.

No application lock. There is no password or PIN on the app.

No sandboxing of the worker processes beyond what Windows gives a user
process. The whisper worker reads the model file and the audio posted to it;
the optional recognizer worker reads only the chunk files it is told about.
The localhost HTTP channel to the whisper worker is unauthenticated, as
described above.

Model provenance is pinned, not signed. The SHA-256 digests in the catalog
were captured from the publisher's file listing on 2026-10-20; they guarantee
that the installed bytes are the bytes the catalog expects, not that those
bytes are benign. The trust anchor is the catalog in this repository.

No code signing. The installer and updates are unsigned, so SmartScreen
cannot vouch for them and a tampered installer obtained from somewhere other
than the project's GitHub Releases page cannot be distinguished by the
operating system. The updater verifies SHA-512 against `latest.yml`, but that
manifest is fetched from the same place as the installer; the trust anchor is
the GitHub repository and whoever can publish to it.

Imported content is trusted as text. Transcripts imported from SRT/VTT/TXT
and ICS feeds are parsed and stored as strings; they are rendered as text, not
HTML, and search snippets are HTML-escaped before `<mark>` tags are added.
The CSP would block script execution even if that escaping failed, but no
sanitisation beyond escaping is performed.

The log file may contain note titles, calendar labels, file paths and error
messages. Share it deliberately.

## Reporting

There is no security contact beyond the repository's issue tracker. If you
find something that should not be public, open an issue asking for a private
channel rather than posting details.
