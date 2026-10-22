// Design-audit walkthrough: every major state in light and dark.
import { join } from 'node:path'

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
Sam: I will send the revised rate card by Friday and I will also check whether the EverVolt drawings need another revision before the client call.
`

export default async function (win, app, out) {
  const theme = process.env.AUDIT_THEME || 'light'
  const shot = (n) => win.screenshot({ path: join(out, `${theme}-${n}.png`) })
  const settle = (ms = 350) => win.waitForTimeout(ms)
  if (theme === 'dark') {
    await win.keyboard.press('Control+,'); await settle(400)
    await win.click('button:has-text("Dark")'); await settle(200)
    await win.keyboard.press('Escape'); await settle(400)
  }
  await shot('00-welcome')

  // empty views
  await win.click('text=Trash'); await settle(); await shot('01-trash-empty')
  await win.click('text=Favorites'); await settle(); await shot('02-fav-empty')
  await win.click('text=Archive'); await settle(); await shot('03-archive-empty')
  await win.click('text=Recent'); await settle()

  // seed notes via API
  await win.evaluate(async () => {
    const f = await window.minutes.folders.create('Clients')
    const f2 = await window.minutes.folders.create('Internal')
    const words = 'pipeline review budget client proposal drawings schedule invoice design approval tracker site survey'.split(' ')
    for (let i = 0; i < 14; i++) {
      const body = Array.from({ length: 30 }, (_, k) => words[(i + k) % words.length]).join(' ')
      const n = await window.minutes.notes.create({ title: i === 3 ? '' : `Meeting ${i} with ${words[i % words.length]} and a title that is quite long for the list`, bodyText: body, bodyJson: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }] }), meetingAt: Date.now() - i * 3600_000 * 9, attendees: i % 2 ? ['Deepak Anand', 'Sam', 'Vetri', 'Fredrick'] : [], folderId: i % 3 === 0 ? f.id : i % 3 === 1 ? f2.id : null })
      if (i === 1) await window.minutes.notes.update(n.id, { pinned: true })
      if (i === 2 || i === 5) await window.minutes.notes.update(n.id, { favorite: true })
      if (i === 4) await window.minutes.notes.setTags(n.id, ['fst', 'petroka'])
    }
  })
  await win.click('text=All notes'); await settle(600)
  await shot('04-list')

  // Note with everything
  await win.keyboard.press('Control+N'); await settle()
  await win.fill('textarea[aria-label="Note title"]', 'Q3 GTM sync with the engineering leads and the Petroka account team — a very long title to see wrapping')
  await win.click('.ProseMirror')
  await win.keyboard.type('# Agenda\nPipeline review with Deepak and the proposal for Petroka.\n- Pipeline review\nPetroka NFUP proposal: we decided to go with the fixed-price option.\n\n')
  await win.keyboard.type('1. First numbered\nSecond numbered\n\n')
  await win.keyboard.type('[] Follow up with EverVolt on the Rev5 drawings\nSam to send the revised rate card by Friday\n\n')
  await win.keyboard.type('> A quoted remark from the client about the schedule.\n\n')
  await win.keyboard.type('```\nconst x = 1')
  await win.keyboard.press('ArrowDown'); await win.keyboard.press('ArrowDown')
  await win.keyboard.press('Control+End')
  await win.keyboard.type('\nSee https://dexteritydesign.co.in for the brochure. Action: Vetri will schedule the client call next Tuesday.\n')
  await settle(900)
  await win.click('.ProseMirror', { position: { x: 20, y: 20 } }); await settle(400)
  await shot('05-editor-focused')
  await win.keyboard.press('Control+End'); await win.keyboard.type('Finally an error toast: '); await settle(300)
  await win.evaluate(() => window.minutes.transcripts.import({ noteId: 'nope', content: '', format: 'auto', fileName: 'x.srt' }).catch(() => {}))
  await settle(600); await shot('05b-error-toast')
  await settle(5000)
  // details: attendees, tags, folder
  await win.click('text=Add attendees'); await settle()
  await win.fill('input[aria-label="Attendees"]', 'Deepak Anand'); await win.keyboard.press('Enter')
  await win.fill('input[aria-label="Attendees"]', 'Sam'); await win.keyboard.press('Enter')
  await win.fill('input[aria-label="Attendees"]', 'Vetri'); await win.keyboard.press('Enter')
  await win.fill('input[aria-label="Attendees"]', 'Fredrick'); await win.keyboard.press('Enter')
  await win.fill('input[aria-label="Tags"]', 'petroka'); await win.keyboard.press('Enter')
  await win.fill('input[aria-label="Tags"]', 'gtm'); await win.keyboard.press('Enter')
  await win.selectOption('#details-folder', { label: 'Clients' })
  await settle(600)
  await shot('06-details')
  // find bar
  await win.click('aside[aria-label="Note details"] button[aria-label="Close"]'); await settle()
  await win.click('.ProseMirror', { position: { x: 20, y: 20 } }); await win.keyboard.press('Control+F'); await settle(); await win.keyboard.type('petroka'); await settle()
  await shot('07-find')
  await win.keyboard.press('Escape'); await settle()

  // transcript
  await win.keyboard.press('Control+T'); await settle()
  await shot('08-transcript-empty')
  const input = await win.$('input[type=file]')
  await input.setInputFiles({ name: 'meeting.srt', mimeType: 'text/plain', buffer: Buffer.from(SRT) })
  await settle(800)
  await shot('09-transcript')
  await win.hover('[class*="row"]:has-text("RLM")'); await settle(300)
  await shot('10-transcript-hover')
  await win.click('button[aria-label="Search transcript"]'); await settle(); await win.keyboard.type('invoice'); await settle()
  await shot('11-transcript-search')
  await win.keyboard.type('zzz'); await settle(); await shot('12-transcript-nomatch')
  await win.click('button[aria-label="Close search"]'); await settle()
  await win.hover('[class*="row"]:has-text("RLM")'); await win.click('button[aria-label="Edit line"]'); await settle()
  await shot('13-transcript-edit')
  await win.keyboard.press('Escape'); await settle()
  await win.click('button[aria-label="More"] >> nth=1'); await settle(); await shot('14-transcript-menu'); await win.keyboard.press('Escape')

  // suggestions
  await win.click('button[aria-label="Suggestions"]'); await settle(1000)
  await shot('15-suggestions')
  await win.hover('[class*="item"] >> nth=0'); await settle(200)
  await win.click('button[aria-label="Show source"] >> nth=0'); await settle()
  await shot('16-suggestions-source')
  await win.click('button[aria-label="Dismiss"] >> nth=0'); await settle(500)
  await win.click('text=Show'); await settle()
  await shot('17-suggestions-dismissed')

  // search palette
  await win.keyboard.press('Control+K'); await settle(); await shot('18-search-empty')
  await win.keyboard.type('petroka'); await settle(600); await shot('19-search')
  await win.keyboard.press('Control+A'); await win.keyboard.type('zzzqqq'); await settle(600); await shot('20-search-none')
  await win.keyboard.press('Escape'); await settle()
  await win.keyboard.press('Control+K'); await settle(); await win.keyboard.press('Control+A'); await win.keyboard.press('Backspace'); await settle(400); await shot('21-search-recent')
  await win.keyboard.press('Escape')
  await win.keyboard.press('Control+J'); await settle(); await win.keyboard.press('Control+A'); await win.keyboard.press('Backspace'); await settle(); await shot('22-ask-empty')
  await win.keyboard.type('what deadlines were mentioned?'); await settle(600); await shot('23-ask')
  await win.keyboard.press('Escape')

  // menus
  await win.click('button[aria-label="More"] >> nth=0'); await settle(); await shot('24-more-menu'); await win.keyboard.press('Escape')
  await win.click('button[aria-label="Sort"]'); await settle(); await shot('25-sort-menu'); await win.keyboard.press('Escape')
  await win.click('[role=option] >> nth=2', { button: 'right' }); await settle(); await shot('26-context-menu'); await win.keyboard.press('Escape')
  await win.click('button:has-text("Clients")', { button: 'right' }); await settle(); await shot('27-folder-menu'); await win.keyboard.press('Escape')

  // settings
  await win.keyboard.press('Control+,'); await settle(500)
  for (const sec of ['General', 'Audio', 'Transcription', 'Shortcuts', 'Calendar', 'Storage', 'Updates', 'Privacy', 'Diagnostics']) {
    await win.click(`nav[aria-label="Settings sections"] >> text=${sec}`); await settle(500)
    await shot(`28-settings-${sec.toLowerCase()}`)
  }
  await win.keyboard.press('Escape'); await settle()

  // help dialogs (opened through the application menu)
  const clickMenu = (label) => app.evaluate(({ Menu }, label) => {
    const help = Menu.getApplicationMenu().items.find((i) => i.label === '&Help')
    help.submenu.items.find((i) => i.label === label).click()
  }, label)
  await clickMenu('Keyboard Shortcuts'); await settle(500); await shot('29-shortcuts-dialog'); await win.keyboard.press('Escape'); await settle()
  await clickMenu('About Minutes'); await settle(500); await shot('29b-about-dialog'); await win.keyboard.press('Escape'); await settle()

  // toasts
  await win.keyboard.press('Control+Shift+Backspace'); await settle(400); await shot('30-toast-undo')
  await win.click('text=Undo').catch(() => {}); await settle(600)
  await win.evaluate(() => { /* no-op */ })

  // hover note list row + sidebar nav kbd
  await win.hover('[role=option] >> nth=3'); await settle(200); await shot('31-list-hover')
  await win.hover('text=New note >> nth=0'); await settle(200); await shot('32-sidebar-hover')

  // folder empty state + tag view
  await win.click('button:has-text("Internal")', { button: 'right' }); await win.keyboard.press('Escape')
  await win.click('text=#petroka').catch(() => win.click('text=petroka').catch(() => {})); await settle(); await shot('33-tag-view')

  // narrow + wide
  await win.click('text=All notes'); await settle()
  await win.click('[role=option] >> nth=0'); await settle()
  await win.keyboard.press('Control+T'); await settle()
  await win.setViewportSize({ width: 760, height: 520 }); await settle(600); await shot('34-narrow-overlay')
  await win.keyboard.press('Control+T'); await settle()  // toggles? check
  await shot('35-narrow')
  await win.setViewportSize({ width: 1600, height: 900 }); await settle(600)
  await win.click('button[aria-label="Suggestions"]'); await settle(800); await shot('36-wide')
  await win.setViewportSize({ width: 1180, height: 760 }); await settle()
  // sidebar collapsed
  await win.keyboard.press('Control+\\').catch(() => {}); await settle(500); await shot('37-collapsed')
  await win.keyboard.press('Control+\\').catch(() => {}); await settle(500)
  // trash view with content
  await win.click('[role=option] >> nth=1'); await settle()
  await win.keyboard.press('Control+Shift+Backspace'); await settle(300)
  await win.click('text=Trash'); await settle(500); await shot('38-trash-view')
}
