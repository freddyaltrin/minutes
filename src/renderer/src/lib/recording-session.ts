// Module-level owner of the live capture. Components come and go (navigating between notes
// unmounts RecordingControl); the recording must not. Everything that touches AudioCapture or
// `window.minutes.recording` goes through here.

import { AudioCapture, type CaptureChannel } from './audio-capture'
import type { NoteId } from '@shared/types'

export type LevelListener = (ch: CaptureChannel, rms: number) => void

export interface StartOptions {
  micDeviceId: string | null
  systemAudio: boolean
}

export interface StartResult {
  micLabel: string | null
  systemAudio: boolean
}

type Phase = 'idle' | 'starting' | 'running' | 'stopping'

class RecordingSession {
  private capture: AudioCapture | null = null
  private phase: Phase = 'idle'
  private noteId: NoteId | null = null
  private levelListeners = new Set<LevelListener>()
  private levels: Record<CaptureChannel, number> = { mic: 0, system: 0 }
  /** Raised by the UI layer so the session can surface non-fatal messages and device loss. */
  onNotice: ((msg: string, kind: 'error' | 'info') => void) | null = null
  onDeviceLost: (() => void) | null = null

  get activeNoteId(): NoteId | null {
    return this.noteId
  }
  get isActive(): boolean {
    return this.phase === 'starting' || this.phase === 'running'
  }
  get isPaused(): boolean {
    return !!this.capture?.isPaused
  }
  get elapsedMs(): number {
    return this.capture?.elapsedMs ?? 0
  }
  get hasSystemAudio(): boolean {
    return !!this.capture?.hasSystemAudio
  }
  currentLevel(ch: CaptureChannel): number {
    return this.levels[ch]
  }

  subscribeLevels(cb: LevelListener): () => void {
    this.levelListeners.add(cb)
    return () => this.levelListeners.delete(cb)
  }

  /**
   * begin() in main first (so chunks are accepted and state is published), then open the devices.
   * If the devices fail, main is told and the session is ended — no half-open recording.
   */
  async start(noteId: NoteId, opts: StartOptions): Promise<StartResult> {
    if (this.phase !== 'idle') throw new Error('A recording is already in progress')
    this.phase = 'starting'
    this.noteId = noteId
    const api = window.minutes.recording
    const capture = new AudioCapture()
    this.capture = capture
    try {
      await api.begin(noteId, { sampleRate: 16000, micLabel: null, systemAudio: opts.systemAudio })
    } catch (err) {
      this.reset()
      throw err instanceof Error ? err : new Error(String(err))
    }
    try {
      const result = await capture.start({
        micDeviceId: opts.micDeviceId,
        systemAudio: opts.systemAudio,
        onLevel: (ch, rms) => {
          this.levels[ch] = rms
          this.levelListeners.forEach((l) => l(ch, rms))
        },
        onChunk: (chunk) => {
          if (this.phase === 'running' || this.phase === 'starting') api.pushChunk(chunk)
        },
        onError: (msg) => this.onNotice?.(msg, 'error'),
        onDeviceLost: () => {
          this.onNotice?.('Microphone disconnected. Recording stopped.', 'error')
          this.onDeviceLost?.()
          void this.stop('device-lost')
        }
      })
      this.phase = 'running'
      // main was told systemAudio=true optimistically; if loopback was refused, it never receives
      // 'system' chunks, so its system chunker simply stays empty. Nothing to correct.
      return { micLabel: result.micLabel, systemAudio: result.systemAudio }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await capture.stop()
      try {
        await api.reportError(message) // reportError ends the session in main
      } catch {
        /* main already reset */
      }
      this.reset()
      throw new Error(message)
    }
  }

  async pause(): Promise<void> {
    if (this.phase !== 'running' || !this.capture || this.capture.isPaused) return
    this.capture.pause()
    this.levels = { mic: 0, system: 0 }
    this.levelListeners.forEach((l) => {
      l('mic', 0)
      l('system', 0)
    })
    await window.minutes.recording.pause()
  }

  async resume(): Promise<void> {
    if (this.phase !== 'running' || !this.capture || !this.capture.isPaused) return
    await window.minutes.recording.resume()
    this.capture.resume()
  }

  async togglePause(): Promise<void> {
    if (this.isPaused) await this.resume()
    else await this.pause()
  }

  async stop(reason = 'user'): Promise<void> {
    if (this.phase === 'idle' || this.phase === 'stopping') return
    this.phase = 'stopping'
    const capture = this.capture
    try {
      if (capture) await capture.stop() // flushes the last partial chunks before end()
    } finally {
      try {
        await window.minutes.recording.end(reason)
      } finally {
        this.reset()
      }
    }
  }

  private reset(): void {
    this.capture = null
    this.phase = 'idle'
    this.noteId = null
    this.levels = { mic: 0, system: 0 }
  }
}

export const recordingSession = new RecordingSession()
