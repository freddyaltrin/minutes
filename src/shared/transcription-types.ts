// Types for the hardware-adaptive transcription subsystem (whisper.cpp runtime + model manager +
// resource manager + job queue). Structured-clone safe; shared by main, preload and renderer.

export type EngineKind = 'whisper' | 'windows-sapi' | 'none'

export type Quantization = 'f16' | 'q8_0' | 'q5_1' | 'q5_0'
export type ModelFamily = 'tiny' | 'base' | 'small' | 'medium' | 'large-v3-turbo' | 'large-v3'

export interface ModelCatalogEntry {
  /** Stable id, e.g. "base.en-q5_1". */
  id: string
  family: ModelFamily
  /** Display name, e.g. "Base (English, q5_1)". */
  name: string
  fileName: string
  url: string
  sha256: string
  /** Exact download size in bytes (from the publisher's file listing). */
  sizeBytes: number
  quantization: Quantization
  english_only: boolean
  languages: 'english' | 'multilingual'
  /**
   * Approximate peak resident memory of the whisper.cpp process with this model loaded and one
   * 30 s window in flight, in bytes. Measured values carry `memoryMeasured: true`; others are
   * estimates derived from the measured siblings (documented in docs/models.md).
   */
  runtimeMemoryBytes: number
  memoryMeasured: boolean
  /** Rough relative speed: real-time factor on a 2-thread x86 CPU without AVX2 (estimate). */
  speedClass: 'fastest' | 'fast' | 'moderate' | 'slow' | 'very-slow'
  accuracyClass: 'basic' | 'fair' | 'good' | 'high' | 'highest'
  /** Whether the entry is a sensible choice for live (chunked, near real-time) use on CPU. */
  liveCapable: boolean
  license: string
}

export type ModelInstallState = 'not-installed' | 'downloading' | 'verifying' | 'installed' | 'error' | 'corrupt'

export interface ModelState extends ModelCatalogEntry {
  state: ModelInstallState
  installedBytes: number | null
  installedPath: string | null
  installedAt: number | null
  download: { receivedBytes: number; totalBytes: number; bytesPerSecond: number; startedAt: number } | null
  error: string | null
  /** Resource-manager verdict for the current hardware/profile. */
  eligibility: Eligibility
}

export interface Eligibility {
  eligible: boolean
  /** Human-readable reasons when not eligible, or notes when eligible. */
  reasons: string[]
  /** Estimated memory this model would need vs the budget it was checked against. */
  requiredBytes: number
  budgetBytes: number
}

export interface HardwareInfo {
  platform: string
  arch: string
  cpuModel: string
  logicalCores: number
  /** Physical core estimate (logical / 2 when hyper-threading is likely); null when unknown. */
  physicalCores: number | null
  totalMemoryBytes: number
  freeMemoryBytes: number
  /** Available memory as reported by the OS ("available", not merely "free"), when supported. */
  availableMemoryBytes: number | null
  /** Instruction-set features detected (x86: sse4.2, avx, avx2, avx512f...) or [] when unknown. */
  features: string[]
  featuresReliable: boolean
  checkedAt: number
}

export type ProfileId = 'lightweight' | 'balanced' | 'high-accuracy' | 'custom'

export interface ProfileDefinition {
  id: ProfileId
  name: string
  description: string
  /** Model preference order (catalog ids); the first installed + eligible one wins. */
  preferredModels: string[]
  /** Upper bound on worker threads; the plan may lower it. */
  maxThreads: number
  /** Fraction of logical cores to use (rounded down, min 1). */
  threadFraction: number
  /** Memory kept free for the OS, the conferencing app and the renderer, in bytes. */
  safetyMarginBytes: number
  /** Maximum concurrent transcription jobs (live + background). */
  maxConcurrentJobs: number
  /** Live chunk length target in ms. */
  liveChunkMs: number
}

export interface TranscriptionConfig {
  engine: EngineKind
  profile: ProfileId
  /** Explicit model id when profile is 'custom' (or to pin a model within a profile). */
  modelId: string | null
  /** Explicit thread count when profile is 'custom'; null = plan decides. */
  threads: number | null
  language: string | null
  /** Automatically fall back to a smaller installed model if the chosen one is not eligible. */
  allowFallback: boolean
  /** Transcribe saved recordings in the background when live transcription was unavailable or lagging. */
  backgroundAfterMeeting: boolean
  customVocabulary: string[]
}

export interface ResourcePlan {
  engine: EngineKind
  profile: ProfileId
  /** Chosen model id, or null when nothing eligible is installed. */
  modelId: string | null
  threads: number
  budgetBytes: number
  requiredBytes: number
  /** Why this model/thread count was chosen (shown in Settings). */
  rationale: string[]
  /** Models considered, in preference order, with their eligibility. */
  considered: { modelId: string; installed: boolean; eligibility: Eligibility }[]
  hardware: HardwareInfo
  plannedAt: number
}

export type JobKind = 'live' | 'background'
export type JobStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

export interface TranscriptionJob {
  id: string
  kind: JobKind
  noteId: string
  noteTitle: string
  /** Recording id for background jobs. */
  recordingId: string | null
  modelId: string | null
  status: JobStatus
  /** 0..1 */
  progress: number
  processedMs: number
  totalMs: number
  /** Processing duration so far, ms. */
  elapsedMs: number
  /** Real-time factor so far (elapsed / processed audio); null until known. */
  rtf: number | null
  segmentsWritten: number
  error: string | null
  attempts: number
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

export interface LiveTranscriptionStatus {
  engine: EngineKind
  modelId: string | null
  status: 'off' | 'loading' | 'listening' | 'processing' | 'lagging' | 'error'
  /** Audio captured but not yet transcribed, in ms. */
  backlogMs: number
  queuedChunks: number
  /** Processing duration / audio duration over the recent window. */
  recentRtf: number | null
  recognizedSegments: number
  threads: number
  lastError: string | null
  /** Set when the live engine could not keep up and a post-meeting job was/will be queued. */
  deferredToBackground: boolean
}

export interface EngineStatus {
  engine: EngineKind
  runtimeAvailable: boolean
  runtimeDetail: string
  runtimeVersion: string | null
  loadedModelId: string | null
  processAlive: boolean
  lastError: string | null
  loadTimeMs: number | null
  /** Resident memory of the worker process when known. */
  workerMemoryBytes: number | null
  /** ggml CPU backend variant the runtime picked (e.g. "haswell", "alderlake"), once reported. */
  cpuVariant: string | null
  checkedAt: number
}

export interface StorageUsage {
  modelsPath: string
  modelsBytes: number
  tempBytes: number
  installedCount: number
}

export interface BenchmarkResult {
  modelId: string
  threads: number
  audioMs: number
  loadMs: number
  processMs: number
  rtf: number
  peakRssBytes: number | null
  wer: number | null
  transcript: string
  ranAt: number
  hardware: HardwareInfo
}
