# Transcription benchmarks

Measured speed, memory and accuracy of the whisper.cpp runtime Minutes ships, produced with
`scripts/bench/whisper-bench.mjs` (procedure in `scripts/bench/README.md`). Every number in this
file comes from a JSON file in `docs/benchmarks/`; nothing is estimated here except where the word
"estimate" appears, and nothing has been measured on Windows yet (see "Unverified").

Status on 2026-10-20:

- **Measured:** `tiny.en-q5_1` at 1 and 2 threads, Linux, 2-core virtual machine (below).
- **Not measured:** every other catalog model. `base.en-q5_1`, `base-q5_1` and `small.en-q5_1` were
  requested for this run but the model files could not be obtained on the benchmark VM (the download
  host was blocked by the network policy), so the harness recorded them as skipped. The Balanced and
  High-accuracy recommendations below are therefore still **unverified**.
- **Not measured:** any Windows machine, any machine without AVX2, any machine with more than 2 cores.

## Definitions

- **RTF (real-time factor)** = processing wall time ÷ audio duration. RTF 0.25 means a minute of
  audio takes 15 s. Live transcription needs RTF < 1 with margin; the resource manager warns
  ("Lagging") when the backlog grows.
- **Whole-file** = the entire file in one `/inference` request. This is faster per second of audio
  than chunking because whisper.cpp pads every request to a 30 s window: a 12 s chunk costs about as
  much as a 30 s one.
- **Live-like** = the file split into ≤ 12 s chunks (the Lightweight profile's chunk length) posted
  sequentially, the previous chunk's text passed as prompt, as the live pipeline does. **Lag** =
  cumulative processing time − cumulative audio time (negative: the worker is ahead of the recorder).
  **Max queue lag** = the largest backlog a real-time recorder would have seen (a chunk that takes
  longer than its own 12 s adds to it; faster chunks drain it).
- **Peak RSS** = `VmHWM` of the `whisper-server` process (lifetime high-water mark), polled every
  200 ms. On Windows the equivalent is `PeakWorkingSet64`.
- **CPU (cores)** = (user + system CPU time of the worker) ÷ wall time during the request.
- **WER** = word-level Levenshtein distance ÷ reference words after lower-casing and stripping
  punctuation; numbers are compared as written. Only files with a reference transcript get a WER.
  Files without one get **completeness** figures (words, segments, fraction of the audio covered by
  the last segment end), which say whether the output is plausibly complete and **say nothing about
  accuracy**.
- **Max tick delay** = worst delay of a 100 ms timer inside the Node bench process while the worker
  was busy. It stands in for UI responsiveness: inference runs in a separate process, so the only
  thing that can delay the Node side is CPU contention.

## Environment: Linux VM, 2 cores, no GPU (2026-10-20)

Source: `docs/benchmarks/2026-10-20T12-40Z-linux-vm-2core.json`.

| Item | Value |
| --- | --- |
| CPU | `Intel(R) Xeon(R) Processor @ 2.10GHz` (from `/proc/cpuinfo`), **2 logical cores**, `hypervisor` flag set (virtual machine) |
| ISA | sse4_2 avx avx2 fma f16c avx512f avx512bw avx512_vnni avx_vnni avx512_bf16 amx_tile amx_int8 |
| CPU variant the runtime loaded | `libggml-cpu-sapphirerapids.so` (`load_backend: loaded CPU backend from …/libggml-cpu-sapphirerapids.so`) |
| whisper-bench `system_info` | `AVX = 1 \| AVX2 = 1 \| F16C = 1 \| FMA = 1 \| BMI2 = 1 \| AVX512 = 1 \| AVX512_VBMI = 1 \| AVX512_VNNI = 1 \| AVX512_BF16 = 1 \| AMX_INT8 = 1 \| OPENMP = 1 \| REPACK = 1` |
| RAM | 7.8 GiB total, no swap |
| Kernel / Node | Linux 6.18.44-fc-v139, Node v22.22.0 |
| Runtime | whisper.cpp 1.9.1 (ggml 0.15.1), CPU-only: `BUILD_SHARED_LIBS=ON GGML_NATIVE=OFF GGML_BACKEND_DL=ON GGML_CPU_ALL_VARIANTS=ON GGML_OPENMP=OFF`, GCC 13, built 2026-10-20 (`resources/whisper/linux-x64/VERSION`; same configuration as `win-x64`) |
| Other load | none (idle VM) |

**What this machine is and is not.** It is the pessimistic case for *core count* (2 logical cores,
exactly the Lightweight profile's worst target) and for virtualisation overhead, and it has no GPU
(irrelevant: the runtime is CPU-only). It is **not** the pessimistic case for instruction set: the
hypervisor exposes a Sapphire Rapids Xeon with AVX-512, VNNI and AMX, so the runtime picked its
best x86 variant. An office PC that only has AVX2 loads the `haswell` variant, and one without AVX2
loads `sse42` or `x64`; both will be slower than the figures below by a factor this run cannot
tell you. Treat the numbers here as "2 cores, good ISA". Note also that `whisper-bench` reports
`OPENMP = 1` although the build sets `GGML_OPENMP=OFF`; the thread-scaling figures below are what
was measured regardless.

### Audio set

| File | Duration | Content | Reference |
| --- | --- | --- | --- |
| `jfk.wav` | 11.0 s | whisper.cpp sample, one speaker, clean | yes (`docs/benchmarks/jfk.ref.txt`, 22 words) |
| `sample-16k.wav` | 20.1 s | read English prose, one speaker, clean | **no** — completeness only |
| `long_en.wav` | 445.4 s (7 min 25 s) | English narration with music intro, converted from `long_en.raw` (inspected: float32 little-endian, 16 kHz, mono) with `ffmpeg -f f32le -ar 16000 -ac 1` | **no** — completeness only |
| `synthetic-meeting.wav` | 117.9 s | **synthetic speech**: eSpeak NG 1.51 (`-v en-gb -s 160`) reading a 328-word meeting script with names, numbers and dates (`docs/benchmarks/synthetic-meeting.ref.txt`), resampled to 16 kHz | yes |

The synthetic file is a lower bound on difficulty, not a proxy for a real meeting: one perfectly
articulated voice, no overlap, no room, no far-field microphone. It exists only because no
reference-known recording of real meeting speech was available. Real meetings will score worse.

### Whole-file results

| Model | Threads | Load (ms) | Audio | Audio (s) | Proc (s) | RTF | Peak RSS (MB) | CPU (cores) | WER | Words / Segs / Coverage | Max tick delay (ms) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| tiny.en-q5_1 | 1 | 150 | jfk.wav | 11.0 | 3.81 | 0.347 | 105 | 0.97 | 0.0% (S0 I0 D0 / 22) | 22 / 3 / 0.962 | 7.1 |
| tiny.en-q5_1 | 1 | 150 | sample-16k.wav | 20.13 | 3.69 | 0.183 | 115 | 0.99 | no reference | 57 / 8 / 0.932 | 6.2 |
| tiny.en-q5_1 | 1 | 150 | long_en.wav | 445.38 | 51.63 | 0.116 | 316 | 0.98 | no reference | 947 / 112 / 0.937 | 33.4 |
| tiny.en-q5_1 | 1 | 150 | synthetic-meeting.wav | 117.89 | 15.35 | 0.130 | 315 | 0.98 | 26.8% (S65 I2 D21 / 328) | 309 / 41 / 1.000 | 2.8 |
| tiny.en-q5_1 | 2 | 112 | jfk.wav | 11.0 | 2.02 | 0.184 | 105 | 1.92 | 0.0% (S0 I0 D0 / 22) | 22 / 3 / 0.962 | 3.9 |
| tiny.en-q5_1 | 2 | 112 | sample-16k.wav | 20.13 | 2.45 | 0.122 | 114 | 1.77 | no reference | 57 / 8 / 0.932 | 5.3 |
| tiny.en-q5_1 | 2 | 112 | long_en.wav | 445.38 | 33.28 | 0.075 | 305 | 1.69 | no reference | 949 / 116 / 0.955 | 10.6 |
| tiny.en-q5_1 | 2 | 112 | synthetic-meeting.wav | 117.89 | 9.93 | 0.084 | 305 | 1.69 | 26.8% (S65 I2 D21 / 328) | 309 / 41 / 1.000 | 4.7 |
| base.en-q5_1 | — | — | skipped: model file not available on the VM | | | | | | | | |
| base-q5_1 | — | — | skipped: model file not available on the VM | | | | | | | | |
| small.en-q5_1 | — | — | skipped: model file not available on the VM | | | | | | | | |

"Peak RSS" in this table is the process high-water mark at the end of each request. The long file
was processed before the synthetic file, so the synthetic rows inherit the long file's peak.

### Live-like results (≤ 12 s chunks, sequential, prompt carry-over)

| Model | Threads | Audio | Chunks | RTF | Latency p50 (ms) | p95 (ms) | max (ms) | Lag (s) | Max queue lag (s) | Peak RSS (MB) | WER | Words / Segs | Max tick delay (ms) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| tiny.en-q5_1 | 1 | jfk.wav | 1 | 0.327 | 3592 | 3592 | 3592 | −7.41 | 0 | 107 | 0.0% | 22 / 3 | 0.8 |
| tiny.en-q5_1 | 1 | sample-16k.wav | 2 | 0.322 | 3186 | 3303 | 3303 | −13.64 | 0 | 135 | no reference | 57 / 8 | 0.8 |
| tiny.en-q5_1 | 1 | long_en.wav | 38 | 0.382 | 3882 | 8775 | 9759 | −275.11 | 7.39 | 316 | no reference | 961 / 111 | 63.9 |
| tiny.en-q5_1 | 1 | synthetic-meeting.wav | 10 | 0.334 | 3719 | 5804 | 5804 | −78.54 | 0 | 315 | 32.6% | 323 / 35 | 24.1 |
| tiny.en-q5_1 | 2 | jfk.wav | 1 | 0.208 | 2286 | 2286 | 2286 | −8.71 | 0 | 108 | 0.0% | 22 / 3 | 2.5 |
| tiny.en-q5_1 | 2 | sample-16k.wav | 2 | 0.224 | 2123 | 2388 | 2388 | −15.62 | 0 | 128 | no reference | 57 / 8 | 4.9 |
| tiny.en-q5_1 | 2 | long_en.wav | 38 | 0.223 | 2170 | 6449 | 6778 | −346.11 | 5.07 | 305 | no reference | 963 / 110 | 21.0 |
| tiny.en-q5_1 | 2 | synthetic-meeting.wav | 10 | 0.219 | 2344 | 3847 | 3847 | −92.13 | 0 | 305 | 30.5% | 315 / 36 | 32.6 |

Per-chunk latencies for `long_en.wav` at 2 threads (ms): 1848 1908 2089 2242 2221 2984 2723
**5426 5353** 2187 2168 2154 2183 2128 2069 2192 2175 2257 2139 2370 2358 2148 2125 1968 2246 2170
2214 2077 2090 2291 2137 2038 3526 1953 1899 1977 **6777 6448**. The spikes (2.5–3× the normal chunk
cost) sit on the music intro and the tail of the file and are consistent with the decoder's
temperature fallback re-running the chunk; this was not confirmed from server logs. They are what the
resource manager's backlog warning is for.

### whisper-bench (official encoder/decoder benchmark, `whisper-bench -m <model> -t N --no-gpu`)

| Model | Threads | Load (ms) | Encode (ms) | Decode (ms) | Batchd (ms) | Prompt (ms) |
|---|---|---|---|---|---|---|
| tiny.en-q5_1 | 1 | 59.6 | 1501.0 | 1102.6 | 1125.5 | 11259.5 |
| tiny.en-q5_1 | 2 | 60.4 | 1001.8 | 853.4 | 685.1 | 5893.8 |

The encoder figure is the cost of one 30 s window and is paid once per request whatever the chunk
length, which is why the live-like p50 (2.1–2.3 s per 12 s chunk at 2 threads) is far above
12 s × whole-file RTF.

### Peak RSS per model

| Model | Threads | Idle after load (MB) | 11 s request (MB) | 12 s live chunks, 20 s file (MB) | 7.4 min file in one request (MB) | Lifetime peak (bytes) |
|---|---|---|---|---|---|---|
| tiny.en-q5_1 | 1 | 67 | 105 | 135 | 316 | 330 919 936 |
| tiny.en-q5_1 | 2 | 67 | 105 | 128 | 305 | 319 963 136 |

The 305–316 MB figure is the cost of handing whisper-server a 7.4-minute file in a single request
(it holds the decoded PCM and the full mel spectrogram). The app never does that: live chunks are
≤ 12 s and background jobs are planned in ≤ 30 s windows (`audio-windows.ts`), where the worker
stayed at 105–141 MB. A dedicated follow-up measurement with three consecutive 30 s requests at
2 threads (the largest window the app ever sends) gave a VmHWM of 123 MB. The catalog's
`MEASURED_MEMORY['tiny.en-q5_1']` is therefore set on that basis, with headroom, to 140 MiB
(146 800 640 bytes); the previous estimate was ≈ 215 MB. The whole-file figure is recorded here
only to show why the app never sends whole files.

### Thread-count observations (2 logical cores)

- 1 → 2 threads gave 1.55× on the long whole-file run (51.6 → 33.3 s), 1.9× on the 11 s file,
  1.5× on `whisper-bench` encode (1501 → 1002 ms), and 1.7× on live-like RTF (0.38 → 0.22).
  Scaling is sub-linear because the decoder is sequential and the second vCPU is shared with the
  bench process and the OS.
- CPU utilisation: 0.97–0.99 cores at 1 thread, 1.69–1.92 cores at 2 threads. **On a 2-core
  machine, 2 threads leaves nothing for a conferencing app**; the Lightweight profile's
  `threadFraction 0.5` lands on 1 thread there, and the 1-thread figures show that is still 2.6×
  faster than real time in live mode (RTF 0.38) with a worst-case backlog of 7.4 s on the hardest
  file.
- The Node side stayed responsive throughout: worst 100 ms tick delay 63.9 ms (1 thread, during
  the 38-chunk live run, when the bench process competed for the same two cores), typically under
  10 ms. This is what running inference out of process buys.
- Model load (process start → HTTP ready) was 112–150 ms for the 31 MB tiny model, so restarting
  the worker between profiles is not a user-visible cost for this model.

### Accuracy observations (tiny.en-q5_1)

- `jfk.wav`: 0 errors in 22 words at both thread counts and in both modes.
- Synthetic meeting (328 reference words): **26.8% WER whole-file, 30.5–32.6% live-like**. The
  harness compares numbers as written, and the reference spells numbers out ("two hundred and
  forty seven") while the model emits digits ("247"). A side check with the same reference rewritten
  with digits (not part of the harness output; `docs/benchmarks/synthetic-meeting.ref.txt` is the
  spoken form) gave 17.5% (S45 I5 D4 / 308). The remaining errors are what matters for a meeting
  tool: **all four names were wrong** (Priya → "Prere", Deepak → "the pack", Rahul → "Rattle",
  Vetri → "metri"), "two hundred and forty seven" became "240 7", "nine of the eleven" became "high on
  the 11th", "ten thirty" became "10th or", "invoice for the Ajman office" became "voice for the
  management office". Live-like is 4–6 points worse than whole-file because each 12 s chunk is
  decoded with less context and cuts words at the boundary.
- Live-like vs whole-file produced the same word counts within 1–2% on every file (completeness),
  so chunking does not lose audio; it costs accuracy at chunk edges.
- 1 vs 2 threads changed the live-like transcript slightly (32.6% vs 30.5%) — float summation
  order differs with thread count, and the temperature fallback can take a different path. Treat
  differences of a few points between runs as noise.
- The multilingual `tiny-q5_1` was not measured; expect it to be worse on English than `tiny.en`.

## Recommendation (derived from the measurements above; where marked, still an estimate)

| Profile | Target machine | Model | Threads | Basis |
| --- | --- | --- | --- | --- |
| **Lightweight** | 8 GB, 2 cores (or no AVX2) | `tiny.en-q5_1` (`tiny-q5_1` for non-English) | 1 on 2 cores, 2 on 4 | **Measured** on this VM: live RTF 0.38 at 1 thread / 0.22 at 2, p95 chunk latency 8.8 s / 6.4 s against 12 s chunks, worst backlog 7.4 s / 5.1 s, peak RSS ≤ 316 MB even in the worst case, load 0.15 s. Accuracy is basic: names and compound numbers are unreliable (26.8% WER on easy synthetic speech), so this profile should be paired with the "background pass with a bigger model after the meeting" the profile text already promises. Caveat: the VM has AVX-512; an AVX2-only or SSE4.2 PC will be slower than these numbers. |
| **Balanced** | 16 GB, 4 cores, AVX2 | `base.en-q5_1` first, `small.en-q5_1` when installed | 4 | **Unverified — estimate.** Not measured in this run (model files unavailable). The catalog's ordering (base before small) stands until a measured run shows small keeping live RTF below 0.5 at 4 threads with p95 chunk latency under the 10 s chunk length; that is the acceptance condition to promote small to the default. |
| **High accuracy** | 32 GB, 8+ cores, AVX2 | `small.en-q5_1`; medium / large-v3-turbo pinned only | 6 | **Unverified — estimate.** Not measured. Keep `medium` and larger out of live use until a measured run on the target machine shows otherwise. |

Reasoning for keeping tiny as the Lightweight pick rather than base: on 2 cores the tiny model
already takes 1.7–1.9 of the 2 cores at 2 threads, and base has about twice the parameters
(74 M vs 39 M), so if cost scales with parameter count, base at 1 thread on this class of machine would sit near
twice the measured tiny live RTF (≈ 0.75) — too close to 1 given the 2.5–3× fallback spikes seen
above. That is an extrapolation from the tiny measurements, not a measurement of base; it is the
first thing the Windows 8 GB run should check.

## Unverified: Windows target configurations

Nothing below has been measured. The Windows runtime (`resources/whisper/win-x64`) is the same
whisper.cpp 1.9.1 build configuration as the Linux runtime above, but it has not been run through
this harness on any machine. Fill a row only by committing the JSON the command below produces and
copying its numbers; the Linux VM figures must not be copied into these rows.

| Configuration | CPU (exact model) | Backend variant loaded | Model | Threads | Live RTF | Live p95 (ms) | Whole-file RTF (long) | Peak RSS (MB) | WER (jfk / synthetic) | JSON |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Windows, 8 GB, 2–4 cores (Lightweight) | | | tiny.en-q5_1 | 1 | | | | | | |
| Windows, 8 GB, 2–4 cores (Lightweight) | | | tiny.en-q5_1 | 2 | | | | | | |
| Windows, 8 GB, 2–4 cores (Lightweight) | | | base.en-q5_1 | 2 | | | | | | |
| Windows, 16 GB, 4 cores / 8 threads (Balanced) | | | base.en-q5_1 | 4 | | | | | | |
| Windows, 16 GB, 4 cores / 8 threads (Balanced) | | | small.en-q5_1 | 4 | | | | | | |
| Windows, 32 GB, 8 cores / 16 threads (High accuracy) | | | small.en-q5_1 | 6 | | | | | | |
| Windows, 32 GB, 8 cores / 16 threads (High accuracy) | | | medium.en-q5_0 | 6 | | | | | | |
| Windows, 32 GB, 8 cores / 16 threads (High accuracy) | | | large-v3-turbo-q5_0 | 6 | | | | | | |

Commands (PowerShell, repo root, Node 22 on PATH, models installed via Settings → Transcription →
Models so they sit in `%APPDATA%\Minutes\models\whisper`; put `jfk.wav`, `synthetic-meeting.wav`,
`long.wav` and the two `.ref.txt` files from `docs/benchmarks/` in a `bench\` folder —
regenerate the synthetic file with `espeak-ng -v en-gb -s 160 -f docs\benchmarks\synthetic-meeting.ref.txt -w tmp.wav`
then `ffmpeg -i tmp.wav -ar 16000 -ac 1 -c:a pcm_s16le bench\synthetic-meeting.wav`):

```powershell
# 8 GB machine
node scripts\bench\whisper-bench.mjs --models tiny.en-q5_1,tiny-q5_1,base.en-q5_1 --threads 1,2 `
  --audio bench\jfk.wav,bench\synthetic-meeting.wav,bench\long.wav `
  --reference docs\benchmarks\jfk.ref.txt,docs\benchmarks\synthetic-meeting.ref.txt,- `
  --runtime resources\whisper\win-x64 --models-dir "$env:APPDATA\Minutes\models\whisper" `
  --out docs\benchmarks\$(Get-Date -Format yyyy-MM-ddTHH-mm)Z-win-8gb.json --official-bench --label "Windows 8 GB, <CPU>, <what else was running>"

# 16 GB machine
node scripts\bench\whisper-bench.mjs --models tiny.en-q5_1,base.en-q5_1,base-q5_1,small.en-q5_1 --threads 2,4 `
  --audio bench\jfk.wav,bench\synthetic-meeting.wav,bench\long.wav `
  --reference docs\benchmarks\jfk.ref.txt,docs\benchmarks\synthetic-meeting.ref.txt,- `
  --runtime resources\whisper\win-x64 --models-dir "$env:APPDATA\Minutes\models\whisper" `
  --out docs\benchmarks\$(Get-Date -Format yyyy-MM-ddTHH-mm)Z-win-16gb.json --official-bench --chunk-ms 10000 --label "Windows 16 GB, <CPU>"

# 32 GB machine
node scripts\bench\whisper-bench.mjs --models base.en-q5_1,small.en-q5_1,small-q5_1,medium.en-q5_0,large-v3-turbo-q5_0 --threads 2,4,6,8 `
  --audio bench\jfk.wav,bench\synthetic-meeting.wav,bench\long.wav `
  --reference docs\benchmarks\jfk.ref.txt,docs\benchmarks\synthetic-meeting.ref.txt,- `
  --runtime resources\whisper\win-x64 --models-dir "$env:APPDATA\Minutes\models\whisper" `
  --out docs\benchmarks\$(Get-Date -Format yyyy-MM-ddTHH-mm)Z-win-32gb.json --official-bench --chunk-ms 10000 --label "Windows 32 GB, <CPU>"
```

The Balanced and High-accuracy profiles use 10 s live chunks, hence `--chunk-ms 10000` for those
two. Then follow "Adding results to docs/benchmarks.md" in `scripts/bench/README.md`: paste the
stdout tables under a new environment heading here, fill the rows above, and update
`MEASURED_MEMORY` for each model whose long whole-file run was done at 2 threads.

## Also still unmeasured

- Any model other than `tiny.en-q5_1` (including the multilingual tiny).
- Real meeting audio with a reference transcript (two or more speakers, laptop microphone,
  conferencing-app system audio). The synthetic file is easier than any of that.
- A CPU where the runtime loads a variant below `sapphirerapids` (`haswell` = AVX2-only,
  `sse42`, `x64`). The model catalog's speed classes are phrased for "2 threads without AVX2";
  no such machine has been measured.
- Behaviour on battery / under Windows power throttling.
