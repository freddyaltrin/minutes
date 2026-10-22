import { _electron as electron } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const ud = mkdtempSync(join(tmpdir(), 'minutes-pk-'))
const app = await electron.launch({ executablePath: '/home/claude/minutes/release/linux-unpacked/minutes', args: ['--no-sandbox'], env: { ...process.env, MINUTES_USER_DATA: ud } })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('[pageerror]', e.message))
win.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()) })
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1500)
console.log('isPackaged:', await app.evaluate(({ app }) => app.isPackaged))
await win.keyboard.press('Control+N')
await win.waitForTimeout(300)
await win.fill('textarea[aria-label="Note title"]', 'Packaged smoke test')
await win.click('.ProseMirror'); await win.keyboard.type('hello from the packaged build')
await win.waitForTimeout(1200)
console.log('engineInfo:', JSON.stringify(await win.evaluate(() => window.minutes.transcription.engineInfo())).slice(0, 200))
console.log('update:', JSON.stringify(await win.evaluate(() => window.minutes.updates.getState())).slice(0, 160))
console.log('storage:', JSON.stringify(await win.evaluate(() => window.minutes.backup.storageInfo())).slice(0, 200))
await win.screenshot({ path: '/tmp/claude-0/-home-claude/f9b91c5f-5dd6-59d4-a2b2-069855a0b185/scratchpad/shots/30-packaged.png' })
await app.close()
console.log(readFileSync(join(ud, 'logs/minutes.log'), 'utf8').split('\n').filter(l => /error|warn/.test(l)).join('\n') || 'no warnings/errors in log')
