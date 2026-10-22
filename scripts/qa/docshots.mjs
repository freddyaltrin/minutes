// Produces the README screenshots in docs/screenshots (light) and docs/screenshots/dark (dark).
// Run: AUDIT_THEME=light|dark xvfb-run -a node scripts/qa/docshots.mjs
import { _electron as electron } from '@playwright/test'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const theme = process.env.AUDIT_THEME || 'light'
const out = theme === 'dark' ? '/home/claude/minutes/docs/screenshots/dark' : '/home/claude/minutes/docs/screenshots'
mkdirSync(out, { recursive: true })
const ud = mkdtempSync(join(tmpdir(), 'minutes-docs-'))
const app = await electron.launch({ args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '.'], cwd: '/home/claude/minutes', env: { ...process.env, MINUTES_USER_DATA: ud, NODE_ENV: 'production' } })
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1200)
await win.setViewportSize({ width: 1280, height: 800 })
const shot = (n) => win.screenshot({ path: join(out, `${n}.png`) })
const settle = (ms = 400) => win.waitForTimeout(ms)

await win.evaluate(() => window.minutes.settings.set({ audio: { keepRecordings: true, captureSystemAudio: false } }))
await win.keyboard.press('Control+,'); await settle()
await win.click(`button:has-text("${theme === 'dark' ? 'Dark' : 'Light'}")`); await win.keyboard.press('Escape'); await settle()

const SRT = `1
00:00:01,000 --> 00:00:04,000
Fredrick: Let us start with the FST as-built status.

2
00:00:05,000 --> 00:00:09,500
Vetri: The RLM comparison is done. We need to send the invoice by the 25th of October.

3
00:00:10,000 --> 00:00:14,000
Deepak: Agreed, let's go ahead with Rev-3 as the basis.

4
00:00:15,000 --> 00:00:19,000
Fredrick: Can you share the tracker with Petroka tomorrow?

5
00:00:20,000 --> 00:00:26,000
Sam: I will send the revised rate card by Friday and check whether the EverVolt drawings need another revision.
`
const paragraph = (t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })
await win.evaluate(async (paragraphSrc) => {
  const P = (t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })
  const f = await window.minutes.folders.create('Clients')
  const seed = [
    ['Petroka NFUP Ph-II kickoff', 'Scope: 3D modelling support on the NEB facilities upgrade. Deepak to confirm the rate card; proposal due Thursday.', 1, ['Deepak Anand', 'Sam']],
    ['EverVolt drawing review', 'Rev5 architectural set walked through with the client. Decision: keep the mezzanine layout, revise the stair core.', 2, ['Vetri', 'Fredrick']],
    ['Hiring sync', 'Two piping designers shortlisted. Vetri will schedule interviews next week.', 3, ['Vetri']],
    ['Weekly standup', 'Who owns the FST as-built review? Vetri will schedule the client call next Tuesday.', 4, ['Deepak Anand', 'Sam', 'Vetri']],
    ['Coworking launch planning', 'Pricing for hot desks agreed at the last meeting. Action: Sam to draft the brochure copy.', 6, ['Sam']],
    ['Board of Studies call', 'Regulation 2026 syllabus framing discussed; feedback on the design project module requested by month end.', 9, []]
  ]
  for (const [title, body, days, attendees] of seed) {
    const n = await window.minutes.notes.create({ title, bodyText: body, bodyJson: JSON.stringify({ type: 'doc', content: [P(body)] }), meetingAt: Date.now() - days * 86400_000 - 3600_000 * 2, attendees, folderId: days % 2 ? f.id : null })
    if (days === 2) await window.minutes.notes.update(n.id, { favorite: true })
  }
}, '')
await win.click('text=All notes'); await settle(600)

// The note with everything
await win.keyboard.press('Control+N'); await settle()
await win.fill('textarea[aria-label="Note title"]', 'FST as-built review — weekly sync')
await win.click('.ProseMirror')
await win.keyboard.type('# Agenda\nStatus of the as-built isometrics and the RLM comparison.\n\n')
await win.keyboard.type('- Lot 3 back-check is complete; 14 isos need re-extraction\nPMS Rev-3 agreed as the basis for the October invoice\n\n')
await win.keyboard.type('## Actions\n')
await win.keyboard.type('[] Vetri to send the invoice by 25 October\nSam to share the tracker with Petroka tomorrow\nDeepak to confirm the rate card by Friday\n\n')
await win.keyboard.type('> Client remark: keep the tag format identical to the P12513 set.\n')
await settle(800)
await win.click('text=Add attendees'); await settle()
for (const a of ['Deepak Anand', 'Sam', 'Vetri']) { await win.fill('input[aria-label="Attendees"]', a); await win.keyboard.press('Enter') }
await win.fill('input[aria-label="Tags"]', 'fst'); await win.keyboard.press('Enter')
await win.selectOption('#details-folder', { label: 'Clients' }); await settle(500)
await shot('details')
await win.click('aside[aria-label="Note details"] button[aria-label="Close"]'); await settle()
await win.click('.ProseMirror', { position: { x: 20, y: 60 } }); await settle()
await shot('editor')

// Recording pill
await win.click('button:has-text("Record")'); await settle(3200)
await shot('note-recording')
await win.keyboard.press('Control+Shift+P'); await settle(600)
await shot('note-recording-paused')
await win.click('button[aria-label="Stop recording"]'); await settle(2500)

// Transcript
await win.keyboard.press('Control+T'); await settle(500)
const input = await win.$('input[type=file]')
await input.setInputFiles({ name: 'meeting.srt', mimeType: 'text/plain', buffer: Buffer.from(SRT) })
await settle(900)
await win.click('button[aria-label="Dismiss"]').catch(() => {})
await win.click('text=Recordings (1)').catch(() => {}); await settle()
await win.hover('[class*="row"]:has-text("RLM")'); await settle(300)
await shot('transcript')
await win.click('button[aria-label="Search transcript"]'); await win.keyboard.type('invoice'); await settle()
await shot('transcript-search')
await win.click('button[aria-label="Close search"]')

// Suggestions
await win.click('button[aria-label="Suggestions"]'); await settle(1000)
await win.click('button[aria-label="Show source"] >> nth=0'); await settle()
await shot('suggestions')

// Search + Ask
await win.keyboard.press('Control+K'); await settle(); await win.keyboard.type('petroka'); await settle(600)
await shot('search')
await win.keyboard.press('Escape')
await win.keyboard.press('Control+J'); await settle(); await win.keyboard.press('Control+A'); await win.keyboard.type('what deadlines were mentioned?'); await settle(600)
await shot('ask')
await win.keyboard.press('Escape')

// Settings
await win.keyboard.press('Control+,'); await settle(400)
await win.click('nav[aria-label="Settings sections"] >> text=Transcription'); await settle(500)
await shot('settings-transcription')
await win.click('nav[aria-label="Settings sections"] >> text=Shortcuts'); await settle(500)
await shot('settings-shortcuts')
await win.keyboard.press('Escape'); await settle()

// Welcome (fresh data dir is simulated by trashing everything is overkill; capture the empty note state instead)
await app.close()
