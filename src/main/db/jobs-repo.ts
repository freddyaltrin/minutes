import { randomUUID } from 'node:crypto'
import type { Database } from './database'
import type { JobKind, JobStatus, TranscriptionJob } from '@shared/transcription-types'

/** A unit of audio a job still has to process: a 16 kHz mono PCM16 WAV file and its absolute offset. */
export interface JobSource {
  path: string
  offsetMs: number
  durationMs: number
  channel: 'mic' | 'system' | 'unknown'
  /** Byte range of the PCM data inside `path` (whole data section when absent). */
  byteStart?: number
  byteEnd?: number
}

export interface JobRecord extends TranscriptionJob {
  sources: JobSource[]
  nextIndex: number
}

export class JobsRepo {
  constructor(private readonly db: Database) {}

  private toJob(r: Record<string, unknown>): JobRecord {
    let sources: JobSource[] = []
    try {
      sources = JSON.parse(r.sources_json as string)
    } catch {
      /* corrupt row → empty sources, job will fail cleanly */
    }
    const title = (r.note_title as string | null) ?? ''
    return {
      id: r.id as string,
      kind: r.kind as JobKind,
      noteId: r.note_id as string,
      noteTitle: title,
      recordingId: (r.recording_id as string | null) ?? null,
      modelId: (r.model_id as string | null) ?? null,
      status: r.status as JobStatus,
      processedMs: Number(r.processed_ms),
      totalMs: Number(r.total_ms),
      progress: Number(r.total_ms) > 0 ? Math.min(1, Number(r.processed_ms) / Number(r.total_ms)) : 0,
      elapsedMs: Number(r.elapsed_ms),
      rtf: Number(r.processed_ms) > 0 ? Number(r.elapsed_ms) / Number(r.processed_ms) : null,
      segmentsWritten: Number(r.segments_written),
      error: (r.error as string | null) ?? null,
      attempts: Number(r.attempts),
      createdAt: Number(r.created_at),
      startedAt: (r.started_at as number | null) ?? null,
      finishedAt: (r.finished_at as number | null) ?? null,
      sources,
      nextIndex: Number(r.next_index)
    }
  }

  private readonly SELECT = `SELECT j.*, n.title AS note_title FROM transcription_jobs j LEFT JOIN notes n ON n.id = j.note_id`

  create(input: { kind: JobKind; noteId: string; recordingId: string | null; modelId: string | null; sources: JobSource[] }): JobRecord {
    const id = randomUUID()
    const total = input.sources.reduce((a, s) => a + s.durationMs, 0)
    this.db.run(
      `INSERT INTO transcription_jobs (id, kind, note_id, recording_id, model_id, status, sources_json, total_ms, created_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      id,
      input.kind,
      input.noteId,
      input.recordingId,
      input.modelId,
      JSON.stringify(input.sources),
      Math.round(total),
      Date.now()
    )
    return this.get(id)!
  }

  get(id: string): JobRecord | null {
    const r = this.db.get(`${this.SELECT} WHERE j.id = ?`, id)
    return r ? this.toJob(r) : null
  }

  list(opts: { status?: JobStatus[]; limit?: number } = {}): JobRecord[] {
    const where = opts.status?.length ? `WHERE j.status IN (${opts.status.map(() => '?').join(',')})` : ''
    return this.db.all(`${this.SELECT} ${where} ORDER BY j.created_at DESC LIMIT ?`, ...(opts.status ?? []), opts.limit ?? 200).map((r) => this.toJob(r))
  }

  /** Oldest queued job, if any. */
  nextQueued(): JobRecord | null {
    const r = this.db.get(`${this.SELECT} WHERE j.status = 'queued' ORDER BY j.created_at ASC LIMIT 1`)
    return r ? this.toJob(r) : null
  }

  existsFor(noteId: string, recordingId: string | null): boolean {
    const r = this.db.get(
      `SELECT 1 AS x FROM transcription_jobs WHERE note_id = ? AND COALESCE(recording_id, '') = COALESCE(?, '') AND status IN ('queued','running','paused')`,
      noteId,
      recordingId
    )
    return !!r
  }

  setStatus(id: string, status: JobStatus, patch: { error?: string | null; modelId?: string | null } = {}): void {
    const sets = ['status = ?']
    const params: (string | number | null)[] = [status]
    if (patch.error !== undefined) {
      sets.push('error = ?')
      params.push(patch.error)
    }
    if (patch.modelId !== undefined) {
      sets.push('model_id = ?')
      params.push(patch.modelId)
    }
    if (status === 'running') sets.push('started_at = COALESCE(started_at, ' + Date.now() + ')', 'attempts = attempts + 1')
    if (status === 'completed' || status === 'failed' || status === 'cancelled') sets.push('finished_at = ' + Date.now())
    params.push(id)
    this.db.run(`UPDATE transcription_jobs SET ${sets.join(', ')} WHERE id = ?`, ...params)
  }

  progress(id: string, p: { processedMs: number; elapsedMs: number; segmentsWritten: number; nextIndex: number }): void {
    this.db.run(
      'UPDATE transcription_jobs SET processed_ms = ?, elapsed_ms = ?, segments_written = ?, next_index = ? WHERE id = ?',
      Math.round(p.processedMs),
      Math.round(p.elapsedMs),
      p.segmentsWritten,
      p.nextIndex,
      id
    )
  }

  /** Resets a failed/cancelled job so it can run again from where it stopped. */
  requeue(id: string): void {
    this.db.run(`UPDATE transcription_jobs SET status = 'queued', error = NULL, finished_at = NULL WHERE id = ?`, id)
  }

  remove(id: string): void {
    this.db.run('DELETE FROM transcription_jobs WHERE id = ?', id)
  }

  /** Jobs left 'running' by a crash are returned to the queue on startup. */
  recoverInterrupted(): number {
    const res = this.db.run(`UPDATE transcription_jobs SET status = 'queued' WHERE status = 'running'`)
    return Number(res.changes)
  }

  activeSourcePaths(): string[] {
    return this.list({ status: ['queued', 'running', 'paused'] }).flatMap((j) => j.sources.map((s) => s.path))
  }
}
