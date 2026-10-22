import { useEffect, useState } from 'react'
import { Button } from '../ui'
import { store } from '@renderer/state/app-store'
import { applyTheme, toast } from '@renderer/state/actions'
import { formatDateTime, formatDuration } from '@renderer/lib/format'
import type { Diagnostics } from '@shared/types'
import s from './settings.module.css'
import { Group, Section } from './SettingsRow'

export function DiagnosticsSection(): JSX.Element {
  const [diag, setDiag] = useState<Diagnostics | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'export' | 'reset' | null>(null)

  useEffect(() => {
    void window.minutes.settings
      .diagnostics()
      .then(setDiag)
      .catch((err: Error) => setError(err.message))
  }, [])

  const exportDiagnostics = async (): Promise<void> => {
    setBusy('export')
    try {
      const res = await window.minutes.settings.exportDiagnostics()
      if (res.error) toast(`Export failed: ${res.error}`, { kind: 'error' })
      else if (res.ok && res.path) toast(`Diagnostics saved to ${res.path}`)
    } catch (err) {
      toast(`Export failed: ${(err as Error).message}`, { kind: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const resetPreferences = async (): Promise<void> => {
    const ok = await window.minutes.app.confirm({
      title: 'Reset preferences',
      message: 'Reset all preferences to their defaults?',
      detail: 'Appearance, audio, transcription, shortcut and update settings go back to defaults, recent searches are cleared, and Launch at login is turned off. Your notes, transcripts, recordings, calendars and backups are NOT affected.',
      confirmLabel: 'Reset preferences',
      destructive: true
    })
    if (!ok) return
    setBusy('reset')
    try {
      const settings = await window.minutes.settings.reset()
      store.set({ settings })
      applyTheme(settings)
      toast('Preferences reset to defaults')
    } catch (err) {
      toast(`Reset failed: ${(err as Error).message}`, { kind: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const cell = (v: string): JSX.Element => <span className={[s.mono, s.selectable].join(' ')}>{v}</span>

  return (
    <Section title="Diagnostics" intro="Technical details that help when something goes wrong. Nothing here is sent anywhere unless you export it and share the file yourself.">
      <Group title="This installation">
        {error ? (
          <div className={[s.help, s.danger].join(' ')}>Could not read diagnostics: {error}</div>
        ) : diag === null ? (
          <div className={s.help}>Collecting…</div>
        ) : (
          <dl className={s.dl}>
            <dt>Minutes</dt>
            <dd>{cell(diag.appVersion)}</dd>
            <dt>Electron</dt>
            <dd>{cell(diag.electron)}</dd>
            <dt>Chrome</dt>
            <dd>{cell(diag.chrome)}</dd>
            <dt>Node</dt>
            <dd>{cell(diag.node)}</dd>
            <dt>Platform</dt>
            <dd>{cell(`${diag.platform} ${diag.arch}`)}</dd>
            <dt>OS</dt>
            <dd>{cell(diag.osVersion)}</dd>
            <dt>SQLite</dt>
            <dd>{cell(diag.sqliteVersion)}</dd>
            <dt>Data path</dt>
            <dd>{cell(diag.userDataPath)}</dd>
            <dt>Uptime</dt>
            <dd>{cell(formatDuration(diag.uptimeSec * 1000))}</dd>
            <dt>Migrations</dt>
            <dd>
              <span className={s.selectable}>
                {diag.migrations.length === 0
                  ? 'none recorded'
                  : diag.migrations.map((m) => (
                      <span key={m.version} style={{ display: 'block' }}>
                        <span className={s.mono}>v{m.version}</span> <span className={s.muted}>applied {formatDateTime(m.appliedAt)}</span>
                      </span>
                    ))}
              </span>
            </dd>
          </dl>
        )}
        <div className={s.inlineButtons}>
          <Button variant="outline" onClick={() => void window.minutes.settings.openLogsFolder().catch((err: Error) => toast(`Could not open logs folder: ${err.message}`, { kind: 'error' }))}>
            Open logs folder
          </Button>
          <Button variant="outline" onClick={() => void exportDiagnostics()} disabled={busy !== null}>
            {busy === 'export' ? 'Exporting…' : 'Export diagnostics…'}
          </Button>
        </div>
      </Group>
      <Group title="Reset">
        <div className={s.help}>Puts every preference in this dialog back to its default. Notes, transcripts and recordings are not touched.</div>
        <div className={s.inlineButtons}>
          <Button variant="outline" className={s.danger} onClick={() => void resetPreferences()} disabled={busy !== null}>
            {busy === 'reset' ? 'Resetting…' : 'Reset preferences'}
          </Button>
        </div>
      </Group>
    </Section>
  )
}
