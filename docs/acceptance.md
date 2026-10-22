# Acceptance checklist (status at 0.2.3)

Each line states what was actually verified, where, and what remains to be checked on a Windows machine.
"Verified (Linux VM)" means the behaviour was exercised in the built application under Xvfb with Playwright
or by the unit tests in this repository; the Windows-only paths are listed separately.

| Criterion | Status | Evidence |
|---|---|---|
| Application launches | Verified (Linux VM, dev and packaged asar builds) | `tests/e2e/app.spec.ts`, `scripts/qa/packaged.mjs` |
| Visually cohesive, not a generic dashboard | Verified by screenshot audit in light and dark themes | `docs/screenshots/` |
| Notes create / edit / autosave / search / archive / delete | Verified | e2e tests 2, 3, 5; `tests/unit/db/notes-repo.test.ts` |
| Data persists across restart | Verified | e2e test 2 relaunches with the same data directory |
| Folders, tags, favorites, pin, duplicate, trash with undo | Verified | unit tests + manual QA scripts |
| Offline search (FTS5) | Verified; no network code in the search path | `tests/unit/db/search-repo.test.ts` |
| Editor responsive with long notes | Measured: 20k-word note, ~24 ms keystroke-to-paint under software rendering | `docs/limitations.md` |
| Audio capture | Verified with Chromium's synthetic microphone: real `getUserMedia` → AudioWorklet → 16 kHz PCM → WAV on disk | `scripts/qa/record.mjs` |
| System-audio (WASAPI loopback) | Failed on Windows in 0.2.0/0.2.1 (`AbortError`: Chromium rejects a display-media answer without a video source). Fixed in 0.2.2 by answering with the requesting frame as the video source; verified on Windows that capture now starts (both channels active, no error). Transcription of loopback content not yet exercised | `src/main/index.ts`, `docs/limitations.md` |
| Transcription runs locally on the CPU, nothing uploaded | Verified: whisper.cpp 1.9.1 runtime bundled in `resources/whisper`, spawned with `--no-gpu`, bound to 127.0.0.1; the only network use is the model download the user requests (see the second table) | `docs/transcription.md`, `docs/security.md` |
| No generative model, no paid API, no account | Verified: Suggestions, Ask and search are rule-based (`src/shared/text/`); no API keys, no sign-in; no npm AI dependency (the speech model is a native binary plus a data file) | `package.json`, source grep |
| Never fabricates transcripts | Verified: segments come only from the whisper worker's response for the audio posted to it, the optional recognizer worker, imports or manual entry. Whisper-style hallucination on non-speech audio is a model limitation, disclosed | `src/main/services/whisper/transcription-service.ts`, `docs/limitations.md` |
| Deterministic text features work | Verified | `tests/unit/text/*` (169 tests), e2e test 4 |
| Export and backup work | Verified | `tests/unit/services/backup.test.ts`, export renderers tested |
| Settings persist | Verified | `tests/unit/db/migrations.test.ts` (SettingsRepo), e2e |
| Keyboard shortcuts work | Verified (renderer fallback path); native `before-input-event` path **needs Windows verification** | e2e tests use Ctrl+N/K/T/Shift+Backspace |
| Usable without a cloud account | Verified: no sign-in exists | — |
| Core functionality offline | Verified: no network calls except ICS refresh and update checks, both optional | `docs/security.md` |
| Updates do not destroy user data | Verified by design: user data, including downloaded models (`models\whisper`) and pending audio, lives in `%APPDATA%\Minutes`, outside the install directory; `deleteAppDataOnUninstall: false` | `electron-builder.yml`, `model-manager.ts` |
| Security controls reviewed | Verified | `docs/security.md`, e2e test 6 |
| Automated tests executed | Verified: 450 unit tests (26 files) and 6 integration tests (2 files, run when the Linux runtime and a test model are present), 7 e2e tests passing | `docs/testing.md` |
| Production build succeeds | Verified: `Minutes-Setup-0.1.0.exe`, `latest.yml`, blockmap produced | `release/` |
| Clean installation tested | Verified on Windows 11 (build 26200), 2026-10-20: NSIS per-user install of 0.2.0, in-place upgrade to 0.2.1 with notes, settings and downloaded models preserved, automatic backup taken at first start of the new version | On-device session; `%APPDATA%\Minutes\backups` |
| Documentation matches implementation | Verified by a documentation pass against the code | `README.md`, `docs/` |
| Known limitations disclosed | Verified | `docs/limitations.md` |

## Hardware-adaptive transcription (whisper.cpp)

Criteria from the transcription brief. "Verified (Linux VM)" means the integration tests in `tests/integration/` ran against the real
Linux runtime with `ggml-tiny.en-q5_1.bin`; "unit-tested" means the behaviour is proved with the fake engine or a fake `fetch` in
`tests/unit/whisper/`. The first on-device run took place on 2026-10-20 on a Windows 11 laptop (Intel Core Ultra 7 255U, 14 logical cores, 16 GB,
AVX2/FMA, 2.1 GB available with the usual office applications open). Rows marked "Verified (Windows)" come from that run.

| Criterion | Status | Evidence |
|---|---|---|
| CPU-only inference works | Verified (Linux VM): model load, transcription with timestamps, crash and reload. Verified (Windows): the cross-built `whisper-server.exe` loaded `base.en-q5_1` in 9.1 s on the laptop above and served a 93 s live session (4 threads). The only text produced was a hallucinated stock phrase because nobody spoke during the test — accuracy on real speech on Windows is **still unmeasured** | `tests/integration/whisper-engine.int.test.ts`, `%APPDATA%\Minutes\logs\minutes.log` |
| No GPU required | Verified: the build has no GPU backend and the server is started with `--no-gpu`; the Linux VM has no GPU | `scripts/whisper/build-runtime.sh`, `whisper-engine.ts` |
| Model manager works (download, resume, verify, atomic install, remove, import) | Unit-tested with a fake `fetch` and a temp directory: fresh download, Range resume, 200-on-Range restart, size and sha256 mismatch handling, HTTP errors, dedupe and concurrency cap, cancel keeps `.part`, remove refused while in use, verify flags tampering, storage sums, orphan cleanup, offline import. Verified (Windows): `tiny.en-q5_1` (31 MB) and `base.en-q5_1` (57 MB) downloaded from huggingface.co through the in-app manager, digest-verified and installed in about 10 s each | `tests/unit/whisper/model-manager.test.ts`, on-device run |
| Downloads are optional | Verified: no download starts without the user pressing Download; "Import model file…" installs a `.bin` offline after size and digest checks | `model-manager.ts`, `ModelManager.tsx` |
| Resource checks before loading a model | Unit-tested: budget = available − margin, eligibility = runtime + 64 MB/thread + 150 MB ≤ budget, unreliable-free fallback, thread rule; `startLive` refuses with a reason when nothing is eligible and never loads. Verified (Windows): with the original 2.5 GB Balanced margin the laptop's 2.1 GB available gave a zero budget and every model was refused — correct by the rule, useless in practice — so the margins were reduced to 768 MB / 1 GB / 1.5 GB (`docs/hardware-requirements.md`); the same machine then planned `base.en-q5_1` ("needs ~617 MB of 902 MB") | `tests/unit/whisper/resource-manager.test.ts`, `transcription-service.test.ts` |
| Low-resource machine gets a conservative model | Unit-tested: 8 GB / 2-core / no-AVX2 → Lightweight → tiny; medium/large never auto-selected even when installed; pinned medium on 8 GB falls back with rationale | `tests/unit/whisper/profiles.test.ts`, `resource-manager.test.ts` |
| UI is not blocked by transcription | Verified by design: inference runs in a separate OS process reached over HTTP; the main process awaits responses asynchronously; renderer gets typed status events. Not measured on Windows | `whisper-engine.ts`, `docs/transcription.md` |
| Pending audio is never discarded | Verified (Linux VM + unit): chunk files are deleted only after their segments are stored; a lagging or crashed session keeps its chunks and `stop()` moves leftovers to `pending-audio` and queues a job; `removeJob` deletes its pending files but never a user recording | `transcription-service.test.ts` (lag deferral, crash containment, removeJob), `transcription-service.int.test.ts` |
| Incremental persistence of background jobs | Verified (Linux VM): `processedMs`, `segmentsWritten` and `nextIndex` written after every window; interrupted (`running`) jobs re-queued on start and resumed from `nextIndex` | `transcription-service.int.test.ts`, `transcription-service.test.ts` (interrupted-job recovery) |
| Retry | Verified (Linux VM): cancel → cancelled; retry → completes with `attempts ≥ 2`; crashed engine restarted up to twice per session, chunk retried | `transcription-service.int.test.ts`, `transcription-service.test.ts` |
| Models survive application updates | Verified by design: models live in `%APPDATA%\Minutes\models\whisper`, not under the install directory, and the uninstaller leaves `%APPDATA%\Minutes` alone | `model-manager.ts` (`resolveModelsDir`), `electron-builder.yml` |
| User can inspect and change the model | Verified: Settings lists every catalog model with size, memory estimate, fit verdict and install state; profile cards, a model pin, a thread override and the plan's rationale are shown | `ModelManager.tsx`, `ProfilePicker.tsx`, `StatusBlocks.tsx` |
| Honest performance communication | Verified: pill shows "Lagging · N s behind" and "Will finish after the meeting"; plan shows "Needs ≈ X of a budget of Y"; memory figures are labelled estimates until measured; limitations stated | `RecordingControl.tsx`, `StatusBlocks.tsx`, `docs/limitations.md` |
| Automated tests | Verified: 6 unit test files (hardware, catalog, model manager, profiles, resource manager, transcription service with a fake engine) and 2 integration files, all passing | `docs/testing.md` |
| Benchmarks | Procedure and results are in `docs/benchmarks.md`; until measured, every memory figure in the catalog is an estimate (`memoryMeasured: false`) | `docs/benchmarks.md`, `model-catalog.ts` |
| Installer carries the runtime | Verified (Windows): Diagnostics on the installed app reports "whisper.cpp runtime (CPU, 14 CPU backend variants)" and the model loaded from `resources\whisper\win-x64` | `electron-builder.yml`, on-device diagnostics export |

## Open items after the first Windows run (2026-10-20)

- System-audio loopback: verified on Windows with 0.2.2 — the recording started with both channels, no AbortError, and the
  pill showed the system-activity dot. Whether loopback audio is actually transcribed (a call in another app) is still to
  be checked; the test machine was playing nothing.
- Live speed on Windows: a 2 min 47 s recording of background office speech with `base.en-q5_1` at 4 threads fell up to
  22 s behind, then caught up and finished inline. 0.2.3 raises the Balanced thread cap to 6; the effect is unmeasured.
- Live accuracy on Windows: the same recording produced recognisable phrases from background speech plus repetition loops
  and prompt echoes; 0.2.3 drops both (`segment-filter.ts`). Accuracy on a real meeting with a close microphone is unmeasured.
- Benchmarks for base and small (`docs/benchmarks.md`) remain unverified.
- The global shortcut Ctrl+Shift+R could not be registered on the test laptop (another application holds it); recording
  from the button and the tray works. A fallback accelerator is not yet implemented.
