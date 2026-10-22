import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Drives the production build (out/main/index.js). Every test gets a fresh, isolated user-data
// directory through MINUTES_USER_DATA, so no run can see another run's database or settings.

const REPO = resolve(__dirname, '..', '..')
const MAIN = join(REPO, 'out', 'main', 'index.js')

const SRT = `1
00:00:01,000 --> 00:00:04,000
Good morning everyone, quick status round on the Petroka job.

2
00:00:05,000 --> 00:00:09,000
We agreed to go with the SP3D route for the NFUP model.

3
00:00:10,000 --> 00:00:14,000
Karthik will send the RLM comparison sheet by Friday.

4
00:00:15,000 --> 00:00:18,000
Is the isometric list due before the client review?
`

interface Session {
  app: ElectronApplication
  page: Page
  userData: string
}

async function launch(userData: string): Promise<Session> {
  const app = await electron.launch({
    args: ['--no-sandbox', '.'],
    cwd: REPO,
    env: { ...process.env, MINUTES_USER_DATA: userData, NODE_ENV: 'production' },
    executablePath: undefined,
    timeout: 45_000
  })
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForLoadState('domcontentloaded')
  // The renderer bootstraps settings + counts before showing anything meaningful.
  await page.locator('nav[aria-label="Navigation"]').waitFor({ state: 'attached', timeout: 20_000 })
  ;(app as unknown as { __errors: string[] }).__errors = errors
  return { app, page, userData }
}

async function close(s: Session | null): Promise<void> {
  if (!s) return
  try {
    await s.app.close()
  } catch {
    /* already gone */
  }
}

const freshDir = (): string => mkdtempSync(join(tmpdir(), 'minutes-e2e-'))

/** Creates a note with Ctrl+N and returns the title input locator (already focused on a new note). */
async function newNote(page: Page): Promise<void> {
  await page.keyboard.press('Control+n')
  await page.locator('[aria-label="Note title"]').waitFor({ state: 'visible' })
}

async function typeNote(page: Page, title: string, body: string): Promise<void> {
  const titleInput = page.locator('[aria-label="Note title"]')
  await titleInput.click()
  await titleInput.fill(title)
  const editor = page.locator('.ProseMirror')
  await editor.click()
  await page.keyboard.type(body)
  await expect(page.getByText(/^Saved/)).toBeVisible({ timeout: 15_000 })
}

let session: Session | null = null
let dir = ''

test.beforeEach(() => {
  dir = freshDir()
})
test.afterEach(async () => {
  await close(session)
  session = null
  rmSync(dir, { recursive: true, force: true })
})

test('launches and shows the welcome state', async () => {
  session = await launch(dir)
  const { page, app } = session
  await expect(page.locator('h1')).toHaveText('Welcome to Minutes')
  await expect(page.locator('button[data-variant="primary"]', { hasText: 'New note' }).first()).toBeVisible()
  expect(await page.title()).toBe('Minutes')
  // The user-data override took effect in the main process.
  const userData = await app.evaluate(({ app }) => app.getPath('userData'))
  expect(userData).toBe(dir)
  expect((app as unknown as { __errors: string[] }).__errors).toEqual([])
})

test('a note typed with Ctrl+N autosaves and survives a restart', async () => {
  session = await launch(dir)
  await newNote(session.page)
  await typeNote(session.page, 'Persistence check', 'The quick zebra crossed the Chennai road.')
  // Let the save status settle, then shut down cleanly.
  await session.page.waitForTimeout(300)
  await close(session)
  session = null

  session = await launch(dir)
  const { page } = session
  const row = page.locator('[role="option"]', { hasText: 'Persistence check' })
  await expect(row).toBeVisible()
  await expect(row).toContainText('quick zebra')
  await row.click()
  await expect(page.locator('[aria-label="Note title"]')).toHaveValue('Persistence check')
  await expect(page.locator('.ProseMirror')).toContainText('The quick zebra crossed the Chennai road.')
})

test('Ctrl+K search finds the note by a body word and Enter opens it', async () => {
  session = await launch(dir)
  const { page } = session
  await newNote(page)
  await typeNote(page, 'Other note', 'Nothing of interest here.')
  await newNote(page)
  await typeNote(page, 'Searchable note', 'The pangolin report is ready for review.')
  // Go back to the first note so opening the hit is an observable change.
  await page.locator('[role="option"]', { hasText: 'Other note' }).click()
  await expect(page.locator('[aria-label="Note title"]')).toHaveValue('Other note')

  await page.keyboard.press('Control+k')
  const dialog = page.locator('[role="dialog"][aria-label="Search"]')
  await expect(dialog).toBeVisible()
  await dialog.locator('input').fill('pangolin')
  const hit = dialog.locator('button[data-row]').first()
  await expect(hit).toBeVisible()
  await expect(hit.locator('mark')).toHaveText('pangolin')
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  await expect(page.locator('[aria-label="Note title"]')).toHaveValue('Searchable note')
})

test('importing a transcript shows 4 rows and the Suggestions panel lists a Decisions group', async () => {
  session = await launch(dir)
  const { page } = session
  await newNote(page)
  await typeNote(page, 'Transcript note', 'Agenda for today.')
  await page.keyboard.press('Control+t')
  const panel = page.locator('aside[aria-label="Transcript"]')
  await expect(panel).toBeVisible()
  await panel.locator('input[type="file"]').setInputFiles({ name: 'meeting.srt', mimeType: 'text/plain', buffer: Buffer.from(SRT, 'utf8') })
  await expect(page.getByText('Imported 4 lines from meeting.srt')).toBeVisible()
  for (const line of ['quick status round', 'SP3D route', 'RLM comparison sheet', 'isometric list due']) {
    await expect(panel.getByText(line, { exact: false })).toBeVisible()
  }
  // Each row shows its start timestamp; four distinct timestamps = four rows.
  const stamps = panel.getByText(/^0:(01|05|10|15)$/)
  await expect(stamps).toHaveCount(4)
  await expect(page.locator('[role="option"]', { hasText: 'Transcript note' })).toBeVisible()

  await page.getByRole('button', { name: 'Suggestions' }).click()
  const suggestions = page.locator('aside[aria-label="Suggestions"]')
  await expect(suggestions).toBeVisible()
  const decisions = suggestions.locator('section[aria-label="Decisions"]')
  await expect(decisions).toBeVisible({ timeout: 15_000 })
  await expect(decisions).toContainText('SP3D')
})

test('Ctrl+Shift+Backspace trashes the note and Undo restores it', async () => {
  session = await launch(dir)
  const { page } = session
  await newNote(page)
  await typeNote(page, 'Doomed note', 'Soon to be trashed.')
  const row = page.locator('[role="option"]', { hasText: 'Doomed note' })
  await expect(row).toBeVisible()

  await page.keyboard.press('Control+Shift+Backspace')
  await expect(page.getByText('“Doomed note” moved to trash')).toBeVisible()
  await expect(row).toBeHidden()

  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(row).toBeVisible()
  await expect(page.getByText('moved to trash')).toBeHidden()
  // The data layer agrees: the note is back in the "all" view and the trash is empty.
  const counts = await page.evaluate(() => window.minutes.notes.counts())
  expect(counts.all).toBe(1)
  expect(counts.trash).toBe(0)
})

test('security: isolated renderer, locked-down web preferences and an eval-blocking CSP', async () => {
  session = await launch(dir)
  const { page, app } = session

  const probe = await page.evaluate(() => ({
    requireType: typeof (window as unknown as { require?: unknown }).require,
    processType: typeof (window as unknown as { process?: unknown }).process,
    minutesType: typeof window.minutes,
    hasNotes: typeof window.minutes?.notes === 'object' && typeof window.minutes.notes.list === 'function',
    ipcExposed: 'ipcRenderer' in (window.minutes as unknown as Record<string, unknown>),
    // The CSP is delivered as a response header (session.webRequest), not a <meta> tag.
    metaCsp: document.querySelector('meta[http-equiv]') === null
  }))
  expect(probe.requireType).toBe('undefined')
  expect(probe.processType).toBe('undefined')
  expect(probe.minutesType).toBe('object')
  expect(probe.hasNotes).toBe(true)
  expect(probe.ipcExposed).toBe(false)
  expect(probe.metaCsp).toBe(true)

  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    const p = w.webContents.getLastWebPreferences() as Record<string, unknown>
    return { contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, sandbox: p.sandbox, webSecurity: p.webSecurity }
  })
  expect(prefs).toEqual({ contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true })

  // Our CSP has no 'unsafe-eval' or 'unsafe-inline' for scripts. Note: code run through
  // page.evaluate() travels over CDP, which is permitted to eval regardless of CSP, so the policy is
  // observed from the page's own behaviour (violation events) and from webContents.executeJavaScript.
  const csp = await page.evaluate(async () => {
    const violations: string[] = []
    document.addEventListener('securitypolicyviolation', (e) => violations.push(`${e.violatedDirective}:${e.blockedURI}`))
    const w = window as unknown as Record<string, unknown>
    const inline = document.createElement('script')
    inline.textContent = 'window.__cspInline = 1'
    document.head.appendChild(inline)
    const remote = document.createElement('script')
    remote.src = 'https://example.invalid/x.js'
    document.head.appendChild(remote)
    let timerThrew: string | null = null
    try {
      setTimeout('window.__cspTimer = 1', 0)
    } catch (err) {
      timerThrew = (err as Error).name
    }
    await new Promise((r) => setTimeout(r, 300))
    return { inlineRan: w.__cspInline === 1, timerRan: w.__cspTimer === 1, timerThrew, violations }
  })
  expect(csp.inlineRan).toBe(false)
  expect(csp.timerRan).toBe(false)
  expect(csp.violations).toEqual(expect.arrayContaining(['script-src-elem:inline', 'script-src-elem:https://example.invalid/x.js', 'script-src:eval']))

  const evalResult = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
      "(() => { try { return { threw: false, value: new Function('return 1')() } } catch (e) { return { threw: true, name: e.name, message: e.message } } })()"
    )
  )
  expect(evalResult).toMatchObject({ threw: true, name: 'EvalError' })
  expect(String(evalResult.message)).toMatch(/Content Security Policy|unsafe-eval/)
})

test('update checks are disabled in a dev build and the app stays usable', async () => {
  session = await launch(dir)
  const { page } = session
  const state = await page.evaluate(() => window.minutes.updates.check())
  expect(state.status).toBe('disabled')
  expect(state.error).toMatch(/packaged|Windows/)
  const again = await page.evaluate(() => window.minutes.updates.getState())
  expect(again.status).toBe('disabled')
  // Still fully usable afterwards.
  await newNote(page)
  await typeNote(page, 'After update check', 'Still working offline.')
  await expect(page.locator('[role="option"]', { hasText: 'After update check' })).toBeVisible()
})
