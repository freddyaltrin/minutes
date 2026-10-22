# Testing

Minutes has a unit-test suite that runs on any operating system, an
integration suite that drives the real whisper.cpp runtime when it is present,
a small Playwright end-to-end suite that drives the built app, a set of QA
driver scripts used for screenshots and pipeline smoke runs, and a manual
checklist for the parts that only exist on Windows hardware: audio capture,
loopback, the Windows whisper runtime, the optional speech recognizer, the
installer and the updater. Each is described below
with what it does and does not prove.

## Unit tests

```
npm test            # one run
npm run test:watch  # watch mode
```

Vitest, configured in `vitest.config.ts`. Unit tests live under `tests/unit`
and run in the `node` environment, except `tests/unit/renderer/**`, which runs
in `jsdom`; the same command also picks up `tests/integration/**/*.int.test.ts`
(next section). At the time of writing there are 26 unit files with 450 tests
and 2 integration files with 6 tests; all pass on Node 22. Database tests open
`node:sqlite` in memory or in a temp directory, so no Electron runtime is
needed.

What they cover:

| File | Covers |
| --- | --- |
| `text/tokenize.test.ts` | Tokenizer (case, punctuation, apostrophes, Unicode), stopword list, stemmer, sentence splitting, snippet and highlight helpers |
| `text/dates.test.ts` | Date mention parsing: ISO, day-first numeric, "20 Oct"/"Oct 20", weekdays with by/on/next/last, relative phrases, times, deadline-likeness, ambiguity handling |
| `text/keywords.test.ts` | Content-token filter, TF/IDF keyword ranking, TextRank-style phrase extraction and its determinism |
| `text/extract.test.ts` | Suggestion extraction: action cues and weak-action threshold, one-kind-per-sentence priority (decision over deadline over action over question), references, topics, dedupe and ordering, person-name heuristic |
| `text/ask.test.ts` | Question intent classification and priority, scaffolding removal, stem and synonym expansion, `buildFtsQuery` escaping of FTS operators, passage scoring, intent scan hints |
| `text/transcript-parsers.test.ts` | SRT, VTT and plain-text transcript parsing including CRLF, BOM, `<v>` speaker tags, malformed blocks and timestamp forms |
| `text/export-render.test.ts` | ProseMirror JSON to Markdown and plain text (headings, marks, nested lists, task items, quotes, code, escaping), transcript rendering |
| `text/index.test.ts` | The barrel re-exports every text module |
| `calendar/ics.test.ts` | ICS unfolding and unescaping, durations, zoned and floating times, Windows and Mozilla TZIDs, all-day events, recurrence expansion |
| `calendar/calendar-service.test.ts` | `CalendarService` with an in-memory database and a stubbed fetch: add URL and file sources, `lastError` on failure, webcal rewriting, window replacement keeping note links, idempotent note creation, size limits |
| `db/migrations.test.ts` | Migration ordering and idempotence, fresh and partially migrated databases, rollback of a failed migration, `Database.inspect`, nested transactions; `SettingsRepo` merge-over-defaults, corrupt JSON, deep-merge set, reset, arbitrary keys |
| `db/notes-repo.test.ts` | Note create/get/update semantics (updated_at only on change), list views, recent window, folder and tag views, pinned-first ordering, limit/offset, summaries, duplicate, trash/restore/destroy, tags and folders |
| `db/transcripts-repo.test.ts` | Transcript `ensure`/`appendSegments`/`replaceAll`, segment edit and delete keeping FTS in sync, `clear`, cascade on destroy; extraction storage, dedupe by (kind, sourceText), preservation of edits and dismissals across re-analysis, index consistency |
| `db/search-repo.test.ts` | `toMatch` query building (prefix tokens, phrases, operator neutralisation, Unicode) with a fuzz check that FTS5 never throws; `query` blank input, prefix hits, escaped `<mark>` snippets, phrase adjacency, transcript segment ids and `startMs`, scope filters; `ask` retrieval |
| `ipc/validate.test.ts` | Every validator in `src/main/ipc/validate.ts`: bounds, id pattern, number constraints, literal, optional/nullable, array, object, partial, record, arrayBuffer |
| `services/backup.test.ts` | `BackupService` with a temp directory and stubbed dialogs: consistent `VACUUM INTO` copies, listing order, prune keeps only automatic backups, restore with confirmation, safety copy and restart signal, cancel paths, rejection of non-databases, storage info and folder sizes |
| `transcription/wav.test.ts` | WAV header writing, PCM helpers, RMS |
| `transcription/chunker.test.ts` | `SpeechChunker`: pause cut after `minChunkMs`, hard cut at `maxChunkMs`, silent-chunk skipping, offset continuity, gap detection, adaptive threshold |
| `transcription/sapi-engine.test.ts` | `SapiEngine` (optional Windows recognizer) with a fake child process: line buffering, probe on non-Windows and with ok/error/early-exit/timeout replies, streaming segments, queue ordering, drain on stop, worker crash handling |
| `whisper/hardware.test.ts` (14) | `/proc/meminfo` and `/proc/cpuinfo` parsers, physical-core estimate, Linux and Windows inspection with fake providers (Windows: `freemem` used as available, features unreliable, `PROCESSOR_IDENTIFIER` fallback), ggml CPU-variant hints mapped to feature lists and merged, never-throws fallbacks on provider failures and bogus numbers, a sanity run against the real OS |
| `whisper/model-catalog.test.ts` (6) | 26 unique entries matching the captured Hugging Face tree (file name, size, sha256, URL), family/language/quantization parsing, memory estimates monotonic in file size and flagged unmeasured, f16 estimates near the whisper.cpp README figures, speed/accuracy/live classes per family |
| `whisper/model-manager.test.ts` (13) | With a fake `fetch` and a temp directory: fresh download verified and atomically installed, resume with `Range` ending in the right digest, restart on 200-for-Range, sha256 and size mismatch delete the file and report, HTTP failures, dedupe of concurrent downloads and the concurrency cap of 2, cancel keeps `.part`, remove refused while in use, `verify()` flags tampering, `storageUsage()`, `cleanupTemp()` age rule, `importFromFile()` accepts a good file and rejects bad hash or size |
| `whisper/profiles.test.ts` (9) | The four profiles' ceilings, pin-only families, `getProfile` fallback, `DEFAULT_CONFIG`, `recommendProfile` thresholds (12 GB, 2 cores, reliable no-AVX2, 28 GB + 8 cores + AVX2) and determinism |
| `whisper/resource-manager.test.ts` (33) | Budget formula and both fallbacks, eligibility formula and notes, thread rule (fraction, caps, physical cores, leave-one-free, custom override), `plan()` on 8/16/32 GB machines (lightweight → tiny, balanced → base, high-accuracy → small and never medium, pinned medium chosen only with budget, fallback and no-fallback rationale, not-installed pin, custom pin-only, cheapest-install suggestion, unknown id, active job bytes), `canStartJob` policy, `adapt()` thresholds and "never suggests a model switch", `formatBytes` |
| `whisper/transcription-service.test.ts` (16) | `TranscriptionService` with a fake engine (`fake-engine.ts`) and an in-memory database: resource selection per profile, `startLive` refusals (disabled, engine none, runtime missing, no model, load failure) that never hang, live happy path (absolute offsets, channels, chunk files deleted), crash containment (restart, retry, per-session budget of two, deferral after the third crash), lag deferral and the resulting job, background jobs (silent windows skipped, progress persisted, pause at a window boundary, cancel/retry with `attempts ≥ 2`), live pauses a running job and it resumes after, interrupted-job recovery on start, `removeJob` never deletes a user recording |
| `renderer/audio-capture.test.ts` | Pure capture helpers: `downsampleTo16k`, `floatToInt16`, `rmsOf` |

What they do not cover: the main-process entry (`src/main/index.ts`), the IPC
handler registrations themselves (only the validators), `RecordingService`,
`ExportService`, `ShortcutService`, `UpdaterService`, the real
`whisper-server` process (integration tests, below), the real model download
(no network in the build sandbox; the manager is tested against a fake
`fetch`), and every React component. Those are exercised by the end-to-end
suite, the QA scripts and the manual checklist.

## Integration tests (real whisper.cpp runtime)

`tests/integration/whisper-engine.int.test.ts` and
`tests/integration/transcription-service.int.test.ts` run the real
`whisper-server` from `resources/whisper/<platform>-x64` against a real model.
They are gated with `describe.skipIf` and are **skipped**, not failed, unless
all three exist: the runtime binary for the current platform, the model file
(`MINUTES_TEST_MODEL`, default `/home/claude/models/ggml-tiny.en-q5_1.bin`)
and a 16 kHz mono speech WAV (`MINUTES_TEST_WAV`, default
`/home/claude/models/jfk.wav`). Set the two variables to run them elsewhere;
the model is the smallest catalog entry (31 MB) and any clear English clip of
10–30 s works.

What they prove, on the machine they run on:

- the engine loads a model and answers on its random localhost port, returns
  segments with timestamps for the WAV, survives having its process killed
  (`CRASHED` reported, reload succeeds), and fails cleanly on a bad model file;
- a live session transcribes chunk files, stores segments with absolute
  timestamps and channels, and deletes the chunk files afterwards;
- a background job over a saved recording writes progress incrementally
  (`processedMs`, `nextIndex`) and completes;
- pause stops at a window boundary and resume completes; cancel and retry
  behave as specified.

They take roughly 30 s with the tiny model on a 2-core VM. They say nothing
about accuracy or speed on Windows; that is what the on-device checklist and
`docs/benchmarks.md` are for.

## End-to-end tests

The suite lives in `tests/e2e` (`playwright.config.ts` and `app.spec.ts`) and
uses Playwright's Electron support to launch the built app from
`out/main/index.js` with an isolated user-data directory (the main process
honours `MINUTES_USER_DATA` so a run never touches real notes). One worker,
no parallelism, 60 s per test, results under `out/e2e-results`.

On Windows:

```
npm run test:e2e
```

On a headless Linux machine the app needs a display server:

```
npm run build && xvfb-run -a npx playwright test -c tests/e2e/playwright.config.ts
```

The seven tests:

1. launches and shows the welcome state;
2. a note typed after Ctrl+N autosaves and survives an app restart;
3. Ctrl+K search finds the note by a body word and Enter opens it;
4. importing an SRT transcript shows four rows and the Suggestions panel lists a Decisions group;
5. Ctrl+Shift+Backspace trashes the note and Undo restores it;
6. security: the renderer is isolated (no `require`, no `process`), the web preferences are locked down and the CSP blocks `eval`;
7. update checks report `disabled` in a development build and the app stays usable.

They run the real UI, the real database and the real IPC path. They do not
exercise audio devices or either transcription engine, and they are not a
visual regression suite.

## QA driver scripts

`scripts/qa/*.mjs` are Playwright-driven scripts used during development to
walk the app through states and take screenshots. They do not assert
anything; a run "passes" if it does not throw. `steps1.mjs` to `steps3.mjs`,
`kbd.mjs` and `stress.mjs` are step modules loaded by `shot.mjs`;
`audit.mjs` walks every major state in light and dark; `docshots.mjs`
produces the images in `docs/screenshots` and `docs/screenshots/dark`
(`AUDIT_THEME=light|dark xvfb-run -a node scripts/qa/docshots.mjs`);
`packaged.mjs` launches the packaged build; `recshot.mjs` captures the
recording-pill states.

`record.mjs` is the one that touches the capture pipeline. It launches the
app with Chromium's `--use-fake-device-for-media-stream` and
`--use-fake-ui-for-media-stream`, turns on "Keep audio recordings", presses
Record, types while recording, pauses with Ctrl+Shift+P, stops, and prints the
recording state and the resulting WAV files. It proves that the renderer
capture, the ~250 ms PCM chunks over IPC, the `RecordingService` and the WAV
writer work end to end with a synthetic microphone. It does not prove
anything about real devices or loopback, which only exist on Windows, and it
runs with transcription off.

## Manual on-device checklist (Windows)

Run this on a real Windows 10 (1903 or later) or Windows 11 x64 machine with a
microphone, speakers or a headset. Record the CPU model, core count, total
memory and the CPU variant the runtime reports, because every transcription
outcome depends on them. Use a packaged build (`npm run dist:dir` for a quick unpacked build,
`npm run dist:win` for the installer) because several items only behave
correctly when `app.isPackaged` is true.

### Startup and data

1. First launch creates `%APPDATA%\Minutes\data\minutes.sqlite`, `recordings`, `backups`, `logs` and `%TEMP%\minutes`. Settings > Storage & backup shows the same paths.
2. `logs\minutes.log` contains a `startup` line with the version and database path.
3. A second launch while the app is running focuses the existing window instead of opening another.
4. Close the window: the app quits (no recording active). Tray menu shows Open, New Note, Start / Stop Recording, Quit.
5. Create a note, quit, relaunch: the note is there and the window reopens at its previous size and position.

### Recording (microphone)

6. Settings > Audio lists the microphones with labels after permission is granted.
7. Press Record on a note. The pill appears with moving level bars when you speak, the elapsed time counts, the tray icon switches to the recording variant.
8. Pause: bars flatten, time shows "Paused", resuming continues from the same elapsed value (paused time is excluded).
9. Navigate to another note while recording: the pill shows "Recording · <title>" with "Go to note". The recording survives.
10. Ctrl+Shift+R with another application focused toggles the recording (global shortcut). If it does not, the log shows "global shortcut unavailable" — another app owns the combination.
11. Unplug or disable the microphone during a recording: the recording ends with an error toast rather than hanging.
12. Turn on "Keep audio recordings", record ten seconds, stop: `recordings\<noteId>\<timestamp>-mic.wav` exists, is 16 kHz mono PCM, plays back, and the transcript panel lists it with size and duration; "Reveal" opens Explorer at the file.
13. With "Keep audio recordings" off and transcription off (or unavailable), Record shows the "Nothing would be kept" dialog instead of starting.
14. Set "Auto-stop after silence" to 5 minutes, record silence for just over five minutes: the recording stops by itself and the log shows "auto-stop after silence".

### System audio (loopback)

15. With "Capture system audio" on, start a recording while something plays through the speakers. The pill shows the system-audio dot and it lights while audio plays.
16. With transcription on, a `-system.wav` file is produced alongside `-mic.wav` when recordings are kept, and the transcript labels those segments "Them".
17. Try with a Bluetooth headset during a call and with an application in exclusive mode; note which paths are captured. Expect some not to be.
18. On a Windows build older than 1903 (or with loopback refused), the recording continues mic-only and a toast says why.

### Live transcription (whisper.cpp)

19. Settings > Transcription, engine "whisper": the Runtime line shows `whisper.cpp 1.9.1` with the build flags in the detail; "This computer" shows CPU, cores, memory and "Instruction sets: Not detected" before the first use; the "Recommended" tag sits on the profile `recommendProfile` would pick for this machine (see `docs/hardware-requirements.md`).
20. Install a model: press Download on `base.en-q5_1` (Balanced) or `tiny.en-q5_1` (Lightweight). Progress and bytes/s are shown, then "Verifying checksum…", then Installed with the file size. `%APPDATA%\Minutes\models\whisper\ggml-<id>.bin` exists and no `.part` remains. Cancel a second download midway: the `.part` stays and Download resumes from it (log shows a `Range` resume).
21. The plan reads "Will use <model> with N threads" with the rationale lines and "Needs ≈ X of a budget of Y"; N matches the thread rule for this CPU.
22. Record and speak a few sentences with clear pauses. The pill shows "Transcribing · <model>"; segments appear in the transcript panel after each pause, labelled "Me", with timestamps matching the elapsed time. After the first recording "Instruction sets" lists the detected features and the log has a `loaded CPU backend from …ggml-cpu-<variant>` line.
23. Speak without pausing for 30 seconds: a segment appears at about the 25-second mark (hard cut).
24. Watch the backlog label: while chunks are queued the pill reads "Processing · N s behind"; on a slow machine or with a deliberately large model pinned (Custom profile) it turns to "Lagging · N s behind" and, past 60 s of backlog, "Will finish after the meeting". Confirm no audio is lost: after stopping, a background job appears for the note and the transcript fills in when it completes.
25. Kill `whisper-server.exe` in Task Manager mid-recording: the log records the unexpected exit, the worker is restarted (Settings shows a new load time), the chunk in flight is retried and transcription continues. Kill it twice more within the same recording: the pill shows "Transcription failed" / "Will finish after the meeting", the recording itself continues, and stopping queues the remaining chunks as a background job.
26. Stop while a few chunks are still queued: "Finishing · N chunks left", then the remaining segments arrive and the state returns to idle. `%TEMP%\minutes\rec-<id>` is gone.
27. Background job over a saved recording: with "Keep audio files" on, open the Transcript panel of a note with a recording and press its transcribe action. The job appears in Settings > Background jobs as Running with progress and speed, the panel shows "Transcribing in the background · N %", segments arrive while it runs, and it ends Completed.
28. Pause/resume: pause the running job; it stops at the next window and shows Paused with its progress kept; Resume continues from there. Start a recording while a job is running: the job pauses by itself and resumes after the recording ends.
29. Model removal refusal: while a model is loaded (worker "Running" in Settings), its Remove button is disabled with the "in use" tooltip; after choosing another model or profile and recording once, Remove works and the file disappears.
30. Offline import: copy a `ggml-tiny.en-q5_1.bin` from another machine, choose "Import model file…" with the matching entry; it installs. Repeat with a renamed different file: refused with a size or sha256 message.
31. Verify: press Verify on an installed model (ok); corrupt a byte of the file with a hex editor and Verify again: the row shows corrupt with Re-download.
32. Quit the app during a running job and relaunch: the job is back in the queue and resumes from its saved window (`nextIndex`), not from zero.
33. Pin `medium.en-q5_0` under Custom on an 8 GB machine: the plan refuses with the shortfall and names a smaller model; with fallback allowed under Balanced the rationale says it fell back.

### Live transcription (optional Windows recognizer)

34. Switch the engine to "Windows speech": Settings shows the recognizer as available and lists installed cultures with the .NET version. Record and speak: segments appear with "Me" labels. Kill `powershell.exe` in Task Manager: the pill shows the failure, the recording continues. Switch back to whisper.

### Suggestions, search and ask

35. On the recorded note, open Suggestions: items are grouped by kind, each expands to show its source sentence, and transcript-derived items show a timestamp that jumps to the segment.
36. Ctrl+K finds a word from the transcript and from the note body; quoted phrases match exactly; the folder and archived filters work.
37. Ctrl+J with "What deadlines were mentioned?" returns dated passages and the intent line reads "deadline".

### Calendar

38. Add a Google secret ICS address or an Outlook published calendar URL. The toast reports the event count; upcoming events appear in the sidebar; clicking one creates a pre-filled note and clicking again opens the same note.
39. Add a local `.ics` file. Remove a source: its events disappear.
40. Disconnect the network and press Refresh: `lastError` says you are offline and the previous events remain.

### Export, backup, restore

41. Export a note as Markdown and as text; the save dialog defaults to `Documents\Minutes`; the file contains the body, attendees, tags, surviving suggestions and transcript.
42. Export transcript as `.srt` and `.vtt`; both load in a video player or subtitle editor.
43. "Export all notes" writes one `.md` per note into a dated folder, with numbered suffixes for duplicate titles.
44. Create a manual backup: a `minutes-backup-<timestamp>.sqlite` appears with the right note count. Restore it: the warning dialog lists the differences, a `minutes-backup-before-restore-…` safety copy is written, and the app relaunches with the restored data.
45. Launch on a new day: a `minutes-backup-auto-<timestamp>.sqlite` file is created and the folder never holds more than ten `minutes-backup-auto-*` files; manual and before-restore files are untouched.

### Installer

46. Run `release\Minutes-Setup-<version>.exe` from an unsigned build: SmartScreen appears; "More info → Run anyway" proceeds; the NSIS wizard offers the install directory; the app launches at the end.
47. The Start menu entry, desktop shortcut (if chosen) and Apps list show the Minutes icon at the correct sizes (16, 32, 48, 256).
48. Uninstall from Settings > Apps: `%LOCALAPPDATA%\Programs\Minutes` (including `resources\whisper\win-x64`) is removed, `%APPDATA%\Minutes` — notes, recordings, backups, logs and `models\whisper` — is left in place.

### Updates

49. In the packaged build, Settings > Updates shows "idle" (not "disabled") and Check now reaches GitHub Releases. With no release published the message is "No published release was found for this app yet."
50. Publish a release with a higher version, `latest.yml`, the installer and its blockmap. Check now shows "available" with notes and date; Download shows progress and ends at "downloaded"; Install quits, runs the installer (SmartScreen again), and relaunches at the new version. User data is untouched and the installed models are still listed as Installed without re-downloading.
51. Disconnect the network and press Check now: a non-fatal "You are offline" state, nothing crashes.
52. Turn "Check automatically" off: no background check is logged after 30 seconds or 6 hours.

### Housekeeping

53. Diagnostics > Export writes a JSON file with versions, storage figures, settings (recent searches omitted), the Windows recognizer probe result and recording state, and no calendar URLs or note content. (The whisper engine status, hardware and plan are not yet part of the export; read them from Settings > Transcription or the log.)
54. Settings > Shortcuts: rebind Ctrl+K to something else, confirm the menu bar shows the new accelerator and the old one no longer opens search; Reset restores defaults.
55. Switch the theme to Dark and back; `prefers-reduced-motion` on the OS flattens the level-meter animation to a slow refresh.

Record the Windows build number, CPU model and reported CPU variant, total
memory, the model and thread count used, the audio devices and the app version
alongside the results, because most transcription outcomes depend on them.
Speed and memory figures belong in `docs/benchmarks.md`.


## Runtime smoke checks performed from the Linux workspace (2026-10-20)

- `resources/whisper/linux-x64/whisper-cli` and `whisper-server` transcribed `tests/fixtures/audio/jfk.wav`
  correctly with `ggml-tiny.en-q5_1.bin` (SHA-256 verified against the pinned catalog digest).
- The Windows build `resources/whisper/win-x64/whisper-cli.exe` was executed under wine 9 with the same
  model and produced the same transcript; its log showed the runtime CPU dispatch choosing
  `ggml-cpu-sapphirerapids.dll` (the host CPU) — i.e. the DLL set loads and selects a variant at runtime.
  This proves the binaries run, not that they run on every Windows machine; the on-device checklist
  above remains required.
- `scripts/qa/whisper-e2e.mjs` runs the built app under Xvfb with the tiny model installed, records with
  Chromium's synthetic microphone (live status reached `listening`, chunks processed with RTF ≈ 0.4 on
  one thread), then queues a background job over a 44 s recording made from the JFK sample: the job
  completed with 10 timestamped segments and the transcript panel showed them.
