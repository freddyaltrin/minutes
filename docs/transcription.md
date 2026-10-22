# Transcription in Minutes

Minutes transcribes meetings with **whisper.cpp**, an open-source
implementation of OpenAI's Whisper speech-recognition model, running entirely
on the user's computer. The model is a neural network; it runs on the CPU
only, in a separate worker process, and nothing is uploaded anywhere. No GPU
is needed and no account exists. Models are files the user downloads once (or
copies in by hand) and can inspect, change or delete in Settings.

The rest of the application stays rule-based: Suggestions, Ask your notes and
search use the deterministic text processing in `src/shared/text/`. No
generative model is involved anywhere.

The conventional Windows recognizer (`System.Speech`, driven through a
PowerShell 5.1 worker) is kept as an optional secondary engine. It needs no
model file but is markedly less accurate; its details are at the end of this
document.

Related documents: `docs/hardware-requirements.md` (what machines are
supported and what to expect on each), `docs/models.md` (the model catalog and
its memory figures), `docs/benchmarks.md` (measured speed and memory),
`docs/limitations.md`, `docs/security.md`, `docs/testing.md`.

## Architecture

```
renderer (Web Audio)            main process                                   worker process
mic + loopback streams  ──►  RecordingService (recording.ts)
                             │  AudioChunk: PCM16, 16 kHz, offsetMs
                             ├─ WavFileWriter  → recordings\<noteId>\…-mic.wav / -system.wav (optional)
                             └─ SpeechChunker  → %TEMP%\minutes\rec-<id>\mic-000001.wav … (at pauses)
                                                  │
                             TranscriptionService (whisper/transcription-service.ts)
                             ├─ ModelManager      <userData>\models\whisper\ggml-<id>.bin
                             ├─ ResourceManager   hardware → profile → model + threads
                             ├─ WhisperEngine ── HTTP POST /inference ──►  whisper-server(.exe)
                             │                   over 127.0.0.1:<random port>  one model loaded
                             ├─ WhisperLiveSession (one per recording)
                             ├─ background job loop (JobsRepo, transcription_jobs table)
                             └─ SapiLiveSession (optional Windows recognizer)
                                                  │
                             TranscriptsRepo ── transcript_segments ──► renderer (transcriptSegments event)
```

**Capture.** The renderer captures the microphone and, on Windows 10 1903 or
later, the system-audio loopback, downsamples to 16 kHz mono PCM16 and pushes
~250 ms chunks over IPC. `RecordingService.pushChunk` appends them to the
optional WAV writers and to one `SpeechChunker` per channel.

**Chunking.** `SpeechChunker` (`src/main/services/transcription/chunker.ts`)
closes a chunk when at least 1 s of trailing audio is below the adaptive
silence threshold after at least 3 s of audio, when the chunk reaches 25 s, or
when the incoming timestamps jump (pause/resume). Chunks that never rise above
the threshold are discarded without being transcribed. Each chunk is written
as a WAV file in the per-recording temp directory and handed to the live
session with its channel (`mic` or `system`) and absolute offset.

**Live session.** `WhisperLiveSession` queues chunk files and transcribes them
one at a time through the engine. Each request carries a Whisper prompt built
from the custom vocabulary (always, joined with commas) followed by the last
300 characters of the previous chunk's text on that channel, truncated to the
last 600 characters, so names keep their spelling and context carries across
chunks. The language field is `en` for `.en` models and the configured
language, or `auto` (whisper.cpp language detection), for multilingual models.
Segment
timestamps are the chunk offset plus the segment's position inside the chunk.
Segments are stored immediately in `transcript_segments` and pushed to the
renderer; the chunk file is deleted only after its segments are stored.

**Engine.** `WhisperEngine` (`whisper-engine.ts`) spawns the bundled
`whisper-server` with `-m <model> -t <threads> --host 127.0.0.1 --port <free
port> --no-gpu`, waits for the HTTP server to answer (which happens only after
the model has loaded; 180 s timeout), then posts each window as a WAV file to
`/inference` with `response_format=verbose_json`, `temperature=0`,
`temperature_inc=0.2`, `suppress_non_speech=true`, the configured language and
the prompt. Requests are serialised: whisper.cpp processes one window at a
time, and a second request would only queue inside the server while holding
memory. The per-request timeout is 600 s. Segment confidence is
`exp(avg_logprob)` clamped to 0..1. One model is loaded at a time; loading
another stops the current process first.

**Background jobs.** A job is a list of sources (chunk files or byte ranges of
a saved recording) in the `transcription_jobs` table (migration 2). For a
saved recording, `planWindows` in `audio-windows.ts` streams the WAV once,
computes 20 ms frame energies, and cuts windows of at most 30 s at the
quietest frame within the last 8 s before the hard boundary. Windows are byte
ranges into the original file, so no audio is copied. The job loop reads one
window at a time, skips windows whose RMS is below 0.004, transcribes the rest
(with the previous window's text on the same channel as the prompt; the
custom vocabulary is not used for background jobs) and persists `processedMs`, `elapsedMs`, `segmentsWritten` and `nextIndex`
after every window. A job interrupted by a crash is returned to `queued` on
the next start and resumes from `nextIndex`.

Two things create background jobs:

- When a live session ends with audio still untranscribed (see "Deferral"
  below), its leftover chunk files are moved from the temp directory into
  `<userData>\pending-audio\<noteId>\` and a job is queued over them. These
  files are deleted only when the job completes or the user removes the job;
  files no job refers to are swept on startup.
- When "Keep audio files" is on, the whisper engine is selected, "Transcribe
  after the meeting" (`backgroundAfterMeeting`) is on **and live transcription
  was unavailable** for that recording (`RecordingService.end`), the saved
  recording is queued as a job. The user can also queue any kept recording from
  the Transcript panel (`jobs.enqueueRecording`); a second job for the same
  recording is refused while one is queued, running or paused.

## The resource manager

`ResourceManager` (`resource-manager.ts`) is pure and deterministic: given the
hardware, the configuration and the installed models it returns a plan with
the model, the thread count, the memory budget and a rationale that Settings
shows verbatim. Hardware comes from `inspectHardware` (`hardware.ts`), which
reads `os.cpus()`, `os.totalmem()`, `os.freemem()` and, on Linux,
`/proc/meminfo` and `/proc/cpuinfo`. On Windows `os.freemem()` is
`GlobalMemoryStatusEx.ullAvailPhys`, which is already "available" memory, so it
is used as such; CPU feature flags are not readable from Node on Windows, so
they are unknown (`featuresReliable: false`) until the worker's first start,
when the `loaded CPU backend from …ggml-cpu-<variant>` line it prints is
mapped to a feature list (`featuresFromHint`). Hardware is re-read when it is
older than 30 s or when the user presses Recheck.

### Profiles

Numbers are from `profiles.ts`.

| Profile | Preferred models, in order | Max threads | Thread fraction | Safety margin | Live chunk reference |
| --- | --- | --- | --- | --- | --- |
| Lightweight | tiny.en-q5_1, tiny-q5_1, tiny.en-q8_0, tiny-q8_0, base.en-q5_1, base-q5_1 | 2 | 0.5 | 768 MB | 12 s |
| Balanced (default) | base.en-q5_1, base-q5_1, base.en-q8_0, base-q8_0, small.en-q5_1, small-q5_1, tiny.en-q5_1, tiny-q5_1 | 6 | 0.5 | 1 GB | 10 s |
| High accuracy | small.en-q5_1, small-q5_1, small.en-q8_0, small-q8_0, medium.en-q5_0, medium-q5_0, large-v3-turbo-q5_0, base.en-q5_1, base-q5_1 | 6 | 0.75 | 1.5 GB | 10 s |
| Custom | only the pinned model | 8 | 0.75 | 1 GB | 10 s |

All profiles allow one concurrent job. The medium, large-v3-turbo and large-v3
families are **pin-only**: they appear in the High accuracy list but are
skipped unless the user pins that exact model (`modelId`), and even then the
memory check applies. The first model in the order that is installed and
eligible wins; a pinned model is tried first, and when it is not installed or
not eligible the plan falls back to the profile list if `allowFallback` is on
(the rationale says so), otherwise nothing is selected and the live session is
refused with that reason. The "Live chunk reference" is used only by the lag
rules below; actual chunk lengths come from the chunker (3–25 s).

`recommendProfile(hw)` picks Lightweight when total memory is below 12 GB, or
there are at most 2 logical cores, or AVX2 is reliably known to be absent;
High accuracy when total memory is at least 28 GB, there are at least 8
logical cores and AVX2 is present or features are unknown; Balanced
otherwise. The recommendation is shown as a tag in Settings; the profile the
user chose is what runs. The default configuration is Balanced, automatic
model, automatic threads, language auto, fallback allowed, transcribe after the
meeting on.

### Memory budget

`budget = available − safetyMargin − bytesHeldByRunningJobs`, floored at 0.

`available` is `availableMemoryBytes` when the OS reports it (Windows,
Linux). When it does not (macOS, or an unreadable `/proc/meminfo`), free
memory is used — unless free is below 5 % of total, in which case free is
treated as meaningless ("free" on Linux/macOS excludes reclaimable cache) and
25 % of total memory is assumed to be available. Each fallback is written into
the plan's rationale. In practice `bytesHeldByRunningJobs` is 0: the service
passes 0 whenever the engine is loaded, because loading a new model replaces
the old process (single-model policy), and when nothing is loaded there is
nothing held.

### Eligibility

```
required = runtimeMemoryBytes(model) + 64 MB × (threads − 1) + 150 MB
eligible = required ≤ budget
```

`runtimeMemoryBytes` comes from the catalog (`model-catalog.ts`): a measured
value when the benchmark harness has written one into `MEASURED_MEMORY`,
otherwise the estimate `120 MB + fileSize × 1.15 + perFamilyCompute` (tiny
60 MB, base 90 MB, small 200 MB, medium 450 MB, large-v3-turbo 500 MB,
large-v3 700 MB). At the time of writing every figure is an estimate and is
labelled so in Settings; `docs/models.md` has the table and
`docs/benchmarks.md` the measurements as they are made. The 64 MB per extra
thread and 150 MB job overhead (chunk buffers, resampled audio, process
baseline) are also estimates. Eligibility notes also mention a CPU without
AVX2 ("expect slow processing"), unknown CPU features, pin-only families and
models not suitable for live use (medium and larger).

### Threads

For the automatic profiles: `floor(logicalCores × threadFraction)`, clamped
to `[1, maxThreads]`, then capped at the estimated physical core count
(logical ÷ 2 on Intel/AMD parts with at least 4 logical cores, except Atom,
Celeron N and Pentium Silver), then capped so that at least one logical core
is left free on machines with 4 or more. For Custom with an explicit thread
count, that count is honoured but never beyond `min(8, logicalCores − 1)`.
Examples: 2 cores → 1 thread; a 4-core/8-thread laptop on Balanced → 4; an
8-core/16-thread desktop on High accuracy → 6; an 8-thread CPU on High
accuracy → 4 (physical-core cap).

### Single-model policy and precedence

`canStartJob` allows at most one unpaused job. A background job never starts
while a live session is running. When a recording starts while a background
job is running, the service pauses the job (`pauseJob`) — the job stops at its
next window boundary and keeps its progress — then loads the live model and
starts the session; when the session ends the job is resumed. If the live
model fails to load, the job is resumed immediately. The job loop also checks
for a live session before every window and yields back to `queued` if one has
started.

### Live adaptation

`adapt()` runs on every chunk fed to a live session (`ADAPT_THRESHOLDS`):

| Condition | Action | What the user sees |
| --- | --- | --- |
| backlog > 60 s, or recent real-time factor > 1.5 | defer to background | "Will finish after the meeting" (amber) |
| backlog > 2 × live chunk reference (20 or 24 s), or recent RTF > 1.0 **with more than one chunk waiting** | warn | "Lagging · N s behind" (amber) |
| otherwise | none | "Transcribing · <model>" / "Processing · N s behind" |

The real-time factor is processing time ÷ audio time over the last 8 chunks,
excluding the first chunk after a model load (graph allocation and page-in make
it unrepresentative). A slow RTF with nothing queued is not reported as lag:
pauses in speech let the engine catch up, and windows of silence or noise
decode slowly without any speech being late. The first Windows installation
showed "Lagging · 0 s behind" under the earlier rule, which was misleading.
**The model is never switched mid-recording**: the only escalation is deferral.
Once deferred, the session stops pulling chunks from its queue; the chunk files
keep accumulating on disk and become a background job when the recording
stops. Nothing is dropped.

### Stopping and the 45 s rule

When a recording stops, remaining chunks finish inline (the pill shows
"Finishing · N chunks left") if the backlog is 45 s or less
(`LIVE_FINISH_INLINE_MS`) and the session was not already deferred. A larger
backlog is handed to a background job instead so the user is not kept
waiting. In both cases every chunk file either gets transcribed or moves to
`pending-audio`; a leftover is never deleted untranscribed.

### Crash containment

The whisper.cpp library runs out of process, so a crash (bad model file,
unsupported instruction, out of memory) ends the worker, not the app. The
engine reports `crashed` with the last stderr lines; the in-flight request
fails with `CRASHED`. The live session puts the chunk back at the head of its
queue and asks the service to restart the engine with the same model and
threads. **At most two restarts per recording session** (`recoverEngine`);
after the second failure the session reports an error, marks itself deferred,
and the remaining chunks become a background job when the recording stops. A
background job that hits a crash fails with the error message and can be
retried from Settings; it resumes at `nextIndex`. Loading never leaves a dead
process behind: a failed or timed-out load stops the child before rejecting.

## Model management

`ModelManager` (`model-manager.ts`) only ever writes bytes to disk; it never
executes anything.

**Catalog.** `model-catalog.ts` lists 26 ggml models from
`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-<id>.bin`
(tiny, base, small, medium in English-only and multilingual, f16/q8_0/q5_1
or q5_0 variants; large-v3-turbo q5_0 and q8_0; large-v3 q5_0). Each entry
carries the exact file size and SHA-256 digest captured from the publisher's
file listing on 2026-10-20 (`resources/whisper/hf-tree-ggerganov-whisper.cpp.json`;
a unit test keeps the two in sync). The weights are MIT-licensed.

**Download.** One in-flight download per model; at most two run concurrently,
the rest wait in order. Bytes stream into `ggml-<id>.bin.part` with a 1 MiB
high-water mark (the file is never buffered in memory) while SHA-256 is
computed incrementally. An existing `.part` is resumed with a `Range` request;
if the server answers 200 instead of 206 the download restarts from zero, and a
206 that resumes at the wrong byte is an error. Progress events are throttled
to about four per second and carry bytes per second. Cancel aborts the request
and keeps the `.part` for a later resume.

**Verify and install.** After the transfer the `.part` size must equal the
catalog size and the digest must equal the pinned SHA-256; on either mismatch
the file is deleted and the model shows an error with the reason. On success
the `.part` is renamed into place atomically, so a model file either exists
complete or not at all. "Verify" in Settings re-hashes an installed file and
marks it `corrupt` on mismatch, offering a re-download.

**Removal.** Refused with "in use" while the engine has that model loaded
(the Remove button is disabled with a tooltip; choose another model or profile
first). Otherwise the model file and any `.part` are deleted. Orphan `.part`
and `.import` files older than 7 days that are not being downloaded are
removed on startup.

**Storage.** Models live in `<userData>\models\whisper\` — on Windows
`%APPDATA%\Minutes\models\whisper\` — separate from the program files, so
updating or reinstalling the app keeps them. Settings shows the folder, the
total of installed models and of temporary files, and can open the folder.

**Offline import.** "Import model file…" opens a file picker for a `.bin`
the user already has (copied from another machine, or downloaded on a
connected one). The file is accepted only if its size and SHA-256 match the
chosen catalog entry; it is copied to `ggml-<id>.bin.import` and renamed into
place. This is the path for machines without internet access.

## The runtime

`resources/whisper/win-x64/` and `resources/whisper/linux-x64/` hold
whisper.cpp 1.9.1 (ggml 0.15.1), built on 2026-10-20 from the v1.9.1 source
tree by `scripts/whisper/build-runtime.sh` with the same options as the
official whisper.cpp Windows x64 release plus `GGML_OPENMP=OFF`:
`BUILD_SHARED_LIBS=ON GGML_NATIVE=OFF GGML_BACKEND_DL=ON
GGML_CPU_ALL_VARIANTS=ON`. The `VERSION` file in each directory records
this. The licence is `resources/whisper/LICENSE.whisper.cpp` (MIT).

`GGML_BACKEND_DL` with all CPU variants means the server loads, at start, the
best CPU backend library the running processor supports. The Windows
directory contains `whisper-server.exe`, `whisper-cli.exe`,
`whisper-bench.exe`, `libwhisper.dll`, `ggml.dll`, `ggml-base.dll` and one
`ggml-cpu-<variant>.dll` for each of: `x64` (generic baseline), `sse42`,
`sandybridge`, `ivybridge`, `haswell`, `piledriver`, `skylakex`,
`cannonlake`, `cascadelake`, `cooperlake`, `icelake`, `alderlake`, `zen4`,
`sapphirerapids`. The Linux directory has the same set as `.so` files. The
app reports which variant was loaded in Settings ("Instruction sets") and
uses it for the AVX2 notes in the plan.

No OpenMP: ggml's own thread pool is used, so there is no `libgomp` or
`libwinpthread` DLL to ship. The Windows build is a MinGW-w64 GCC 13 cross
build with static `libgcc`, `libstdc++` and `winpthread`
(`scripts/whisper/mingw-x64.cmake`), so the executables depend only on
Windows system DLLs. MinGW-w64 headers up to version 11 lack the
`THREAD_POWER_THROTTLING_STATE` declarations that `ggml-cpu.c` uses to opt
threads out of Windows power throttling; `scripts/whisper/mingw-header.patch`
adds the Windows SDK definitions so the behaviour matches the MSVC build.

The engine passes `--no-gpu` and the build contains no CUDA, Vulkan or other
GPU backend; a GPU is neither used nor needed.

## What the user sees

Recording pill (`RecordingControl.tsx`):

| Label | Meaning |
| --- | --- |
| Transcribing · \<model\> | Live session keeping up; tooltip shows threads and speed |
| Processing · N s behind | 3 s or more of audio queued, still within the lag rules |
| Lagging · N s behind | Backlog over two chunk references, or RTF over 1.0 with more than one chunk waiting |
| Will finish after the meeting | Deferred: remaining audio becomes a background job when you stop |
| Finishing · N chunks left | Stopping; small backlog being completed inline |
| Transcription failed | Live session error; tooltip has the message |
| No transcription: \<reason\> | Session could not start (off, runtime missing, no eligible model, load failed) |
| Transcription off | Disabled in Settings |

Settings > Transcription shows the engine choice (whisper, Windows speech,
off), profile cards with the recommended one tagged, the plan ("Will use
\<model\> with N threads", its rationale and "Needs ≈ X of a budget of Y"),
the hardware block, the runtime block (version string, loaded model and load
time, worker process state and resident memory where the platform exposes
it), the model table (Fits / Too large with the shortfall, Not for live, Not
installed / downloading with progress / Verifying checksum… / Installed /
error), the storage line and the background job list (Queued, Running,
Paused, Completed, Failed, Cancelled, with progress, speed, pause/resume/
cancel/retry/remove). The Transcript panel shows "Transcribing in the
background · N %" for a job on the open note.

## Limitations, stated plainly

- Accuracy depends on the model the hardware can afford. Tiny and base give a
  readable draft with punctuation in a quiet room; small is noticeably better;
  medium and larger are not used automatically and are too slow for live use
  on a CPU. Far-field microphones, cross-talk and noise degrade all of them.
- No speaker identification. "Me" is the microphone, "Them" is system audio.
  Two remote participants are not told apart.
- Live text arrives one chunk behind speech: a chunk closes after a 1 s pause
  (once it holds 3 s of audio) or at 25 s, and is then transcribed, so text
  typically appears a few seconds after a sentence ends on a fast machine and
  up to tens of seconds on a slow one. Settings currently says "about one
  chunk (10–12 s)"; the chunker's figures above are the ones the code uses.
- Whisper can hallucinate plausible text on silence or music. Silent windows
  are skipped by RMS and `suppress_non_speech` is set, but short bursts of
  invented text on noise remain possible. Every segment carries a confidence
  value derived from the model's own token probabilities; it is a hint, not a
  guarantee.
- Memory figures are estimates until `docs/benchmarks.md` replaces them.
  Eligibility is a planning check, not a reservation: another application
  taking memory after the plan can still push the worker into swapping or an
  out-of-memory crash, which is contained as described above.
- The first load of a model takes seconds (longer on slow disks); the pill
  shows no text until the first chunk has been transcribed.
- Only one model is loaded at a time and only one job runs at a time, so a
  long backlog of background jobs is processed strictly in order.
- Language is one setting for the whole recording. When it is left on
  "Automatic" the engine sends no `language` field and `whisper-server` falls
  back to its own default, which is English (`-l en`); real language detection
  would need `language=auto` to be sent, which the current code does not do.
  The Settings help text ("Automatic lets the model detect the language")
  overstates this. Pick the language explicitly for non-English meetings and
  use a multilingual (non-`.en`) model.
- Windows only for the shipped runtime (`win-x64`); the Linux runtime exists
  for development and tests. See `docs/hardware-requirements.md`.
- Custom vocabulary is sent as part of the Whisper prompt with every chunk
  (see "Live session"). It biases the spelling of names and jargon; it does not
  add words the model cannot hear, and very long lists crowd out the rolling
  context (the prompt keeps its last 600 characters).

## The optional Windows recognizer

Selecting "Windows speech" as the engine uses `System.Speech` (SAPI 5.x)
through `resources/sapi/recognizer.ps1` under Windows PowerShell 5.1, as the
first version of Minutes did. It needs a Windows speech recognition language
pack and an unblocked `powershell.exe`; Settings shows the probe result and
installed cultures. Chunks are the same files the chunker produces; the worker
transcribes them one at a time with `SetInputToWaveFile` + `Recognize()`,
returns confidence and timing per utterance, and loads the custom vocabulary
as a low-weight `Choices` grammar beside dictation. It has no model to
download, no memory planning, no background jobs and no deferral; a crashed
worker ends transcription for that recording. Its accuracy is well below
whisper's on meeting audio. Protocol details are in
`src/main/services/transcription/sapi-engine.ts` and the worker script; unit
tests drive it with a fake child process.

## Files

- `src/main/services/whisper/whisper-engine.ts` — worker process host and HTTP client
- `src/main/services/whisper/transcription-service.ts` — orchestration, live sessions, job loop
- `src/main/services/whisper/resource-manager.ts` — budget, eligibility, threads, plan, job policy, lag rules
- `src/main/services/whisper/profiles.ts` — profile table, defaults, `recommendProfile`
- `src/main/services/whisper/hardware.ts` — hardware inspection and CPU-variant hints
- `src/main/services/whisper/model-catalog.ts` — the 26 models with sizes, digests and memory estimates
- `src/main/services/whisper/model-manager.ts` — download, resume, verify, install, remove, import
- `src/main/services/whisper/audio-windows.ts` — windowing of saved recordings
- `src/main/services/recording.ts`, `src/main/services/transcription/chunker.ts`, `wav.ts` — capture side
- `src/main/db/jobs-repo.ts`, `src/main/db/migrations.ts` (version 2) — job persistence
- `src/shared/transcription-types.ts`, `src/shared/api.ts` — types and the IPC surface
- `src/renderer/src/components/settings/transcription/` — Settings UI
- `resources/whisper/`, `scripts/whisper/` — the runtime and how it is built
- `tests/unit/whisper/`, `tests/integration/*.int.test.ts` — tests (see `docs/testing.md`)
