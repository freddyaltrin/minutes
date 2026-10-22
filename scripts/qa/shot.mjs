import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const userData = mkdtempSync(join(tmpdir(), 'minutes-ud-'))
const out = '/tmp/claude-0/-home-claude/f9b91c5f-5dd6-59d4-a2b2-069855a0b185/scratchpad/shots'
const app = await electron.launch({ args: ['--no-sandbox', `--user-data-dir=${userData}`, '.'], cwd: '/home/claude/minutes', env: { ...process.env, NODE_ENV: 'production' } })
const win = await app.firstWindow()
win.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[renderer]', m.type(), m.text()) })
win.on('pageerror', (e) => console.log('[pageerror]', e.message))
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(1500)
await win.setViewportSize({ width: 1180, height: 760 })
await win.screenshot({ path: join(out, '01-empty.png') })
const steps = process.argv[2]
if (steps) {
  const mod = await import(steps)
  await mod.default(win, app, out)
}
await app.close()
