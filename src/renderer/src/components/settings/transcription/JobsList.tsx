import { Pause, Play, RefreshCw, Trash2, X } from 'lucide-react'
import type { TranscriptionJob } from '@shared/transcription-types'
import { formatSpeed, modelLabel } from '@shared/model-labels'
import { IconButton } from '../../ui'
import { toast } from '@renderer/state/actions'
import { formatDuration } from '@renderer/lib/format'
import t from './transcription.module.css'

const STATUS_WORD: Record<TranscriptionJob['status'], string> = {
  queued: 'Queued',
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled'
}

export async function jobAction(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    toast(`${label} failed: ${(err as Error).message}`, { kind: 'error' })
  }
}

export function JobsList({ jobs, loaded }: { jobs: TranscriptionJob[]; loaded: boolean }): JSX.Element {
  if (!loaded) return <div className={t.empty}>Loading…</div>
  if (jobs.length === 0) return <div className={t.empty}>No background transcription jobs</div>
  const sorted = [...jobs].sort((a, b) => b.createdAt - a.createdAt)
  return (
    <div>
      {sorted.map((j) => (
        <JobRow key={j.id} job={j} />
      ))}
    </div>
  )
}

function JobRow({ job }: { job: TranscriptionJob }): JSX.Element {
  const j = window.minutes.jobs
  const pct = Math.round(Math.min(1, Math.max(0, job.progress)) * 100)
  const active = job.status === 'running' || job.status === 'paused' || job.status === 'queued'
  const speed = formatSpeed(job.rtf)
  const meta = [
    job.kind === 'live' ? 'Live' : 'Background',
    job.modelId ? modelLabel(job.modelId) : null,
    STATUS_WORD[job.status],
    job.totalMs > 0 ? `${formatDuration(job.processedMs)} of ${formatDuration(job.totalMs)}` : null,
    speed,
    job.attempts > 1 ? `attempt ${job.attempts}` : null
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className={t.job}>
      <div className={t.jobHead}>
        <span className={t.jobTitle} title={job.noteTitle}>
          {job.noteTitle || 'Untitled'}
        </span>
        {job.status === 'running' && (
          <IconButton label="Pause" size="sm" onClick={() => void jobAction('Pause', () => j.pause(job.id))}>
            <Pause size={13} />
          </IconButton>
        )}
        {job.status === 'paused' && (
          <IconButton label="Resume" size="sm" onClick={() => void jobAction('Resume', () => j.resume(job.id))}>
            <Play size={13} />
          </IconButton>
        )}
        {active && (
          <IconButton label="Cancel" size="sm" onClick={() => void jobAction('Cancel', () => j.cancel(job.id))}>
            <X size={13} />
          </IconButton>
        )}
        {(job.status === 'failed' || job.status === 'cancelled') && (
          <IconButton label="Retry" size="sm" onClick={() => void jobAction('Retry', () => j.retry(job.id))}>
            <RefreshCw size={13} />
          </IconButton>
        )}
        {!active && (
          <IconButton label="Remove from list" size="sm" onClick={() => void jobAction('Remove', () => j.remove(job.id))}>
            <Trash2 size={13} />
          </IconButton>
        )}
      </div>
      {active && (
        <div className={t.jobProgress} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className={t.progressBar} data-kind={job.status === 'paused' ? 'paused' : undefined} style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className={t.jobMeta}>
        {active ? `${pct}% · ` : ''}
        {meta}
      </div>
      {job.error && (
        <div className={t.jobMeta} data-kind="error">
          {job.error}
        </div>
      )}
    </div>
  )
}
