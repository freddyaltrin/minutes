# Hardware requirements

What Minutes needs to run, what transcription needs on top of that, and what
to expect on three representative office machines. Figures marked "estimate"
come from the model catalog's memory model (`src/main/services/whisper/model-catalog.ts`);
measured values, as they are produced, live in `docs/benchmarks.md` and
replace the estimates in the catalog. How the numbers are used is explained in
`docs/transcription.md` ("The resource manager").

## Minimum

| Component | Requirement | Why |
| --- | --- | --- |
| Operating system | Windows 10 or 11, 64-bit (x64) | The shipped whisper.cpp runtime is `resources/whisper/win-x64`; the installer is built for x64 only |
| System-audio capture | Windows 10 version 1903 or later | Chromium's WASAPI loopback. Older builds record the microphone only |
| CPU | 64-bit x86. SSE4.2 is the practical floor; **AVX2 strongly recommended** | The runtime ships CPU-dispatch variants down to a generic `x64` and an `sse42` build, so it loads on any x86-64 CPU, but processors without AVX2 (roughly, Intel before Haswell/2013 and AMD before Excavator/2015) run the models markedly slower and are planned onto the Lightweight profile when that is known |
| Memory | 8 GB total for the Lightweight profile; 16 GB for Balanced; 32 GB for High accuracy | See the profile table below |
| Disk | Program ≈ 41 MB for the runtime plus the app; models 31 MB–1 GB each (see below) | Models are stored under `%APPDATA%\Minutes\models\whisper` |
| GPU | None | Inference is CPU-only (`--no-gpu`; the build has no GPU backend) |
| Network | Only to download models (huggingface.co) and optionally updates and calendar feeds | Models can be imported from a file on machines without internet |

Notes, search, suggestions, calendar, export and backup have no requirement
beyond running the app. The optional Windows speech recognizer engine needs
Windows PowerShell 5.1 and a Windows speech recognition language pack instead
of a model file.

## Memory expectations per profile

The resource manager keeps a per-profile safety margin free for the operating
system, the conferencing application and the Minutes window, and plans a
model only when `estimated memory of the model + 64 MB per extra thread +
150 MB ≤ available memory − safety margin`. "Available" is what Windows
reports as available physical memory at planning time, not total memory.

The margins were first set at 1.5 / 2.5 / 4 GB. The first installation on a real
office laptop (Core Ultra 7, 16 GB, 2026-10-20) had only 2.1 GB available with
Chrome, Word, Excel and a mail client open, so every model — tiny included, at
≈ 0.5 GB — was refused and recording was blocked. The margins were reduced to
the figures below: they are the headroom that remains for Windows and the other
applications *after* the worker has loaded, and about 1 GB is what keeps the
machine out of paging. The per-model requirement is still charged in full.

| Profile | Safety margin | Models tried first | Model estimate (file → process, estimate) | Worker need at the profile's typical thread count (estimate) |
| --- | --- | --- | --- | --- |
| Lightweight | 768 MB | tiny.en-q5_1 / tiny-q5_1 | 31 MB → ≈ 215 MB | ≈ 365 MB at 1 thread, ≈ 430 MB at 2 |
| Balanced | 1 GB | base.en-q5_1 / base-q5_1 | 57 MB → ≈ 275 MB | ≈ 617 MB at 4 threads, ≈ 745 MB at 6 (≈ 490 MB at 2) |
| High accuracy | 1.5 GB | small.en-q5_1 / small-q5_1 | 181 MB → ≈ 528 MB | ≈ 870 MB at 4 threads, ≈ 1.0 GB at 6 |
| Custom (pinned) | 1 GB | whatever is pinned | medium.en-q5_0: 514 MB → ≈ 1.13 GB; large-v3-turbo-q5_0: 547 MB → ≈ 1.22 GB; large-v3-q5_0: 1.0 GB → ≈ 1.96 GB | medium ≈ 1.5 GB, large-v3-turbo ≈ 1.6 GB, large-v3 ≈ 2.3 GB at 4 threads |

Measured exception (2026-10-20, `docs/benchmarks.md`): `tiny.en-q5_1` carries a measured 140 MB
(peak of 123 MB with the ≤ 30 s windows the app actually sends, on a 2-core Linux VM, plus
headroom), so the Lightweight worker is budgeted at ≈ 290 MB at 1 thread rather than the ≈ 365 MB
estimate above. No other model has been measured yet.

The whole application therefore wants roughly: Lightweight ≈ 2 GB of
headroom (margin + worker) on an 8 GB machine, Balanced ≈ 3.1 GB on a 16 GB
machine, High accuracy ≈ 5 GB on a 32 GB machine. When the budget is short
the plan explains the shortfall ("free ~X of memory or install <smaller
model>") rather than loading anyway.

## The three target configurations

`recommendProfile()` in `profiles.ts` picks a profile from the hardware alone:
Lightweight below 12 GB total memory, or with 2 or fewer logical cores, or
when AVX2 is reliably known to be absent; High accuracy at 28 GB or more with
8 or more logical cores and AVX2 present (or CPU features unknown, which is
the case on Windows before the worker's first start); Balanced otherwise.
The thread count is `floor(logical cores × fraction)` capped by the profile
maximum, the estimated physical core count and "leave one core free".

| Configuration | Recommended profile | Model that lands | Threads | Notes |
| --- | --- | --- | --- | --- |
| Low-end office PC: 8 GB RAM, 2 cores (or an older 4-core CPU without AVX2) | Lightweight | tiny.en-q5_1 (English) or tiny-q5_1 (multilingual); base only if the tiny models are not installed | 1 (2 cores) or 2 (4 cores) | Live transcription is basic; expect "Lagging" on long, pause-free speech. A background pass with base after the meeting is the better result when memory allows |
| Typical laptop: 16 GB RAM, 4 cores / 8 threads, AVX2 | Balanced | base.en-q5_1 / base-q5_1; small only when base is not installed; tiny as last resort | 4 | Live keeps up with base on most AVX2 laptops; whether small should become the default here is to be settled by `docs/benchmarks.md` |
| Workstation: 32 GB RAM, 8 cores / 16 threads, AVX2 | High accuracy | small.en-q5_1 / small-q5_1; medium and large-v3-turbo only if pinned explicitly | 6 (4 on an 8-thread CPU, because of the physical-core cap) | Medium and larger are never used for live transcription automatically; they are suitable for background jobs when pinned |

Settings shows the recommendation as a "Recommended" tag; the profile the
user selects is what runs, and the Custom profile accepts any installed
model and thread count within the machine's limits.

## Disk space for models

| Model family | Smallest shipped variant | Largest shipped variant |
| --- | --- | --- |
| tiny | 31 MB (q5_1) | 74 MB (f16) |
| base | 57 MB (q5_1) | 141 MB (f16) |
| small | 181 MB (q5_1) | 465 MB (f16) |
| medium | 514 MB (q5_0) | 1.43 GB (f16) |
| large-v3-turbo | 547 MB (q5_0) | 834 MB (q8_0) |
| large-v3 | 1.01 GB (q5_0) | — |

A typical installation holds one or two models (under 300 MB). During a
download the partial file (`.part`) occupies the same space as the finished
model; a cancelled download keeps it for resuming. Kept recordings cost
1.9 MB per minute per channel (16 kHz mono 16-bit WAV).

## Not supported

- 32-bit Windows. The installer and the runtime are x64 only.
- Windows on ARM. The x64 runtime may run under emulation but this is untested
  and would be slow; no ARM64 runtime is built.
- GPU acceleration. Not used and not needed; a discrete GPU brings nothing.
- macOS and Linux as end-user platforms. The Linux runtime in
  `resources/whisper/linux-x64` exists for development and the integration
  tests; notes, search and the editor run wherever Electron runs, but no
  behaviour on those platforms is claimed.

## Known limitations

- CPU features are not readable on Windows until the worker has started once,
  so a first plan on a machine without AVX2 may recommend Balanced; after the
  first recording the detected variant is used and the recommendation adjusts.
  The user's chosen profile is never changed automatically.
- Memory planning is a check at load time, not a reservation. A conferencing
  client or browser that grows after the plan can still starve the worker; an
  out-of-memory crash is contained (the worker is restarted up to twice per
  session, then the audio is deferred to a background job).
- Speed depends on the CPU variant the runtime selects, the thread count and
  what else is running; the status pill reports the real-time factor and
  backlog honestly rather than promising a number. Measured figures are in
  `docs/benchmarks.md`.
- Laptops on battery may throttle; the runtime opts its worker threads out of
  Windows power throttling (the MinGW header patch exists for exactly this),
  but the OS can still lower clocks.
