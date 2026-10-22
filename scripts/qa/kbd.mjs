import { join } from 'node:path'
export default async function (win, app, out) {
  const shot = (n) => win.screenshot({ path: join(out, `kbd-${n}.png`) })
  const active = () => win.evaluate(() => { const a = document.activeElement; return `${a.tagName.toLowerCase()}${a.className ? '.' + String(a.className).split(' ')[0] : ''} [${a.getAttribute('aria-label') || a.textContent?.trim().slice(0, 30)}]` })
  await win.evaluate(async () => {
    for (let i = 0; i < 4; i++) await window.minutes.notes.create({ title: `Note ${i}`, bodyText: 'hello world ' + i, bodyJson: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world ' + i }] }] }), meetingAt: Date.now() - i * 1000 })
  })
  await win.click('text=All notes'); await win.waitForTimeout(500)
  await win.click('[role=option] >> nth=0'); await win.waitForTimeout(300)
  // Tab order from the top
  await win.click('body', { position: { x: 5, y: 400 } }).catch(() => {})
  await win.evaluate(() => (document.activeElement).blur())
  const order = []
  for (let i = 0; i < 20; i++) { await win.keyboard.press('Tab'); order.push(await active()) }
  console.log('TAB ORDER:\n  ' + order.join('\n  '))
  // focus ring on nav item
  await win.evaluate(() => (document.activeElement).blur())
  await win.keyboard.press('Tab'); await win.keyboard.press('Tab'); await win.keyboard.press('Tab'); await win.keyboard.press('Tab')
  await shot('focus-nav')
  // arrow keys in list
  await win.focus('[role=listbox]')
  const before = await win.evaluate(() => document.querySelector('[role=option][aria-selected=true]')?.textContent)
  await win.keyboard.press('ArrowDown'); await win.waitForTimeout(300)
  const after = await win.evaluate(() => document.querySelector('[role=option][aria-selected=true]')?.textContent)
  console.log('ARROW DOWN:', before?.slice(0, 20), '->', after?.slice(0, 20))
  await shot('focus-list')
  await win.keyboard.press('Enter'); await win.waitForTimeout(200)
  console.log('ENTER from list ->', await active())
  // Escape closes find, palette
  await win.keyboard.press('Control+F'); await win.waitForTimeout(200); console.log('find open ->', await active())
  await win.keyboard.press('Escape'); await win.waitForTimeout(200); console.log('after esc ->', await active(), 'findbar?', await win.$('[role=search]') !== null)
  await win.keyboard.press('Control+K'); await win.waitForTimeout(200); await win.keyboard.type('hello'); await win.waitForTimeout(500)
  await win.keyboard.press('ArrowDown'); await win.keyboard.press('ArrowDown'); await win.waitForTimeout(100)
  await shot('search-active')
  await win.keyboard.press('Enter'); await win.waitForTimeout(500)
  console.log('ENTER in search -> palette open?', await win.$('[role=dialog]') !== null, 'selected:', await win.evaluate(() => document.querySelector('[role=option][aria-selected=true]')?.textContent?.slice(0, 20)))
  // Escape closes settings and panel
  await win.keyboard.press('Control+,'); await win.waitForTimeout(300); await win.keyboard.press('Escape'); await win.waitForTimeout(300)
  console.log('settings closed?', await win.$('[role=dialog]') === null)
  // context menu via keyboard
  await win.click('[role=option] >> nth=1', { button: 'right' }); await win.waitForTimeout(200)
  await win.keyboard.press('ArrowDown'); await win.keyboard.press('ArrowDown'); await win.waitForTimeout(100)
  await shot('menu-keyboard')
  await win.keyboard.press('Escape'); await win.waitForTimeout(200)
  console.log('menu closed?', await win.$('[role=menu]') === null)
  // focus ring on icon button + transcript rows
  await win.focus('button[aria-label="Transcript"]'); await shot('focus-iconbutton')
}
