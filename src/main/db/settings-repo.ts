import type { Database } from './database'
import type { Settings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'

const KEY = 'settings'

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return base
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const cur = out[k]
    if (cur && typeof cur === 'object' && !Array.isArray(cur) && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(cur, v)
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out as T
}

/** Application settings live in the same SQLite file but are logically separate from user content. */
export class SettingsRepo {
  private cache: Settings | null = null
  constructor(private readonly db: Database) {}

  get(): Settings {
    if (this.cache) return this.cache
    const row = this.db.get<{ value_json: string }>('SELECT value_json FROM settings WHERE key = ?', KEY)
    let stored: unknown = {}
    if (row) {
      try {
        stored = JSON.parse(row.value_json)
      } catch {
        stored = {}
      }
    }
    // Merge over defaults so new keys added in later versions always exist.
    const merged = deepMerge(structuredClone(DEFAULT_SETTINGS), stored)
    merged.shortcuts = { ...DEFAULT_SETTINGS.shortcuts, ...(merged.shortcuts ?? {}) }
    this.cache = merged
    return merged
  }

  set(patch: Partial<Settings>): Settings {
    const next = deepMerge(this.get(), patch)
    this.db.run('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json', KEY, JSON.stringify(next))
    this.cache = next
    return next
  }

  /** Resets preferences only. Never touches notes, transcripts or recordings. */
  reset(): Settings {
    this.db.run('DELETE FROM settings WHERE key = ?', KEY)
    this.cache = null
    return this.get()
  }

  getValue<T>(key: string, fallback: T): T {
    const row = this.db.get<{ value_json: string }>('SELECT value_json FROM settings WHERE key = ?', key)
    if (!row) return fallback
    try {
      return JSON.parse(row.value_json) as T
    } catch {
      return fallback
    }
  }

  setValue(key: string, value: unknown): void {
    this.db.run('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json', key, JSON.stringify(value))
  }
}
