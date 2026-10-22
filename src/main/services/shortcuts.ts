import { app, globalShortcut, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import type { AppContext } from '../context'
import { SHORTCUT_DEFINITIONS } from '@shared/defaults'
import { keyToAccelerator, normalizeAccelerator } from '@shared/accelerators'

/**
 * Keyboard shortcuts are driven by the application menu (app scope) and globalShortcut (global scope).
 * The menu is the single source of truth, so every shortcut is discoverable from the menu bar and the
 * renderer only receives a `shortcut` event with the action id.
 */
export class ShortcutService {
  private registeredGlobal: string[] = []

  constructor(private readonly ctx: AppContext) {}

  private accel(id: string): string | undefined {
    const custom = this.ctx.settings.get().shortcuts[id]
    const def = SHORTCUT_DEFINITIONS.find((d) => d.id === id)
    const value = custom ?? def?.default
    return value && value.trim() ? value : undefined
  }

  private item(id: string, label: string): MenuItemConstructorOptions {
    return { label, accelerator: this.accel(id), click: () => this.ctx.emit('shortcut', id) }
  }

  apply(): void {
    this.buildMenu()
    this.registerGlobal()
    this.rebuildLookup()
  }

  private lookup = new Map<string, string>()

  private rebuildLookup(): void {
    this.lookup.clear()
    for (const def of SHORTCUT_DEFINITIONS) {
      const a = this.accel(def.id)
      if (a) this.lookup.set(normalizeAccelerator(a, process.platform), def.id)
    }
  }

  /**
   * Single execution path for app-scope shortcuts: runs before the page sees the key and before the
   * menu accelerator would fire, so a shortcut never triggers twice and never collides with editor keys.
   */
  attach(win: BrowserWindow): void {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const key = keyToAccelerator({ key: input.key, code: input.code, control: input.control, meta: input.meta, alt: input.alt, shift: input.shift })
      if (!key) return
      const id = this.lookup.get(key)
      if (!id) return
      event.preventDefault()
      this.ctx.emit('shortcut', id)
    })
  }

  private buildMenu(): void {
    const isMac = process.platform === 'darwin'
    const template: MenuItemConstructorOptions[] = [
      ...(isMac ? [{ role: 'appMenu' as const }] : []),
      {
        label: '&File',
        submenu: [
          this.item('note.new', 'New Note'),
          this.item('note.duplicate', 'Duplicate Note'),
          { type: 'separator' },
          this.item('note.save', 'Save Now'),
          { label: 'Export…', click: () => this.ctx.emit('shortcut', 'note.export') },
          { type: 'separator' },
          this.item('note.trash', 'Move to Trash'),
          { type: 'separator' },
          this.item('nav.settings', 'Settings…'),
          { type: 'separator' },
          isMac ? { role: 'close' } : { role: 'quit' }
        ]
      },
      {
        label: '&Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
          { type: 'separator' },
          this.item('note.find', 'Find in Note'),
          this.item('nav.search', 'Search Everything'),
          this.item('nav.ask', 'Ask Your Notes')
        ]
      },
      {
        label: '&View',
        submenu: [
          this.item('nav.sidebar', 'Toggle Sidebar'),
          this.item('nav.transcript', 'Toggle Transcript'),
          { type: 'separator' },
          this.item('nav.prev', 'Previous Note'),
          this.item('nav.next', 'Next Note'),
          { type: 'separator' },
          this.item('note.favorite', 'Toggle Favorite'),
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
          ...(app.isPackaged ? [] : [{ type: 'separator' as const }, { role: 'toggleDevTools' as const }, { role: 'reload' as const }])
        ]
      },
      {
        label: '&Recording',
        submenu: [this.item('rec.toggle', 'Start / Stop Recording'), this.item('rec.pause', 'Pause / Resume')]
      },
      {
        label: '&Help',
        submenu: [
          { label: 'Keyboard Shortcuts', click: () => this.ctx.emit('shortcut', 'help.shortcuts') },
          { label: 'Open Data Folder', click: () => void shell.openPath(this.ctx.paths.userData) },
          { label: 'Check for Updates…', click: () => this.ctx.emit('shortcut', 'help.updates') },
          { type: 'separator' },
          { label: 'About Minutes', click: () => this.ctx.emit('shortcut', 'help.about') }
        ]
      }
    ]
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  }

  private registerGlobal(): void {
    for (const a of this.registeredGlobal) globalShortcut.unregister(a)
    this.registeredGlobal = []
    for (const def of SHORTCUT_DEFINITIONS.filter((d) => d.scope === 'global')) {
      const a = this.accel(def.id)
      if (!a) continue
      try {
        const ok = globalShortcut.register(a, () => this.ctx.emit('shortcut', def.id))
        if (ok) this.registeredGlobal.push(a)
        else this.ctx.log.warn('global shortcut unavailable (taken by another app?)', { id: def.id, accelerator: a })
      } catch (err) {
        this.ctx.log.warn('global shortcut registration failed', { id: def.id, accelerator: a, err: (err as Error).message })
      }
    }
  }

  dispose(): void {
    globalShortcut.unregisterAll()
    this.registeredGlobal = []
  }
}

