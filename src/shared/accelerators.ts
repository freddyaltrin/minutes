// Canonical accelerator handling shared by main (before-input-event) and renderer (keydown fallback).

const KEY_ALIASES: Record<string, string> = {
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  enter: 'return',
  ' ': 'space',
  '+': 'plus',
  esc: 'escape',
  del: 'delete'
}

/** Canonical form: "ctrl+shift+k" (CommandOrControl → ctrl on Windows/Linux, cmd on macOS). */
export function normalizeAccelerator(accel: string, platform: string): string {
  const mods = new Set<string>()
  let key = ''
  for (const raw of accel.split('+')) {
    const p = raw.trim().toLowerCase()
    if (!p) {
      key = 'plus'
      continue
    }
    if (p === 'commandorcontrol' || p === 'cmdorctrl') mods.add(platform === 'darwin' ? 'cmd' : 'ctrl')
    else if (p === 'command' || p === 'cmd' || p === 'super' || p === 'meta') mods.add('cmd')
    else if (p === 'control' || p === 'ctrl') mods.add('ctrl')
    else if (p === 'shift') mods.add('shift')
    else if (p === 'alt' || p === 'option') mods.add('alt')
    else key = KEY_ALIASES[p] ?? p
  }
  return [...['ctrl', 'cmd', 'alt', 'shift'].filter((m) => mods.has(m)), key].join('+')
}

export interface KeyLike {
  key: string
  code: string
  control: boolean
  meta: boolean
  alt: boolean
  shift: boolean
}

/** Canonical accelerator for a key press, or null when it cannot be a shortcut (no modifier / bare modifier). */
export function keyToAccelerator(input: KeyLike): string | null {
  const k = input.key
  if (!k || ['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return null
  const mods: string[] = []
  if (input.control) mods.push('ctrl')
  if (input.meta) mods.push('cmd')
  if (input.alt) mods.push('alt')
  if (input.shift) mods.push('shift')
  if (mods.length === 0 || (mods.length === 1 && mods[0] === 'shift')) return null
  let key = k.toLowerCase()
  key = KEY_ALIASES[key] ?? key
  // With Shift held, Chromium reports the shifted character; use the physical code for letters/digits.
  const physical = input.code.replace(/^(Key|Digit)/, '').toLowerCase()
  if (/^(Key|Digit)/.test(input.code) && physical.length === 1) key = physical
  return [...mods, key].join('+')
}
