# Whisper models

The whisper.cpp ggml models Minutes can download, verify and run. The catalog is
`src/main/services/whisper/model-catalog.ts`; sizes and sha256 digests are the publisher's own
(`https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main`, captured 2026-10-20 in
`resources/whisper/hf-tree-ggerganov-whisper.cpp.json`; `tests/unit/whisper/model-catalog.test.ts`
asserts the two stay in sync). Memory figures are **estimates** except where marked **measured**;
measured values come from `docs/benchmarks.md` and are written into `MEASURED_MEMORY` in the catalog.

## Catalog

File name is `ggml-<id>.bin`, download URL `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-<id>.bin`.
Memory = peak resident memory of the `whisper-server` process with the model loaded and audio in
flight; "est." = `120 MB + file size × 1.15 + per-family compute` (tiny 60 MB, base 90 MB, small
200 MB, medium 450 MB, large-v3-turbo 500 MB, large-v3 700 MB), a model fitted to the whisper.cpp
README's f16 total-memory figures. Sizes in MiB.

| Id | Name | File size | Memory | Quantization | Languages | Live use | Speed class | Accuracy class | License |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tiny.en-q5_1 | Tiny (English, q5_1) | 31 MB | **140 MB measured** (see note) | q5_1 | English | yes | fastest | basic | MIT |
| tiny.en-q8_0 | Tiny (English, q8_0) | 42 MB | 228 MB est. | q8_0 | English | yes | fastest | basic | MIT |
| tiny.en | Tiny (English, f16) | 74 MB | 265 MB est. | f16 | English | yes | fastest | basic | MIT |
| tiny-q5_1 | Tiny (Multilingual, q5_1) | 31 MB | 215 MB est. | q5_1 | multilingual | yes | fastest | basic | MIT |
| tiny-q8_0 | Tiny (Multilingual, q8_0) | 42 MB | 228 MB est. | q8_0 | multilingual | yes | fastest | basic | MIT |
| tiny | Tiny (Multilingual, f16) | 74 MB | 265 MB est. | f16 | multilingual | yes | fastest | basic | MIT |
| base.en-q5_1 | Base (English, q5_1) | 57 MB | 275 MB est. | q5_1 | English | yes | fast | fair | MIT |
| base.en-q8_0 | Base (English, q8_0) | 78 MB | 300 MB est. | q8_0 | English | yes | fast | fair | MIT |
| base.en | Base (English, f16) | 141 MB | 372 MB est. | f16 | English | yes | fast | fair | MIT |
| base-q5_1 | Base (Multilingual, q5_1) | 57 MB | 275 MB est. | q5_1 | multilingual | yes | fast | fair | MIT |
| base-q8_0 | Base (Multilingual, q8_0) | 78 MB | 300 MB est. | q8_0 | multilingual | yes | fast | fair | MIT |
| base | Base (Multilingual, f16) | 141 MB | 372 MB est. | f16 | multilingual | yes | fast | fair | MIT |
| small.en-q5_1 | Small (English, q5_1) | 181 MB | 528 MB est. | q5_1 | English | yes (marginal on weak CPUs) | moderate | good | MIT |
| small.en-q8_0 | Small (English, q8_0) | 252 MB | 610 MB est. | q8_0 | English | yes (marginal on weak CPUs) | moderate | good | MIT |
| small.en | Small (English, f16) | 465 MB | 855 MB est. | f16 | English | yes (marginal on weak CPUs) | moderate | good | MIT |
| small-q5_1 | Small (Multilingual, q5_1) | 181 MB | 528 MB est. | q5_1 | multilingual | yes (marginal on weak CPUs) | moderate | good | MIT |
| small-q8_0 | Small (Multilingual, q8_0) | 252 MB | 610 MB est. | q8_0 | multilingual | yes (marginal on weak CPUs) | moderate | good | MIT |
| small | Small (Multilingual, f16) | 465 MB | 855 MB est. | f16 | multilingual | yes (marginal on weak CPUs) | moderate | good | MIT |
| medium.en-q5_0 | Medium (English, q5_0) | 514 MB | 1161 MB est. | q5_0 | English | no (pin only, background jobs) | slow | high | MIT |
| medium-q5_0 | Medium (Multilingual, q5_0) | 514 MB | 1161 MB est. | q5_0 | multilingual | no (pin only, background jobs) | slow | high | MIT |
| medium.en-q8_0 | Medium (English, q8_0) | 785 MB | 1473 MB est. | q8_0 | English | no (pin only, background jobs) | slow | high | MIT |
| medium-q8_0 | Medium (Multilingual, q8_0) | 785 MB | 1473 MB est. | q8_0 | multilingual | no (pin only, background jobs) | slow | high | MIT |
| medium | Medium (Multilingual, f16) | 1463 MB | 2252 MB est. | f16 | multilingual | no (pin only, background jobs) | slow | high | MIT |
| large-v3-turbo-q5_0 | Large v3 Turbo (Multilingual, q5_0) | 547 MB | 1250 MB est. | q5_0 | multilingual | no (pin only, background jobs) | very-slow | highest | MIT |
| large-v3-turbo-q8_0 | Large v3 Turbo (Multilingual, q8_0) | 834 MB | 1579 MB est. | q8_0 | multilingual | no (pin only, background jobs) | very-slow | highest | MIT |
| large-v3-q5_0 | Large v3 (Multilingual, q5_0) | 1031 MB | 2006 MB est. | q5_0 | multilingual | no (pin only, background jobs) | very-slow | highest | MIT |

License for every entry: MIT (whisper.cpp conversion of OpenAI's Whisper weights, which are MIT).
The runtime's licence text ships in `resources/whisper/LICENSE.whisper.cpp`.

"Speed class" and "accuracy class" are the catalog's qualitative labels per family; only
`tiny.en-q5_1` has measured speed figures (`docs/benchmarks.md`: whole-file RTF 0.075 and live-like
RTF 0.22 at 2 threads on a 2-core AVX-512 VM). The other classes are untested relative orderings.
`medium`, `large-v3-turbo` and `large-v3` are never auto-selected by any profile (`PIN_ONLY_FAMILIES`
in `profiles.ts`); they are used only when pinned in Settings and the memory check passes.

### Note on the tiny.en-q5_1 measured figure

140 MB is the catalog value for `tiny.en-q5_1`, derived from a `whisper-server` peak RSS (VmHWM) of
123 MB after three consecutive 30 s requests at 2 threads on the Linux VM (2026-10-20), plus
headroom. 30 s is the largest window the app sends (live chunks ≤ 25 s, background windows ≤ 30 s).
The benchmark's whole-file pass of a 7.4-minute recording peaked at 306 MB, which is why whole files
are never sent in one request. Estimates for the other models are on a comparable basis (catalog
formula in `model-catalog.ts`) but have not been measured yet; see `docs/benchmarks.md` for the
procedure that fills them in.

## Download, verification and storage (model-manager.ts)

Models live in `<userData>/models/whisper/` (`%APPDATA%\Minutes\models\whisper` on Windows), apart
from the application binaries so updates keep them. The manager only writes bytes; it never executes
a model file.

**Download**

- One in-flight download per model id (a second call returns the same promise); at most 2 downloads
  run concurrently, the rest wait in FIFO order.
- Bytes stream into `<file>.part` with a 1 MiB high-water mark; the file is never buffered in memory.
- An existing `.part` is resumed with `Range: bytes=<n>-`. A `206` continues (the `Content-Range`
  start must equal the partial size, otherwise the download fails as `HTTP`); a `200` means the server
  ignored the range and the `.part` is truncated and restarted. Any other status fails with the code.
- sha256 is computed incrementally while streaming; on a resume the existing `.part` is hashed first.
- Progress events are throttled to about 4 per second and carry received bytes, total bytes and
  bytes per second.
- Cancel aborts the transfer and **keeps** the `.part` for a later resume; the state returns to
  `not-installed`.
- Errors are typed: `HTTP`, `NETWORK`, `SIZE_MISMATCH`, `HASH_MISMATCH`, `UNKNOWN_MODEL`, `IN_USE`,
  `BAD_SOURCE`, `CANCELLED`.

**Verification**

- After the transfer the size must equal the catalog's `sizeBytes` and the sha256 digest must equal
  the catalog's `sha256`. On either mismatch the `.part` is deleted and the model enters `error`
  with a message naming the mismatch; the user retries from zero.
- Only after both checks pass is the `.part` atomically renamed to `ggml-<id>.bin`.
- `verify(id)` re-hashes an installed file on demand; a mismatch marks it `corrupt` (the file is
  left in place so the user sees the state; `download(id)` then re-downloads it).

**Import (offline machines)**

- `importFromFile(sourcePath, id)` accepts a user-supplied file for a catalog id: size is checked
  first, then sha256; only a file identical to the published one is accepted. It is copied to
  `<file>.import` and renamed into place; any stale `.part` for that id is removed.

**Storage and housekeeping**

- States: `not-installed`, `downloading`, `verifying`, `installed`, `error`, `corrupt`.
- `remove(id)` deletes the model and any `.part`; it is refused with `IN_USE` while the engine has
  that model loaded.
- `storageUsage()` reports the models directory, bytes held by installed catalog models, bytes in
  temporary `.part`/`.import` files and the installed count. Files in the directory that are not
  catalog models are ignored.
- `cleanupTemp()` removes `.part`/`.import` files older than 7 days that no active download owns.
- The engine loads one model at a time (single-model policy); switching models restarts the
  `whisper-server` process, which for the tiny model took 112–150 ms in the benchmark.
