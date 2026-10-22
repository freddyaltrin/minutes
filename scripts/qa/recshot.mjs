// Recording pill states (recording / paused / finishing) with a fake microphone.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const ud = mkdtempSync(join(tmpdir(), 'minutes-rec-'))
const out = process.env.OUT || '/tmp/claude-0/-home-claude/f9b91c5f-5dd6-59d4-a2b2-069855a0b185/scratchpad/shots'
const theme = process.env.AUDIT_THEME || 'light'
const app = await electron.launch({ args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '.'], cwd: '/home/claude/minutes', env: { ...process.env, MINUTES_USER_DATA: ud, NODE_ENV: 'production' } })
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1200)
await win.setViewportSize({ width: 1180, height: 760 })
await win.evaluate((theme) => window.minutes.settings.set({ theme, audio: { keepRecordings: true, captureSystemAudio: false } }), theme)
await win.keyboard.press('Control+,'); await win.waitForTimeout(300)
await win.click(`button:has-text("${theme === 'dark' ? 'Dark' : 'Light'}")`); await win.keyboard.press('Escape'); await win.waitForTimeout(300)
await win.keyboard.press('Control+N'); await win.waitForTimeout(300)
await win.fill('textarea[aria-label="Note title"]', 'Weekly standup')
await win.click('.ProseMirror'); await win.keyboard.type('Agenda\n- FST as-built status\n- Petroka NFUP proposal\n')
await win.click('button:has-text("Record")')
await win.waitForTimeout(3500)
await win.screenshot({ path: join(out, `${theme}-rec-recording.png`) })
await win.keyboard.press('Control+Shift+P'); await win.waitForTimeout(600)
await win.screenshot({ path: join(out, `${theme}-rec-paused.png`) })
await win.keyboard.press('Control+Shift+P'); await win.waitForTimeout(800)
await win.keyboard.press('Control+T'); await win.waitForTimeout(500)
await win.screenshot({ path: join(out, `${theme}-rec-transcript.png`) })
await win.click('button[aria-label="Stop recording"]')
await win.waitForTimeout(150)
await win.screenshot({ path: join(out, `${theme}-rec-finishing.png`) })
await win.waitForTimeout(2500)
await win.screenshot({ path: join(out, `${theme}-rec-stopped.png`) })
await app.close()
