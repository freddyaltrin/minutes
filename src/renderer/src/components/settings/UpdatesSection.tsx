import { useEffect, useState } from 'react'
import { Button, Switch } from '../ui'
import { store, useApp } from '@renderer/state/app-store'
import { toast, updateSettings } from '@renderer/state/actions'
import { formatBytes, formatDateTime } from '@renderer/lib/format'
import type { UpdateState } from '@shared/types'
import s from './settings.module.css'
import { Group, Row, Section } from './SettingsRow'

function statusText(u: UpdateState): string {
  switch (u.status) {
    case 'idle':
      return 'Not checked yet.'
    case 'checking':
      return 'Checking GitHub Releases…'
    case 'available':
      return `Version ${u.availableVersion} is available.`
    case 'not-available':
      return 'You are on the latest version.'
    case 'downloading':
      return 'Downloading…'
    case 'downloaded':
      return `Version ${u.availableVersion} is downloaded and ready to install.`
    case 'error':
      return 'The last check did not complete.'
    case 'disabled':
      return 'Automatic updates are not available for this build.'
  }
}

export function UpdatesSection(): JSX.Element {
  const update = useApp((st) => st.update)
  const updates = useApp((st) => st.settings.updates)
  const [version, setVersion] = useState<string | null>(null)
  const [busy, setBusy] = useState<'check' | 'download' | 'install' | null>(null)

  useEffect(() => {
    void window.minutes.app.version().then(setVersion).catch(() => setVersion(null))
    if (!store.get().update) void window.minutes.updates.getState().then((u) => store.set({ update: u }))
  }, [])

  const run = async (kind: 'check' | 'download' | 'install'): Promise<void> => {
    setBusy(kind)
    try {
      if (kind === 'check') store.set({ update: await window.minutes.updates.check() })
      else if (kind === 'download') store.set({ update: await window.minutes.updates.download() })
      else await window.minutes.updates.install()
    } catch (err) {
      toast(`Update ${kind} failed: ${(err as Error).message}`, { kind: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const disabled = update?.status === 'disabled'
  const inFlight = update?.status === 'checking' || update?.status === 'downloading' || busy !== null
  const lastChecked = update?.checkedAt ?? updates.lastCheckedAt

  return (
    <Section title="Updates">
      <Group title="This installation">
        <Row label="Current version" help="Minutes checks GitHub Releases over HTTPS and verifies the SHA-512 digest of every installer before it is run. Nothing is downloaded until you press Download.">
          <span className={[s.mono, s.selectable].join(' ')}>{version ?? update?.currentVersion ?? '…'}</span>
        </Row>
        <Row label="Check automatically" help="Checks about 30 seconds after launch and every 6 hours while running. Updates are never installed without asking.">
          <Switch label="Check for updates automatically" checked={updates.checkAutomatically} disabled={disabled} onChange={(v) => void updateSettings({ updates: { ...updates, checkAutomatically: v } })} />
        </Row>
      </Group>
      <Group title="Status">
        {update === null ? (
          <div className={s.help}>Reading update state…</div>
        ) : (
          <>
            <div className={s.row}>
              <div className={s.rowText}>
                <div className={s.rowLabel}>{statusText(update)}</div>
                {update.status === 'disabled' && update.error && <div className={s.help}>{update.error}</div>}
                {update.status === 'error' && update.error && <div className={[s.help, s.danger, s.selectable].join(' ')}>{update.error}</div>}
                {lastChecked && <div className={[s.help, s.muted].join(' ')}>Last checked {formatDateTime(lastChecked)}</div>}
                {(update.status === 'available' || update.status === 'downloading' || update.status === 'downloaded') && update.releaseDate && (
                  <div className={s.help}>Released {formatDateTime(new Date(update.releaseDate).getTime())}</div>
                )}
                {update.status === 'downloading' && update.progress && (
                  <>
                    <div className={s.progress} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(update.progress.percent)}>
                      <div className={s.progressBar} style={{ width: `${Math.max(0, Math.min(100, update.progress.percent))}%` }} />
                    </div>
                    <div className={[s.help, s.muted].join(' ')}>
                      {Math.round(update.progress.percent)}% · {formatBytes(update.progress.transferred)} of {formatBytes(update.progress.total)}
                      {update.progress.bytesPerSecond > 0 ? ` · ${formatBytes(update.progress.bytesPerSecond)}/s` : ''}
                    </div>
                  </>
                )}
              </div>
              {!disabled && (
                <div className={s.rowControl}>
                  {update.status === 'available' && (
                    <Button variant="primary" onClick={() => void run('download')} disabled={inFlight}>
                      Download
                    </Button>
                  )}
                  {update.status === 'downloaded' && (
                    <Button variant="primary" onClick={() => void run('install')} disabled={busy !== null}>
                      Restart and install
                    </Button>
                  )}
                  {update.status !== 'downloading' && update.status !== 'downloaded' && (
                    <Button variant="outline" onClick={() => void run('check')} disabled={inFlight}>
                      {update.status === 'checking' ? 'Checking…' : 'Check now'}
                    </Button>
                  )}
                </div>
              )}
            </div>
            {(update.status === 'available' || update.status === 'downloading' || update.status === 'downloaded') && (
              <div className={s.row} data-stacked="true">
                <div className={s.rowLabel}>Release notes</div>
                {update.releaseNotes ? <pre className={s.releaseNotes}>{update.releaseNotes}</pre> : <div className={s.help}>No release notes were published for this version.</div>}
              </div>
            )}
            {update.status === 'downloaded' && <div className={s.help}>If you do not restart now, the update installs the next time Minutes quits. Your notes and settings are not touched.</div>}
          </>
        )}
      </Group>
    </Section>
  )
}
