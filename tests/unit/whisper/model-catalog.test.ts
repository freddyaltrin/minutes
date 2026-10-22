import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MODEL_CATALOG, getCatalogEntry, modelFileName, estimateRuntimeMemory, MEASURED_MEMORY, parseModelId } from '../../../src/main/services/whisper/model-catalog'
import type { ModelFamily } from '../../../src/shared/transcription-types'

interface TreeFile {
  path: string
  size: number
  sha256: string
}
const tree = JSON.parse(readFileSync(resolve(__dirname, '../../../resources/whisper/hf-tree-ggerganov-whisper.cpp.json'), 'utf8')) as {
  files: TreeFile[]
}
const treeByPath = new Map(tree.files.map((f) => [f.path, f]))

describe('MODEL_CATALOG', () => {
  it('has unique ids and the expected 26 entries', () => {
    const ids = MODEL_CATALOG.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBe(26)
    for (const must of ['tiny.en-q5_1', 'base.en-q5_1', 'small.en-q5_1', 'medium-q5_0', 'large-v3-turbo-q5_0', 'large-v3-q5_0']) {
      expect(ids).toContain(must)
    }
  })

  it('every entry matches the HF tree capture (file name, size, sha256) and URL scheme', () => {
    for (const e of MODEL_CATALOG) {
      expect(e.fileName).toBe(modelFileName(e.id))
      expect(e.fileName).toBe(`ggml-${e.id}.bin`)
      const t = treeByPath.get(e.fileName)
      expect(t, `${e.fileName} missing from HF tree JSON`).toBeDefined()
      expect(e.sizeBytes).toBe(t!.size)
      expect(e.sha256).toBe(t!.sha256)
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(e.url).toBe(`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${e.fileName}`)
      expect(e.sizeBytes).toBeGreaterThan(0)
      expect(e.license).toContain('MIT')
    }
  })

  it('derives family, language and quantization from the id', () => {
    expect(parseModelId('tiny.en-q5_1')).toEqual({ family: 'tiny', englishOnly: true, quantization: 'q5_1' })
    expect(parseModelId('large-v3-turbo-q8_0')).toEqual({ family: 'large-v3-turbo', englishOnly: false, quantization: 'q8_0' })
    expect(parseModelId('large-v3-q5_0')).toEqual({ family: 'large-v3', englishOnly: false, quantization: 'q5_0' })
    expect(parseModelId('medium')).toEqual({ family: 'medium', englishOnly: false, quantization: 'f16' })
    const e = getCatalogEntry('base.en')!
    expect(e.english_only).toBe(true)
    expect(e.languages).toBe('english')
    expect(e.quantization).toBe('f16')
    expect(getCatalogEntry('base')!.languages).toBe('multilingual')
    expect(getCatalogEntry('nope')).toBeUndefined()
  })

  it('memory estimates are monotonic in file size within a family; unmeasured entries use the estimate', () => {
    const families = new Set(MODEL_CATALOG.map((e) => e.family))
    for (const fam of families) {
      const sorted = MODEL_CATALOG.filter((e) => e.family === fam).sort((a, b) => a.sizeBytes - b.sizeBytes)
      for (let i = 1; i < sorted.length; i++) {
        expect(estimateRuntimeMemory(fam as ModelFamily, sorted[i].sizeBytes)).toBeGreaterThanOrEqual(
          estimateRuntimeMemory(fam as ModelFamily, sorted[i - 1].sizeBytes)
        )
      }
      for (const e of sorted) {
        if (e.id in MEASURED_MEMORY) continue
        expect(e.memoryMeasured).toBe(false)
        expect(e.runtimeMemoryBytes).toBe(estimateRuntimeMemory(fam as ModelFamily, e.sizeBytes))
        expect(e.runtimeMemoryBytes).toBeGreaterThan(e.sizeBytes)
      }
    }
  })

  it('measured memory figures (docs/benchmarks.md) override the estimate and flip memoryMeasured', () => {
    // Only tiny.en-q5_1 has been benchmarked so far (Linux VM, 2026-10-20); extend when more runs land.
    expect(Object.keys(MEASURED_MEMORY).sort()).toEqual(['tiny.en-q5_1'])
    for (const [id, bytes] of Object.entries(MEASURED_MEMORY)) {
      const e = getCatalogEntry(id)!
      expect(e, `${id} must be a catalog id`).toBeDefined()
      expect(bytes % (1024 * 1024)).toBe(0) // rounded up to a whole MiB by the procedure
      expect(bytes).toBeGreaterThan(e.sizeBytes)
      expect(e.memoryMeasured).toBe(true)
      expect(e.runtimeMemoryBytes).toBe(bytes)
    }
    expect(MEASURED_MEMORY['tiny.en-q5_1']).toBe(140 * 1024 * 1024)
  })

  it('f16 estimates land near the whisper.cpp README total-memory figures', () => {
    const near = (id: string, mb: number, tolerance: number): void => {
      const got = getCatalogEntry(id)!.runtimeMemoryBytes / (1024 * 1024)
      expect(Math.abs(got - mb)).toBeLessThanOrEqual(tolerance)
    }
    near('tiny', 273, 40)
    near('base', 388, 40)
    near('small', 852, 60)
    near('medium', 2100, 200)
  })

  it('class assignments follow the family', () => {
    expect(getCatalogEntry('tiny')).toMatchObject({ speedClass: 'fastest', accuracyClass: 'basic', liveCapable: true })
    expect(getCatalogEntry('base')).toMatchObject({ speedClass: 'fast', accuracyClass: 'fair', liveCapable: true })
    expect(getCatalogEntry('small')).toMatchObject({ speedClass: 'moderate', accuracyClass: 'good', liveCapable: true })
    expect(getCatalogEntry('medium')).toMatchObject({ speedClass: 'slow', accuracyClass: 'high', liveCapable: false })
    expect(getCatalogEntry('large-v3-turbo-q5_0')).toMatchObject({ speedClass: 'very-slow', accuracyClass: 'highest', liveCapable: false })
    expect(getCatalogEntry('large-v3-q5_0')).toMatchObject({ speedClass: 'very-slow', accuracyClass: 'highest', liveCapable: false })
  })
})
