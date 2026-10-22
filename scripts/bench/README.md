# Transcription benchmark harness

`whisper-bench.mjs` measures the whisper.cpp runtime exactly as Minutes drives it: it starts
`whisper-server` with the app's arguments (`-m <model> -t <threads> --host 127.0.0.1 --port <p> --no-gpu`),
posts WAV audio to `/inference` with the app's request fields (`verbose_json`, temperature 0 with
0.2 fallback, `suppress_non_speech`), and records what the app and its users care about:

| Metric | How it is measured |
|---|---|
| Load time | process spawn → first HTTP 200/404 from `GET /` (the server only listens once the model is in memory) |
| Processing time, RTF | wall time of the `/inference` request; RTF = processing seconds ÷ audio seconds (RTF 0.25 = four times faster than real time; < 1 is required for live use) |
| Peak RSS | Linux: `/proc/<pid>/status` `VmHWM` polled every 200 ms (plus max sampled `VmRSS`); Windows: PowerShell `Get-Process` `PeakWorkingSet64` polled every 1 s, `tasklist /FI "PID eq N" /FO CSV` as a fallback (current working set only) |
| CPU utilisation | Linux: Δ(`utime`+`stime`) from `/proc/<pid>/stat` ÷ wall time, in cores; Windows: Δ`TotalProcessorTime` ÷ wall time |
| Transcript | concatenated segment text, kept verbatim in the JSON |
| WER | word-level Levenshtein distance ÷ reference words, after lower-casing and stripping punctuation; numbers are compared as written (`"247"` ≠ `"two hundred and forty seven"`), so synthetic references with spelled-out numbers over-state the error |
| Completeness (no reference) | word count, segment count, words per minute, fraction of the audio covered by segments and by the last segment end. **This is not an accuracy figure.** |
| Live-like mode | the file is split into ≤ `--chunk-ms` chunks (default 12 000 ms, the Lightweight profile's chunk length) posted sequentially with the previous chunk's text as `prompt`; reports per-chunk latency p50/p95/max, lag = cumulative processing time − cumulative audio time (negative = keeps up), and the maximum queue backlog a real-time recorder would have seen |
| UI responsiveness proxy | a 100 ms `setInterval` in the bench (Node) process during inference; the max tick delay shows the Node side stays responsive because inference is out of process |
| `whisper-bench` | with `--official-bench`, the stock `whisper-bench -m <model> -t N --no-gpu` encoder/decoder timings are recorded as well |

The model file is verified (size + sha256) against `resources/whisper/hf-tree-ggerganov-whisper.cpp.json`
before use unless `--no-verify` is given.

## Requirements

- Node 22 (no npm dependencies).
- The runtime directory for the platform: `resources/whisper/linux-x64` or `resources/whisper/win-x64`.
- Model files named `ggml-<id>.bin` (as the app installs them) in one directory.
- Audio as **16 kHz mono PCM16 WAV**. Convert anything else first:
  `ffmpeg -i in.m4a -ar 16000 -ac 1 -c:a pcm_s16le out.wav`
  (raw float32 at 16 kHz: `ffmpeg -f f32le -ar 16000 -ac 1 -i in.raw -c:a pcm_s16le out.wav`).
- Reference transcripts as plain text files, one per audio file; use `-` for files without one.

## Running

```sh
node scripts/bench/whisper-bench.mjs \
  --models tiny.en-q5_1,base.en-q5_1,small.en-q5_1 \
  --threads 1,2,4 \
  --audio bench/jfk.wav,bench/meeting-A.wav,bench/long.wav \
  --reference bench/jfk.ref.txt,bench/meeting-A.ref.txt,- \
  --runtime resources/whisper/linux-x64 \
  --models-dir ~/models \
  --out docs/benchmarks/$(date -u +%Y-%m-%dT%H-%MZ)-<machine>.json \
  --official-bench --label "<machine description>"
```

The JSON goes to `--out`; a Markdown summary (environment, whole-file table, live-like table,
whisper-bench table, peak RSS table) is printed to stdout and can be pasted into `docs/benchmarks.md`.
Progress goes to stderr. Options: `--chunk-ms` (default 12000), `--no-verify`,
`--load-timeout-ms` (180 000), `--request-timeout-ms` (1 800 000), `--label`.

Rules for a comparable run:

1. Quit everything else that is heavy (browser video, conferencing). Note in `--label` what was running.
2. Plug the laptop in and set the Windows power mode to "Best performance"; thermal throttling on battery halves throughput.
3. Run each configuration once with the machine idle; if a number looks off, rerun it — do not average over runs taken under different conditions.
4. Use the same audio set every time. Keep the files out of git if they contain real meeting content (the JSON stores the transcript text — review before committing).

## Windows target configurations

The same script runs unchanged on Windows (PowerShell 5.1 or 7 must be on PATH for peak-RSS sampling;
`tasklist` is the fallback). From a PowerShell prompt in the repo root:

```powershell
# 8 GB / 2-4 core office PC (Lightweight profile target)
node scripts/bench/whisper-bench.mjs --models tiny.en-q5_1,tiny-q5_1,base.en-q5_1 --threads 1,2 `
  --audio bench\jfk.wav,bench\meeting-A.wav,bench\long.wav --reference bench\jfk.ref.txt,bench\meeting-A.ref.txt,- `
  --runtime resources\whisper\win-x64 --models-dir "$env:APPDATA\Minutes\models\whisper" `
  --out docs\benchmarks\$(Get-Date -Format yyyy-MM-ddTHH-mm)Z-win-8gb.json --official-bench --label "Windows 8 GB <CPU model>"

# 16 GB laptop (Balanced profile target)
node scripts/bench/whisper-bench.mjs --models tiny.en-q5_1,base.en-q5_1,base-q5_1,small.en-q5_1 --threads 2,4 `
  --audio ... --reference ... --runtime resources\whisper\win-x64 --models-dir "$env:APPDATA\Minutes\models\whisper" `
  --out docs\benchmarks\...-win-16gb.json --official-bench --label "Windows 16 GB <CPU model>"

# 32 GB workstation (High-accuracy profile target)
node scripts/bench/whisper-bench.mjs --models base.en-q5_1,small.en-q5_1,small-q5_1,medium.en-q5_0,large-v3-turbo-q5_0 --threads 2,4,6,8 `
  --audio ... --reference ... --runtime resources\whisper\win-x64 --models-dir "$env:APPDATA\Minutes\models\whisper" `
  --out docs\benchmarks\...-win-32gb.json --official-bench --label "Windows 32 GB <CPU model>"
```

`$env:APPDATA\Minutes\models\whisper` is where the installed app keeps models (`<userData>/models/whisper`);
any directory with `ggml-<id>.bin` files works. Models can be installed from the app's Settings →
Transcription → Models page first, or downloaded from `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-<id>.bin`.

## Adding results to docs/benchmarks.md

1. Commit the JSON under `docs/benchmarks/` (name: `<UTC timestamp>-<machine>.json`).
2. Paste the stdout Markdown into a new subsection of `docs/benchmarks.md` under "Results", headed by the
   machine (exact CPU model from the JSON `environment.cpuModel`, RAM, OS build, the `cpuVariant` the runtime
   picked) and the date.
3. Move the matching row out of the "Unverified" table into the results, and update the recommendation
   section only if the new data contradicts it — say which run changed the recommendation.
4. If the run included a long (≥ 5 min) whole-file pass with 2 threads for a model, update
   `MEASURED_MEMORY` in `src/main/services/whisper/model-catalog.ts` with `peakRssBytesLifetime` for that
   model rounded **up** to the next MiB, cite the JSON file in the comment, and run
   `npx vitest run tests/unit/whisper/model-catalog.test.ts`.
5. Never type a number into the tables that is not in a committed JSON.
