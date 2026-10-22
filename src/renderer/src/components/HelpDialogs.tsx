import { useEffect, useState } from 'react'
import { Button, Dialog } from './ui'
import { Logo } from './Logo'
import { useApp } from '@renderer/state/app-store'
import { setOverlay, toast } from '@renderer/state/actions'
import { formatShortcut } from '@renderer/lib/format'
import { SHORTCUT_DEFINITIONS } from '@shared/defaults'
import type { ShortcutDefinition } from '@shared/types'

const CATEGORY_ORDER: ShortcutDefinition['category'][] = ['Notes', 'Navigation', 'Recording', 'Application']

/** TipTap keyboard shortcuts and input rules. These are fixed; they are not configurable. */
const EDITOR_SHORTCUTS: { label: string; keys: string[]; note?: string }[] = [
  { label: 'Bold', keys: ['CommandOrControl+B'] },
  { label: 'Italic', keys: ['CommandOrControl+I'] },
  { label: 'Undo', keys: ['CommandOrControl+Z'] },
  { label: 'Redo', keys: ['CommandOrControl+Y'] },
  { label: 'Bulleted list', keys: ['- '], note: 'type at the start of a line' },
  { label: 'Numbered list', keys: ['1. '], note: 'type at the start of a line' },
  { label: 'Checklist', keys: ['[] '], note: 'also "[ ] "' },
  { label: 'Heading', keys: ['# '], note: 'type at the start of a line' }
]

const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, height: 28 }
const labelStyle: React.CSSProperties = { flex: 1, color: 'var(--fg)', fontSize: 'var(--text-md)' }
const noteStyle: React.CSSProperties = { color: 'var(--fg-muted)', fontSize: 'var(--text-xs)' }
const headingStyle: React.CSSProperties = {
  margin: '14px 0 4px',
  fontSize: 'var(--text-xs)',
  fontWeight: 'var(--weight-semibold)' as React.CSSProperties['fontWeight'],
  color: 'var(--fg-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em'
}

/** Renders an input rule like "- " so the trailing space is visible. */
function InputRule({ text }: { text: string }): JSX.Element {
  return <kbd style={{ fontFamily: 'var(--font-mono)' }}>{text.replace(/ $/, '␣')}</kbd>
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const shortcuts = useApp((st) => st.settings.shortcuts)
  return (
    <Dialog
      title="Keyboard shortcuts"
      onClose={onClose}
      width={520}
      footer={
        <Button
          variant="outline"
          onClick={() => {
            setOverlay('settings', 'shortcuts')
          }}
        >
          Customize in Settings
        </Button>
      }
    >
      {CATEGORY_ORDER.map((category) => {
        const defs = SHORTCUT_DEFINITIONS.filter((d) => d.category === category)
        if (defs.length === 0) return null
        return (
          <section key={category}>
            <h3 style={headingStyle}>{category}</h3>
            {defs.map((d) => {
              const accel = shortcuts[d.id] ?? d.default
              return (
                <div key={d.id} style={rowStyle}>
                  <span style={labelStyle}>{d.label}</span>
                  {d.scope === 'global' && <span style={noteStyle}>works outside the window</span>}
                  {accel ? <kbd>{formatShortcut(accel)}</kbd> : <span style={noteStyle}>not set</span>}
                </div>
              )
            })}
          </section>
        )
      })}
      <section>
        <h3 style={headingStyle}>Editor</h3>
        {EDITOR_SHORTCUTS.map((e) => (
          <div key={e.label} style={rowStyle}>
            <span style={labelStyle}>{e.label}</span>
            {e.note && <span style={noteStyle}>{e.note}</span>}
            {e.keys.map((k) => (k.endsWith(' ') ? <InputRule key={k} text={k} /> : <kbd key={k}>{formatShortcut(k)}</kbd>))}
          </div>
        ))}
        <p style={{ ...noteStyle, margin: '8px 0 0', lineHeight: 'var(--leading-relaxed)' }}>Editor shortcuts are fixed. The shortcuts above can be changed in Settings.</p>
      </section>
    </Dialog>
  )
}

export function AboutDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    window.minutes.app
      .version()
      .then(setVersion)
      .catch(() => setVersion(''))
  }, [])

  const openDataFolder = (): void => {
    window.minutes.settings.openDataFolder().catch((err: Error) => toast(`Could not open data folder: ${err.message}`, { kind: 'error' }))
  }

  return (
    <Dialog title="About Minutes" onClose={onClose} width={440}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '4px 0 14px', color: 'var(--fg)' }}>
        <Logo size={32} title="Minutes" />
        <div>
          <div style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-medium)' as React.CSSProperties['fontWeight'], lineHeight: 1.2 }}>Minutes</div>
          <div style={noteStyle}>{version === null ? 'Version …' : version ? `Version ${version}` : 'Version unavailable'}</div>
        </div>
      </div>
      <p style={{ margin: '0 0 12px', lineHeight: 'var(--leading-relaxed)' }}>
        Minutes is a private, offline meeting-notes app. There are no accounts and no cloud sync; your notes, transcripts and recordings stay on this computer. Transcription runs on this computer with an open-source speech model (whisper.cpp); nothing is sent to any server. Suggestions and search are rule-based.
      </p>
      <div style={{ display: 'flex', gap: 8, margin: '0 0 14px' }}>
        <Button variant="outline" onClick={openDataFolder}>
          Open data folder
        </Button>
        <Button variant="outline" onClick={() => setOverlay('settings', 'updates')}>
          Check for updates
        </Button>
      </div>
      <p style={{ ...noteStyle, margin: 0, lineHeight: 'var(--leading-relaxed)' }}>MIT licensed. Built with Electron, React, TipTap and SQLite.</p>
    </Dialog>
  )
}
