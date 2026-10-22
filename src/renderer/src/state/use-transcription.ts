// Hooks that mirror the main-process transcription state (models, jobs, overview) into components.
// Each one fetches once on mount and then follows the matching `window.minutes.on.*` event.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ModelState, TranscriptionJob } from '@shared/transcription-types'
import type { TranscriptionOverview } from '@shared/api'
import { useApp } from './app-store'

export function useModels(): { models: ModelState[] | null; error: string | null } {
  const [models, setModels] = useState<ModelState[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    window.minutes.models
      .list()
      .then((m) => {
        if (!cancelled) setModels(m)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
    const off = window.minutes.on.modelsChanged((m) => {
      setModels(m)
      setError(null)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [])
  return { models, error }
}

export function useJobs(): { jobs: TranscriptionJob[]; loaded: boolean } {
  const [jobs, setJobs] = useState<TranscriptionJob[]>([])
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let cancelled = false
    window.minutes.jobs
      .list()
      .then((j) => {
        if (cancelled) return
        setJobs(j)
        setLoaded(true)
      })
      .catch(() => {
        if (!cancelled) setLoaded(true)
      })
    const off = window.minutes.on.jobsChanged((j) => {
      setJobs(j)
      setLoaded(true)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [])
  return { jobs, loaded }
}

/**
 * The full overview (hardware, plan, engine status, profiles). Re-fetched when the configuration
 * changes and, throttled, when the model list changes (install/remove changes the plan).
 */
export function useTranscriptionOverview(): { overview: TranscriptionOverview | null; error: string | null; refresh: () => Promise<void> } {
  const [overview, setOverview] = useState<TranscriptionOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const config = useApp((st) => st.settings.transcription)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    try {
      const o = await window.minutes.transcription.status()
      setOverview(o)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, config])

  useEffect(() => {
    const offModels = window.minutes.on.modelsChanged(() => {
      // Download progress fires often; one refresh per second is plenty for the plan block.
      if (timer.current) return
      timer.current = setTimeout(() => {
        timer.current = null
        void refresh()
      }, 1000)
    })
    const offLive = window.minutes.on.transcriptionStatus((live) => setOverview((o) => (o ? { ...o, live } : o)))
    return () => {
      offModels()
      offLive()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [refresh])

  return { overview, error, refresh }
}
