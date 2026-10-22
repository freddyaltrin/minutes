import { join } from 'node:path'
export default async function (win, app, out) {
  const shot = (n) => win.screenshot({ path: join(out, n) })
  await win.keyboard.press('Control+N')
  await win.waitForTimeout(400)
  await win.fill('textarea[aria-label="Note title"]', 'Design review')
  await win.click('.ProseMirror')
  await win.keyboard.type('Review notes\n')
  await win.waitForTimeout(300)
  await shot('20-editor-focused.png')
  await win.click('button:has-text("Record")')
  await win.waitForTimeout(600)
  await shot('21-record-dialog.png')
  // choose keep audio -> starts recording (no mic in xvfb: expect error state)
  const keep = await win.$('button:has-text("Keep audio files")')
  if (keep) { await keep.click(); await win.waitForTimeout(2500); await shot('22-record-attempt.png') }
  await win.keyboard.press('Escape')
  await win.click('button[aria-label="More"]')
  await win.waitForTimeout(300)
  await shot('23-more-menu.png')
  await win.keyboard.press('Escape')
  // context menu on list row
  await win.click('[role=option]', { button: 'right' })
  await win.waitForTimeout(300)
  await shot('24-context-menu.png')
  await win.keyboard.press('Escape')
  // details panel
  await win.click('text=Add attendees')
  await win.waitForTimeout(400)
  await shot('25-details.png')
  // trash + undo
  await win.keyboard.press('Control+Shift+Backspace')
  await win.waitForTimeout(500)
  await shot('26-trash-toast.png')
  await win.click('text=Trash')
  await win.waitForTimeout(400)
  await shot('27-trash-view.png')
}
