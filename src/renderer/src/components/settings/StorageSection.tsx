import { useCallback, useEffect, useState } from 'react'
import { Button } from '../ui'
import { toast } from '@renderer/state/actions'
import { formatBytes, formatDateTime } from '@renderer/lib/format'
import type { BackupInfo, StorageInfo } from '@shared/types'
import s from './settings.module.css'
import { Group, Path, Section } from './SettingsRow'

function fail(prefix: string, err: unknown): void {
  toast(`${prefix}: ${(err as Error).message}`, { kind: 'error' })
}

export function StorageSection(): JSX.Element {
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const [backups, setBackups] = useState<BackupInfo[] | null>(null)
  const [busy, setBusy] = useState<'backup' | 'restore' | 'export' | null>(null)

  const load = useCallback(async () => {
    const [i, b] = await Promise.all([window.minutes.backup.storageInfo().catch(() => null), window.minutes.backup.list().catch(() => [])])
    setInfo(i)
    setBackups(b)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const backupNow = async (): Promise<void> => {
    setBusy('backup')
    try {
      const b = await window.minutes.backup.create()
      toast(`Backup saved (${formatBytes(b.sizeBytes)}, ${b.noteCount} notes)`)
      await load()
    } catch (err) {
      fail('Backup failed', err)
    } finally {
      setBusy(null)
    }
  }

  const restore = async (path?: string): Promise<void> => {
    setBusy('restore')
    try {
      const res = await window.minutes.backup.restore(path)
      if (res.error) toast(`Restore failed: ${res.error}`, { kind: 'error', durationMs: 8000 })
      else if (res.restored && res.restartRequired) toast('Restarting…')
      else if (res.restored) toast('Backup restored')
      // Otherwise the user cancelled in the confirmation dialog or file picker.
    } catch (err) {
      fail('Restore failed', err)
    } finally {
      setBusy(null)
    }
  }

  const exportAll = async (): Promise<void> => {
    setBusy('export')
    try {
      const res = await window.minutes.exports.allNotesMarkdown()
      if (res.error) toast(`Export failed: ${res.error}`, { kind: 'error' })
      else if (res.ok && res.path) toast(`Exported to ${res.path}`, { action: { label: 'Open folder', onClick: () => void window.minutes.exports.openExportsFolder() } })
    } catch (err) {
      fail('Export failed', err)
    } finally {
      setBusy(null)
    }
  }

  const open = (fn: () => Promise<void>, what: string): void => {
    fn().catch((err) => fail(`Could not open ${what}`, err))
  }

  return (
    <Section title="Storage & backup">
      <Group title="Where your data lives">
        {info === null ? (
          <div className={s.help}>Reading storage information…</div>
        ) : (
          <dl className={s.dl}>
            <dt>Database</dt>
            <dd>
              <span>
                <Path value={info.databasePath} /> <span className={s.muted}>({formatBytes(info.databaseBytes)})</span>
              </span>
              <Button size="sm" onClick={() => open(() => window.minutes.settings.openDataFolder(), 'the data folder')}>
                Open data folder
              </Button>
            </dd>
            <dt>Contents</dt>
            <dd>
              <span>
                {info.noteCount} {info.noteCount === 1 ? 'note' : 'notes'}, {info.transcriptCount} {info.transcriptCount === 1 ? 'transcript' : 'transcripts'}, {info.recordingCount}{' '}
                {info.recordingCount === 1 ? 'recording' : 'recordings'}
              </span>
            </dd>
            <dt>Recordings</dt>
            <dd>
              <span>
                <Path value={info.recordingsPath} /> <span className={s.muted}>({formatBytes(info.recordingsBytes)})</span>
              </span>
            </dd>
            <dt>Backups</dt>
            <dd>
              <span>
                <Path value={info.backupsPath} />
              </span>
              <Button size="sm" onClick={() => open(() => window.minutes.backup.openBackupsFolder(), 'the backups folder')}>
                Open backups folder
              </Button>
            </dd>
            <dt>Exports</dt>
            <dd>
              <span>
                <Path value={info.exportsPath} />
              </span>
              <Button size="sm" onClick={() => open(() => window.minutes.exports.openExportsFolder(), 'the exports folder')}>
                Open exports folder
              </Button>
            </dd>
          </dl>
        )}
      </Group>
      <Group title="Backups">
        <div className={s.help}>A backup of the database is made automatically once a day when Minutes starts; the last 10 are kept. Recordings are not included in backups.</div>
        <div className={s.inlineButtons}>
          <Button variant="outline" onClick={() => void backupNow()} disabled={busy !== null}>
            {busy === 'backup' ? 'Backing up…' : 'Back up now'}
          </Button>
          <Button variant="outline" onClick={() => void restore()} disabled={busy !== null}>
            Restore from file…
          </Button>
        </div>
        {backups === null ? null : backups.length === 0 ? (
          <div className={[s.help, s.list].join(' ')}>No backups yet.</div>
        ) : (
          <div className={s.list}>
            {backups.map((b) => (
              <div key={b.path} className={s.listRow}>
                <div className={s.listMain}>
                  <div className={s.listTitle}>{formatDateTime(b.createdAt)}</div>
                  <div className={s.listMeta}>
                    {formatBytes(b.sizeBytes)} · {b.noteCount} {b.noteCount === 1 ? 'note' : 'notes'}
                    {b.appVersion ? ` · Minutes ${b.appVersion}` : ''}
                  </div>
                </div>
                <div className={s.listActions}>
                  <Button size="sm" onClick={() => void restore(b.path)} disabled={busy !== null}>
                    Restore…
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Group>
      <Group title="Export">
        <div className={s.help}>Writes every note as a Markdown file, with its transcript when it has one, to a folder you choose.</div>
        <div className={s.inlineButtons}>
          <Button variant="outline" onClick={() => void exportAll()} disabled={busy !== null}>
            {busy === 'export' ? 'Exporting…' : 'Export all notes as Markdown…'}
          </Button>
        </div>
      </Group>
    </Section>
  )
}
