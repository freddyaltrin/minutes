import { useEffect, useState } from 'react'
import { Button } from '../ui'
import { useApp } from '@renderer/state/app-store'
import { toast, updateSettings } from '@renderer/state/actions'
import { eventToAccelerator, formatShortcut } from '@renderer/lib/format'
import type { ShortcutDefinition } from '@shared/types'
import s from './settings.module.css'
import { Group, Section } from './SettingsRow'

const CATEGORY_ORDER: ShortcutDefinition['category'][] = ['Notes', 'Navigation', 'Recording', 'Application']

export function ShortcutsSection(): JSX.Element {
  const shortcuts = useApp((st) => st.settings.shortcuts)
  const [defs, setDefs] = useState<ShortcutDefinition[] | null>(null)
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [conflict, setConflict] = useState<{ id: string; with: string } | null>(null)

  useEffect(() => {
    void window.minutes.settings
      .shortcutDefinitions()
      .then(setDefs)
      .catch((err: Error) => {
        setDefs([])
        toast(`Could not load shortcuts: ${err.message}`, { kind: 'error' })
      })
  }, [])

  useEffect(() => {
    if (!recordingId || !defs) return
    const onKey = (e: KeyboardEvent): void => {
      // Window capture listener: runs before the Dialog's Escape handler and the app's shortcut routing.
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        setRecordingId(null)
        setConflict(null)
        return
      }
      const bareBackspace = e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
      const accel = bareBackspace ? '' : eventToAccelerator(e)
      if (accel === null) return // modifier only; keep waiting
      if (accel !== '') {
        const other = defs.find((d) => d.id !== recordingId && (shortcuts[d.id] ?? d.default) === accel)
        if (other) {
          setConflict({ id: recordingId, with: other.label })
          return
        }
      }
      void updateSettings({ shortcuts: { ...shortcuts, [recordingId]: accel } })
      setRecordingId(null)
      setConflict(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recordingId, defs, shortcuts])

  const resetAll = (): void => {
    if (!defs) return
    void updateSettings({ shortcuts: Object.fromEntries(defs.map((d) => [d.id, d.default])) })
    setRecordingId(null)
    setConflict(null)
    toast('Shortcuts reset to defaults')
  }

  const isDefault = defs ? defs.every((d) => (shortcuts[d.id] ?? d.default) === d.default) : true

  return (
    <Section
      title="Shortcuts"
      intro="Click Change, then press the new key combination. Escape cancels, Backspace disables the shortcut. Global shortcuts work even when Minutes is not the active window."
    >
      <div className={s.tableHeader}>
        <span className={s.help}>{recordingId ? 'Press keys…' : defs ? '' : 'Loading…'}</span>
        <Button variant="outline" size="sm" onClick={resetAll} disabled={!defs || isDefault}>
          Reset to defaults
        </Button>
      </div>
      {defs &&
        CATEGORY_ORDER.filter((c) => defs.some((d) => d.category === c)).map((category) => (
          <Group key={category} title={category}>
            <table className={s.table}>
              <tbody>
                {defs
                  .filter((d) => d.category === category)
                  .map((d) => {
                    const current = shortcuts[d.id] ?? d.default
                    const recording = recordingId === d.id
                    return (
                      <tr key={d.id}>
                        <td>
                          {d.label}
                          {d.scope === 'global' && <span className={s.scope}>global</span>}
                          {recording && conflict?.id === d.id && <div className={s.conflict}>Already used by “{conflict.with}”. Press a different combination, or Escape to cancel.</div>}
                        </td>
                        <td className={s.tableActions}>
                          {recording ? (
                            <span className={s.recordingHint} aria-live="polite">
                              Press keys…
                            </span>
                          ) : current ? (
                            <kbd className={s.kbd}>{formatShortcut(current)}</kbd>
                          ) : (
                            <span className={[s.help, s.muted].join(' ')} style={{ display: 'inline', margin: 0 }}>
                              Disabled
                            </span>
                          )}
                        </td>
                        <td className={s.tableActions} style={{ width: 1 }}>
                          {recording ? (
                            <Button
                              size="sm"
                              onClick={() => {
                                setRecordingId(null)
                                setConflict(null)
                              }}
                            >
                              Cancel
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              onClick={() => {
                                setConflict(null)
                                setRecordingId(d.id)
                              }}
                            >
                              Change
                            </Button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          </Group>
        ))}
    </Section>
  )
}
