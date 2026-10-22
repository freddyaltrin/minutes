import { dialog, shell } from 'electron'
import { join, basename } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import type { AppContext } from '../context'
import type { ExportResult } from '@shared/types'
import { renderNoteMarkdown, renderNoteText, renderTranscript } from '@shared/text'

const sanitizeFileName = (s: string): string =>
  (s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled')

const stamp = (ms: number | null): string => {
  const d = new Date(ms ?? Date.now())
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export class ExportService {
  constructor(private readonly ctx: AppContext) {}

  private ensureExportsDir(): string {
    mkdirSync(this.ctx.paths.exports, { recursive: true })
    return this.ctx.paths.exports
  }

  private async saveWithDialog(defaultName: string, filters: Electron.FileFilter[], content: string): Promise<ExportResult> {
    const win = this.ctx.mainWindow ?? undefined
    const res = await dialog.showSaveDialog(win!, {
      title: 'Export',
      defaultPath: join(this.ensureExportsDir(), defaultName),
      filters,
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
    if (res.canceled || !res.filePath) return { ok: false, path: null, cancelled: true, error: null }
    try {
      writeFileSync(res.filePath, content, 'utf8')
      this.ctx.log.info('exported', { path: res.filePath })
      return { ok: true, path: res.filePath, cancelled: false, error: null }
    } catch (err) {
      this.ctx.log.error('export failed', err)
      return { ok: false, path: res.filePath, cancelled: false, error: (err as Error).message }
    }
  }

  render(noteId: string, format: 'md' | 'txt'): string {
    const note = this.ctx.notes.get(noteId)
    if (!note) throw new Error('Note not found')
    const t = this.ctx.transcripts.getByNote(noteId)
    const extractions = this.ctx.transcripts.listExtractions(noteId).filter((e) => !e.dismissed)
    const input = {
      title: note.title,
      meetingAt: note.meetingAt ?? note.createdAt,
      attendees: note.attendees,
      tags: note.tags,
      bodyJson: note.bodyJson,
      transcript: t ? { segments: t.segments.map((s) => ({ startMs: s.startMs, endMs: s.endMs, text: s.text, speaker: s.channel === 'mic' ? 'Me' : s.channel === 'system' ? 'Them' : null })) } : null,
      extractions
    }
    return format === 'md' ? renderNoteMarkdown(input) : renderNoteText(input)
  }

  async noteMarkdown(noteId: string): Promise<ExportResult> {
    const note = this.ctx.notes.get(noteId)
    if (!note) throw new Error('Note not found')
    return this.saveWithDialog(`${stamp(note.meetingAt ?? note.createdAt)} ${sanitizeFileName(note.title)}.md`, [{ name: 'Markdown', extensions: ['md'] }], this.render(noteId, 'md'))
  }

  async noteText(noteId: string): Promise<ExportResult> {
    const note = this.ctx.notes.get(noteId)
    if (!note) throw new Error('Note not found')
    return this.saveWithDialog(`${stamp(note.meetingAt ?? note.createdAt)} ${sanitizeFileName(note.title)}.txt`, [{ name: 'Plain text', extensions: ['txt'] }], this.render(noteId, 'txt'))
  }

  async transcript(noteId: string, format: 'txt' | 'srt' | 'vtt' | 'md'): Promise<ExportResult> {
    const note = this.ctx.notes.get(noteId)
    if (!note) throw new Error('Note not found')
    const t = this.ctx.transcripts.getByNote(noteId)
    if (!t || t.segments.length === 0) return { ok: false, path: null, cancelled: false, error: 'This note has no transcript to export.' }
    const content = renderTranscript(
      t.segments.map((s) => ({ startMs: s.startMs, endMs: s.endMs, text: s.text, speaker: s.channel === 'mic' ? 'Me' : s.channel === 'system' ? 'Them' : null })),
      format
    )
    const names: Record<string, string> = { txt: 'Plain text', srt: 'SubRip subtitles', vtt: 'WebVTT', md: 'Markdown' }
    return this.saveWithDialog(`${stamp(note.meetingAt ?? note.createdAt)} ${sanitizeFileName(note.title)} transcript.${format}`, [{ name: names[format], extensions: [format] }], content)
  }

  async allNotesMarkdown(): Promise<ExportResult> {
    const win = this.ctx.mainWindow ?? undefined
    const res = await dialog.showOpenDialog(win!, {
      title: 'Choose a folder for the export',
      defaultPath: this.ensureExportsDir(),
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || res.filePaths.length === 0) return { ok: false, path: null, cancelled: true, error: null }
    const dir = join(res.filePaths[0], `Minutes export ${stamp(null)}`)
    if (existsSync(dir)) {
      const { response } = await dialog.showMessageBox(win!, {
        type: 'question',
        buttons: ['Overwrite', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: `"${basename(dir)}" already exists. Overwrite files inside it?`
      })
      if (response === 1) return { ok: false, path: null, cancelled: true, error: null }
    }
    mkdirSync(dir, { recursive: true })
    let count = 0
    const used = new Set<string>()
    for (const n of this.ctx.notes.list({ view: 'all', limit: 5000 }).concat(this.ctx.notes.list({ view: 'archived', limit: 5000 }))) {
      let name = `${stamp(n.meetingAt ?? n.createdAt)} ${sanitizeFileName(n.title)}`
      let candidate = name
      let i = 2
      while (used.has(candidate.toLowerCase())) candidate = `${name} (${i++})`
      used.add(candidate.toLowerCase())
      name = candidate
      writeFileSync(join(dir, name + '.md'), this.render(n.id, 'md'), 'utf8')
      count++
    }
    this.ctx.log.info('exported all notes', { dir, count })
    return { ok: true, path: dir, cancelled: false, error: null }
  }

  async openExportsFolder(): Promise<void> {
    await shell.openPath(this.ensureExportsDir())
  }
}
