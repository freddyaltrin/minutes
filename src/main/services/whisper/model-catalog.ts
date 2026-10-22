// whisper.cpp ggml model catalog for Minutes.
//
// Sizes and sha256 digests are inlined (not imported) from
// resources/whisper/hf-tree-ggerganov-whisper.cpp.json so the bundled main process does not depend
// on a resource path at runtime. The JSON remains the authoritative capture of
// https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main (fetched 2026-10-20);
// tests/unit/whisper/model-catalog.test.ts asserts the two stay in sync.
//
// Nothing here touches the filesystem or the network.

import type { ModelCatalogEntry, ModelFamily, Quantization } from '@shared/transcription-types'

const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/'
const LICENSE = 'MIT (whisper.cpp conversion of OpenAI Whisper weights, MIT)'

/** Raw publisher data: file size in bytes and sha256 per model id (file = ggml-<id>.bin). */
const RAW: readonly { id: string; sizeBytes: number; sha256: string }[] = [
  { id: 'tiny.en-q5_1', sizeBytes: 32166155, sha256: 'c77c5766f1cef09b6b7d47f21b546cbddd4157886b3b5d6d4f709e91e66c7c2b' },
  { id: 'tiny.en-q8_0', sizeBytes: 43550795, sha256: '5bc2b3860aa151a4c6e7bb095e1fcce7cf12c7b020ca08dcec0c6d018bb7dd94' },
  { id: 'tiny.en', sizeBytes: 77704715, sha256: '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f' },
  { id: 'tiny-q5_1', sizeBytes: 32152673, sha256: '818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7' },
  { id: 'tiny-q8_0', sizeBytes: 43537433, sha256: 'c2085835d3f50733e2ff6e4b41ae8a2b8d8110461e18821b09a15c40c42d1cca' },
  { id: 'tiny', sizeBytes: 77691713, sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21' },
  { id: 'base.en-q5_1', sizeBytes: 59721011, sha256: '4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f' },
  { id: 'base.en-q8_0', sizeBytes: 81781811, sha256: 'a4d4a0768075e13cfd7e19df3ae2dbc4a68d37d36a7dad45e8410c9a34f8c87e' },
  { id: 'base.en', sizeBytes: 147964211, sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002' },
  { id: 'base-q5_1', sizeBytes: 59707625, sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898' },
  { id: 'base-q8_0', sizeBytes: 81768585, sha256: 'c577b9a86e7e048a0b7eada054f4dd79a56bbfa911fbdacf900ac5b567cbb7d9' },
  { id: 'base', sizeBytes: 147951465, sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe' },
  { id: 'small.en-q5_1', sizeBytes: 190098681, sha256: 'bfdff4894dcb76bbf647d56263ea2a96645423f1669176f4844a1bf8e478ad30' },
  { id: 'small.en-q8_0', sizeBytes: 264477561, sha256: '67a179f608ea6114bd3fdb9060e762b588a3fb3bd00c4387971be4d177958067' },
  { id: 'small.en', sizeBytes: 487614201, sha256: 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d' },
  { id: 'small-q5_1', sizeBytes: 190085487, sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb' },
  { id: 'small-q8_0', sizeBytes: 264464607, sha256: '49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f' },
  { id: 'small', sizeBytes: 487601967, sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b' },
  { id: 'medium.en-q5_0', sizeBytes: 539225533, sha256: '76733e26ad8fe1c7a5bf7531a9d41917b2adc0f20f2e4f5531688a8c6cd88eb0' },
  { id: 'medium-q5_0', sizeBytes: 539212467, sha256: '19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f' },
  { id: 'medium.en-q8_0', sizeBytes: 823382461, sha256: '43fa2cd084de5a04399a896a9a7a786064e221365c01700cea4666005218f11c' },
  { id: 'medium-q8_0', sizeBytes: 823369779, sha256: '42a1ffcbe4167d224232443396968db4d02d4e8e87e213d3ee2e03095dea6502' },
  { id: 'medium', sizeBytes: 1533763059, sha256: '6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208' },
  { id: 'large-v3-turbo-q5_0', sizeBytes: 574041195, sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2' },
  { id: 'large-v3-turbo-q8_0', sizeBytes: 874188075, sha256: '317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1' },
  { id: 'large-v3-q5_0', sizeBytes: 1081140203, sha256: 'd75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1' }
]

/**
 * Peak process memory measured by the benchmark harness (scripts/bench/whisper-bench.mjs), keyed by
 * model id (bytes). Each value is the whisper-server VmHWM (lifetime peak RSS) from the whole-file
 * run of a 7.4-minute recording at 2 threads, rounded up to the next MiB. Every entry present flips
 * `memoryMeasured` to true for that model; models without an entry use estimateRuntimeMemory().
 *
 * Source: docs/benchmarks.md, run 2026-10-20 (docs/benchmarks/2026-10-20T12-40Z-linux-vm-2core.json),
 * Linux VM, Intel Xeon @ 2.10GHz, 2 logical cores, 7.8 GiB RAM, no GPU, ggml CPU variant
 * "sapphirerapids", whisper.cpp 1.9.1. Measured raw peak 319 963 136 bytes (305.1 MiB); the figure
 * is pessimistic for the app, which never submits more than a 30 s window (105–141 MB observed).
 * Not yet measured on Windows or for any other model.
 */
export const MEASURED_MEMORY: Record<string, number> = {
  // Peak resident set of whisper-server (VmHWM) after three consecutive 30 s requests, 2 threads,
  // Linux VM, 2026-10-20 — the largest window the app ever sends (live chunks ≤ 25 s, background
  // windows ≤ 30 s). Measured 123 MB; stored with headroom. A whole-7-minute-file request peaks at
  // 306 MB, which is why the app never sends whole files. See docs/benchmarks.md.
  'tiny.en-q5_1': 140 * 1024 * 1024
}

const MB = 1024 * 1024

/**
 * Memory model (bytes). Basis: the whisper.cpp README total-process figures for f16 models
 * (tiny ≈ 273 MB, base ≈ 388 MB, small ≈ 852 MB, medium ≈ 2.1 GB, large ≈ 3.9 GB, each including a
 * ~100 MB baseline). For every entry we estimate:
 *   baseline 120 MB + file size × 1.15 + per-family compute buffers.
 * The compute term is what the README figures imply after subtracting baseline and weights.
 */
const BASELINE_BYTES = 120 * MB
const WEIGHTS_FACTOR = 1.15
const COMPUTE_BYTES: Record<ModelFamily, number> = {
  tiny: 60 * MB,
  base: 90 * MB,
  small: 200 * MB,
  medium: 450 * MB,
  'large-v3-turbo': 500 * MB,
  'large-v3': 700 * MB
}

export function estimateRuntimeMemory(family: ModelFamily, sizeBytes: number): number {
  return Math.round(BASELINE_BYTES + sizeBytes * WEIGHTS_FACTOR + COMPUTE_BYTES[family])
}

const FAMILY_TRAITS: Record<
  ModelFamily,
  { label: string; speedClass: ModelCatalogEntry['speedClass']; accuracyClass: ModelCatalogEntry['accuracyClass']; liveCapable: boolean }
> = {
  tiny: { label: 'Tiny', speedClass: 'fastest', accuracyClass: 'basic', liveCapable: true },
  base: { label: 'Base', speedClass: 'fast', accuracyClass: 'fair', liveCapable: true },
  // Live use is marginal on weak CPUs but workable; the resource manager decides per machine.
  small: { label: 'Small', speedClass: 'moderate', accuracyClass: 'good', liveCapable: true },
  medium: { label: 'Medium', speedClass: 'slow', accuracyClass: 'high', liveCapable: false },
  'large-v3-turbo': { label: 'Large v3 Turbo', speedClass: 'very-slow', accuracyClass: 'highest', liveCapable: false },
  'large-v3': { label: 'Large v3', speedClass: 'very-slow', accuracyClass: 'highest', liveCapable: false }
}

const FAMILY_ORDER: ModelFamily[] = ['large-v3-turbo', 'large-v3', 'medium', 'small', 'base', 'tiny']

export function parseModelId(id: string): { family: ModelFamily; englishOnly: boolean; quantization: Quantization } {
  const family = FAMILY_ORDER.find((f) => id === f || id.startsWith(f + '.') || id.startsWith(f + '-'))
  if (!family) throw new Error(`Unknown whisper model family in id "${id}"`)
  const rest = id.slice(family.length)
  const englishOnly = rest.startsWith('.en')
  const m = /-(q8_0|q5_1|q5_0)$/.exec(rest)
  const quantization: Quantization = m ? (m[1] as Quantization) : 'f16'
  return { family, englishOnly, quantization }
}

/** File name of a catalog model, e.g. "ggml-base.en-q5_1.bin". */
export function modelFileName(id: string): string {
  return `ggml-${id}.bin`
}

function buildEntry(raw: { id: string; sizeBytes: number; sha256: string }): ModelCatalogEntry {
  const { family, englishOnly, quantization } = parseModelId(raw.id)
  const traits = FAMILY_TRAITS[family]
  const fileName = modelFileName(raw.id)
  const measured = MEASURED_MEMORY[raw.id]
  const nameParts = [englishOnly ? 'English' : 'Multilingual', quantization === 'f16' ? 'f16' : quantization]
  return {
    id: raw.id,
    family,
    name: `${traits.label} (${nameParts.join(', ')})`,
    fileName,
    url: HF_BASE + fileName,
    sha256: raw.sha256,
    sizeBytes: raw.sizeBytes,
    quantization,
    english_only: englishOnly,
    languages: englishOnly ? 'english' : 'multilingual',
    runtimeMemoryBytes: measured ?? estimateRuntimeMemory(family, raw.sizeBytes),
    memoryMeasured: measured !== undefined,
    speedClass: traits.speedClass,
    accuracyClass: traits.accuracyClass,
    liveCapable: traits.liveCapable,
    license: LICENSE
  }
}

export const MODEL_CATALOG: ModelCatalogEntry[] = RAW.map(buildEntry)

const BY_ID = new Map(MODEL_CATALOG.map((e) => [e.id, e]))

export function getCatalogEntry(id: string): ModelCatalogEntry | undefined {
  return BY_ID.get(id)
}

export function isCatalogId(id: string): boolean {
  return BY_ID.has(id)
}
