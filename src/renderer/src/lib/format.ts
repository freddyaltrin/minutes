const isMac = (): boolean => (window.minutesPlatform ?? 'win32') === 'darwin'

/** Renders an Electron accelerator for display, e.g. "CommandOrControl+Shift+R" → "Ctrl+Shift+R" / "⌘⇧R". */
export function formatShortcut(accel: string): string {
  if (!accel) return ''
  const mac = isMac()
  const parts = accel.split('+').map((p) => p.trim())
  const map: Record<string, string> = mac
    ? { CommandOrControl: '⌘', CmdOrCtrl: '⌘', Command: '⌘', Cmd: '⌘', Control: '⌃', Ctrl: '⌃', Shift: '⇧', Alt: '⌥', Option: '⌥', Super: '⌘' }
    : { CommandOrControl: 'Ctrl', CmdOrCtrl: 'Ctrl', Command: 'Win', Cmd: 'Win', Control: 'Ctrl', Ctrl: 'Ctrl', Shift: 'Shift', Alt: 'Alt', Option: 'Alt', Super: 'Win' }
  const keyMap: Record<string, string> = { Backspace: mac ? '⌫' : 'Backspace', Delete: 'Del', Up: '↑', Down: '↓', Left: '←', Right: '→', Return: 'Enter', Enter: 'Enter', Escape: 'Esc', Space: 'Space', Plus: '+', ',': ',', '\\': '\\' }
  const out = parts.map((p) => map[p] ?? keyMap[p] ?? (p.length === 1 ? p.toUpperCase() : p))
  return mac ? out.join('') : out.join('+')
}

/** Converts a KeyboardEvent to an Electron accelerator string, or null if only modifiers are pressed. */
export function eventToAccelerator(e: KeyboardEvent): string | null {
  const mods: string[] = []
  if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  const k = e.key
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return null
  const special: Record<string, string> = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Escape', Enter: 'Return', Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab', '+': 'Plus' }
  let key = special[k] ?? (k.length === 1 ? k.toUpperCase() : k)
  if (/^F\d{1,2}$/.test(k)) key = k
  return [...mods, key].join('+')
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export function formatDate(ms: number, opts: { withYear?: boolean } = {}): string {
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(opts.withYear || !sameYear ? { year: 'numeric' } : {}) })
}

export function formatDateTime(ms: number): string {
  return `${formatDate(ms)}, ${formatTime(ms)}`
}

export function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Day group label used by the notes list: Today, Yesterday, weekday names within a week, then dates. */
export function dayGroupLabel(ms: number, now = Date.now()): string {
  const day = startOfDay(ms)
  const today = startOfDay(now)
  const diff = Math.round((today - day) / 86400_000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  if (diff === -1) return 'Tomorrow'
  if (diff > 1 && diff < 7) return new Date(ms).toLocaleDateString(undefined, { weekday: 'long' })
  if (diff < 0 && diff > -7) return new Date(ms).toLocaleDateString(undefined, { weekday: 'long' })
  return formatDate(ms)
}

export function relativeTime(ms: number, now = Date.now()): string {
  const diff = now - ms
  if (diff < 45_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`
  return formatDate(ms)
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function attendeeSummary(names: string[], max = 2): string {
  if (names.length === 0) return ''
  const shown = names.slice(0, max).map((n) => n.split('<')[0].trim()).filter(Boolean)
  const rest = names.length - shown.length
  return rest > 0 ? `${shown.join(', ')} +${rest}` : shown.join(', ')
}
