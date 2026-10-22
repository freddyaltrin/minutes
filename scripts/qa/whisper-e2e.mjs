import { _electron as electron } from '@playwright/test'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const ud = mkdtempSync(join(tmpdir(), 'minutes-wh-'))
mkdirSync(join(ud, 'models', 'whisper'), { recursive: true })
copyFileSync('/home/claude/models/ggml-tiny.en-q5_1.bin', join(ud, 'models', 'whisper', 'ggml-tiny.en-q5_1.bin'))
const out = '/tmp/claude-0/-home-claude/f9b91c5f-5dd6-59d4-a2b2-069855a0b185/scratchpad/shots'
const app = await electron.launch({ args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '.'], cwd: '/home/claude/minutes', env: { ...process.env, MINUTES_USER_DATA: ud } })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('[pageerror]', e.message))
win.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)) })
await win.waitForLoadState('domcontentloaded'); await win.waitForTimeout(1200)
await win.evaluate(() => window.minutes.settings.set({ audio: { keepRecordings: true, captureSystemAudio: false } }))
console.log('plan:', JSON.stringify((await win.evaluate(() => window.minutes.transcription.plan())).modelId))
await win.keyboard.press('Control+,'); await win.waitForTimeout(400)
await win.click('[role=dialog] button:has-text("Transcription")'); await win.waitForTimeout(600)
await win.screenshot({ path: join(out, '50-settings-transcription.png') })
await win.keyboard.press('Escape')
await win.keyboard.press('Control+N'); await win.waitForTimeout(300)
await win.fill('textarea[aria-label="Note title"]', 'Whisper live test')
await win.click('button:has-text("Record")'); await win.waitForTimeout(16000)
await win.screenshot({ path: join(out, '51-recording-whisper.png') })
console.log('live:', JSON.stringify((await win.evaluate(() => window.minutes.recording.getState())).live))
await win.click('button[aria-label="Stop recording"]'); await win.waitForTimeout(4000)
console.log('after stop:', JSON.stringify((await win.evaluate(() => window.minutes.recording.getState())).status))
// background job over a real speech recording: inject jfk-based 40 s wav as a recording of this note
const noteId = await win.evaluate(() => window.minutes.settings.get().then(s => s.lastNoteId))
const src = readFileSync('/home/claude/models/jfk.wav'); const di = src.indexOf('data'); const pcm = src.subarray(di + 8, di + 8 + src.readUInt32LE(di + 4))
const data = Buffer.concat([pcm, pcm, pcm, pcm])
const hdr = Buffer.alloc(44); hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVEfmt ', 8); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(16000, 24); hdr.writeUInt32LE(32000, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40)
const recDir = join(ud, 'recordings', noteId); mkdirSync(recDir, { recursive: true })
const recPath = join(recDir, '2026-10-20T00-00-00-000Z-mic.wav'); writeFileSync(recPath, Buffer.concat([hdr, data]))
await app.evaluate(async ({ app }, { noteId, recPath, bytes }) => {
  // reach the services through the running main process: use the exported module cache
  const mod = globalThis.__minutesServices
  return !!mod
}, { noteId, recPath, bytes: data.length }).catch(() => {})
// simplest path: use the DB directly from a tiny helper exposed in dev? Not available — fall back to the Transcript panel UI once a recording row exists.
// Insert the recording row via a one-off sqlite script running in the app's main process is not exposed; use node:sqlite here instead (same file, WAL-safe for a single insert).
const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync(join(ud, 'data', 'minutes.sqlite'))
db.prepare('INSERT INTO recordings (id, note_id, path, started_at, duration_ms, size_bytes, sample_rate, channels) VALUES (?,?,?,?,?,?,?,?)').run('rec-jfk', noteId, recPath, Date.now(), data.length / 32, data.length + 44, 16000, 1)
db.close()
await win.keyboard.press('Control+T'); await win.waitForTimeout(600)
// enqueue via API with the real note id
const job = await win.evaluate((id) => window.minutes.jobs.enqueueRecording(id, 'rec-jfk'), noteId)
console.log('job queued:', job.status)
for (let i = 0; i < 60; i++) { await win.waitForTimeout(1000); const j = (await win.evaluate(() => window.minutes.jobs.list()))[0]; if (i % 5 === 0) console.log('job:', j.status, Math.round(j.progress * 100) + '%', j.rtf?.toFixed(2)); if (j.status === 'completed' || j.status === 'failed') { console.log('final:', j.status, j.segmentsWritten, 'segments', j.error ?? ''); break } }
await win.waitForTimeout(800)
await win.screenshot({ path: join(out, '52-transcript-after-job.png') })
await win.keyboard.press('Control+,'); await win.waitForTimeout(400); await win.click('[role=dialog] button:has-text("Transcription")'); await win.waitForTimeout(500)
await win.evaluate(() => { const el = document.querySelector('[role=dialog] [class*=content]') ; if (el) el.scrollTop = el.scrollHeight })
await win.waitForTimeout(300)
await win.screenshot({ path: join(out, '53-settings-jobs.png') })
await app.close()
console.log(readFileSync(join(ud, 'logs/minutes.log'), 'utf8').split('\n').filter(l => /transcription|whisper|error|warn/.test(l)).slice(-25).join('\n'))
