import { useEffect, useState, type ReactNode } from 'react'
import { Check, Download, RefreshCw, Trash2, X } from 'lucide-react'
import type { ModelFamily, ModelState, StorageUsage } from '@shared/transcription-types'
import { ACCURACY_WORDS, COMMON_FAMILIES, FAMILY_LABELS, LARGE_FAMILIES, SPEED_WORDS } from '@shared/model-labels'
import { Button, IconButton, Select, Tooltip } from '../../ui'
import { toast, updateTranscription } from '@renderer/state/actions'
import { formatBytes } from '@renderer/lib/format'
import s from '../settings.module.css'
import t from './transcription.module.css'

export function ModelManager({ models, inUseId, modelsError }: { models: ModelState[] | null; inUseId: string | null; modelsError: string | null }): JSX.Element {
  const [storage, setStorage] = useState<StorageUsage | null>(null)
  const [storageError, setStorageError] = useState<string | null>(null)
  const [importId, setImportId] = useState('')
  const [importing, setImporting] = useState(false)

  // Storage figures follow installs/removals; the list prop already does, so re-read on each change.
  const installedCount = models?.filter((m) => m.state === 'installed').length ?? 0
  useEffect(() => {
    let cancelled = false
    window.minutes.models
      .storage()
      .then((u) => {
        if (!cancelled) {
          setStorage(u)
          setStorageError(null)
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setStorageError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [installedCount])

  const run = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      toast(`${label} failed: ${(err as Error).message}`, { kind: 'error', durationMs: 8000 })
    }
  }

  const remove = async (m: ModelState): Promise<void> => {
    const ok = await window.minutes.app.confirm({
      title: 'Remove model',
      message: `Remove ${m.name} from this computer?`,
      detail: `${formatBytes(m.installedBytes ?? m.sizeBytes)} will be freed. It can be downloaded again later.`,
      confirmLabel: 'Remove',
      destructive: true
    })
    if (!ok) return
    await run('Removing the model', () => window.minutes.models.remove(m.id))
  }

  const importFile = async (): Promise<void> => {
    if (!importId) return
    setImporting(true)
    try {
      const res = await window.minutes.models.importFile(importId)
      if (res) toast(res.state === 'installed' ? `${res.name} imported and verified` : `${res.name}: ${res.error ?? res.state}`, { kind: res.state === 'installed' ? 'success' : 'error' })
    } catch (err) {
      toast(`Import failed: ${(err as Error).message}`, { kind: 'error', durationMs: 8000 })
    } finally {
      setImporting(false)
    }
  }

  const grouped = (families: ModelFamily[]): { family: ModelFamily; rows: ModelState[] }[] =>
    families.map((family) => ({ family, rows: (models ?? []).filter((m) => m.family === family) })).filter((g) => g.rows.length > 0)

  const renderRows = (families: ModelFamily[]): ReactNode =>
    grouped(families).map((g) => (
      <tbody key={g.family}>
        <tr className={t.familyRow}>
          <td colSpan={5}>{FAMILY_LABELS[g.family]}</td>
        </tr>
        {g.rows.map((m) => (
          <ModelRow key={m.id} m={m} inUse={m.id === inUseId} onRemove={() => void remove(m)} run={run} />
        ))}
      </tbody>
    ))

  const header = (
    <thead>
      <tr>
        <th style={{ width: '37%' }}>Model</th>
        <th style={{ width: '11%' }}>Size</th>
        <th style={{ width: '13%' }}>Memory</th>
        <th style={{ width: '15%' }} title="Whether the model fits the current memory budget and suits live use">
          Fit
        </th>
        <th>Status</th>
      </tr>
    </thead>
  )

  return (
    <>
      {modelsError && <div className={t.inlineError}>Could not load the model list: {modelsError}</div>}
      {models && models.length === 0 && !modelsError && <div className={t.empty}>The model catalog is empty.</div>}
      {models && models.length > 0 && (
        <>
          <table className={t.modelTable}>
            {header}
            {renderRows(COMMON_FAMILIES)}
          </table>
          <details className={s.details}>
            <summary>Show larger models (not recommended for office PCs)</summary>
            <table className={t.modelTable} style={{ marginTop: 4 }}>
              {header}
              {renderRows(LARGE_FAMILIES)}
            </table>
          </details>
        </>
      )}
      <div className={t.tableFooter}>
        <span className={t.storageText}>
          {storage
            ? `${storage.installedCount} ${storage.installedCount === 1 ? 'model' : 'models'} installed · ${formatBytes(storage.modelsBytes)}${storage.tempBytes > 0 ? ` (+ ${formatBytes(storage.tempBytes)} partial downloads)` : ''} · ${storage.modelsPath}`
            : storageError
              ? `Storage: ${storageError}`
              : 'Reading storage…'}
        </span>
        <Button size="sm" variant="outline" onClick={() => void run('Opening the folder', () => window.minutes.models.openFolder())}>
          Open folder
        </Button>
      </div>
      <div className={t.importRow}>
        <Select aria-label="Model file to import" value={importId} onChange={(e) => setImportId(e.target.value)}>
          <option value="">Model the file contains…</option>
          {(models ?? []).map((m) => (
            <option key={m.id} value={m.id} disabled={m.state === 'installed' || m.state === 'downloading' || m.state === 'verifying'}>
              {m.name} — {m.fileName}
            </option>
          ))}
        </Select>
        <Button size="sm" variant="outline" disabled={!importId || importing} onClick={() => void importFile()}>
          {importing ? 'Importing…' : 'Import model file…'}
        </Button>
      </div>
      <div className={t.note}>
        For offline deployment, copy the ggml file from another computer and import it here; it is verified the same way. Models are downloaded from huggingface.co/ggerganov/whisper.cpp
        (MIT) and checked against SHA-256 digests pinned in the app before use. A download is needed once per model; nothing else in Minutes ever uses the network for
        transcription.
      </div>
    </>
  )
}

/** Whole megabytes below 1 GB; the table columns are narrow and a decimal adds nothing here. */
function compactBytes(n: number): string {
  if (n < 1024 * 1024 * 1024) return `${Math.round(n / 1024 / 1024)} MB`
  return formatBytes(n)
}

function ModelRow({ m, inUse, onRemove, run }: { m: ModelState; inUse: boolean; onRemove: () => void; run: (label: string, fn: () => Promise<unknown>) => Promise<void> }): JSX.Element {
  const meta = [m.english_only ? 'English only' : 'Multilingual', SPEED_WORDS[m.speedClass] ?? m.speedClass, `${(ACCURACY_WORDS[m.accuracyClass] ?? m.accuracyClass).toLowerCase()} accuracy`].join(' · ')
  const dl = m.download
  const pct = dl && dl.totalBytes > 0 ? Math.min(100, Math.round((dl.receivedBytes / dl.totalBytes) * 100)) : 0

  let fit: ReactNode
  if (m.eligibility.eligible) {
    fit = (
      <>
        <span className={t.fit} data-kind="ok">
          Fits
        </span>
        {!m.liveCapable && <div className={t.fitDetail} title="Too slow for live use on a CPU; background jobs only">Not for live</div>}
      </>
    )
  } else {
    fit = (
      <>
        <span className={t.fit} data-kind="warn" title={m.eligibility.reasons.join('\n')}>
          Too large
        </span>
        <div className={t.fitDetail}>
          needs {formatBytes(m.eligibility.requiredBytes)}, budget {formatBytes(m.eligibility.budgetBytes)}
        </div>
        {!m.liveCapable && <div className={t.fitDetail} title="Too slow for live use on a CPU; background jobs only">Not for live</div>}
      </>
    )
  }

  let status: ReactNode
  switch (m.state) {
    case 'not-installed':
      status = (
        <div className={t.statusLine}>
          <span className={t.statusText}>Not installed</span>
          <span className={t.statusActions}>
            <Button size="sm" variant="outline" onClick={() => void run('Download', () => window.minutes.models.download(m.id))}>
              <Download size={13} /> Download
            </Button>
          </span>
        </div>
      )
      break
    case 'downloading':
      status = (
        <>
          <div className={t.statusLine}>
            <span className={t.statusText}>
              Downloading {pct}%{dl && dl.bytesPerSecond > 0 ? ` · ${formatBytes(dl.bytesPerSecond)}/s` : ''}
            </span>
            <span className={t.statusActions}>
              <IconButton label="Cancel download" size="sm" onClick={() => void run('Cancel', () => window.minutes.models.cancel(m.id))}>
                <X size={13} />
              </IconButton>
            </span>
          </div>
          <div className={t.progress} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className={t.progressBar} style={{ width: `${pct}%` }} />
          </div>
        </>
      )
      break
    case 'verifying':
      status = (
        <div className={t.statusLine}>
          <span className={t.statusText}>Verifying checksum…</span>
        </div>
      )
      break
    case 'installed':
      status = (
        <div className={t.statusLine}>
          <span className={t.statusText} data-kind="ok">
            <Check size={12} style={{ verticalAlign: -2 }} /> Installed{inUse ? ' · in use' : ''}
          </span>
          <span className={t.statusActions}>
            {!inUse && (
              <Button size="sm" variant="outline" onClick={() => void updateTranscription({ profile: 'custom', modelId: m.id })}>
                Use this model
              </Button>
            )}
            {inUse ? (
              <Tooltip label="This model is in use; pick another model or profile first">
                <span className={t.disabledWrap}>
                  <IconButton label="Remove" size="sm" disabled>
                    <Trash2 size={13} />
                  </IconButton>
                </span>
              </Tooltip>
            ) : (
              <IconButton label="Remove" size="sm" onClick={onRemove}>
                <Trash2 size={13} />
              </IconButton>
            )}
          </span>
        </div>
      )
      break
    case 'error':
      status = (
        <div className={t.statusLine}>
          <span className={[t.statusText, s.selectable].join(' ')} data-kind="error">
            Error: {m.error ?? 'unknown'}
          </span>
          <span className={t.statusActions}>
            <Button size="sm" variant="outline" onClick={() => void run('Retry', () => window.minutes.models.download(m.id))}>
              <RefreshCw size={13} /> Retry
            </Button>
          </span>
        </div>
      )
      break
    case 'corrupt':
      status = (
        <div className={t.statusLine}>
          <span className={t.statusText} data-kind="warn" title={m.error ?? undefined}>
            Corrupt file
          </span>
          <span className={t.statusActions}>
            <Button size="sm" variant="outline" onClick={() => void run('Re-download', () => window.minutes.models.download(m.id))}>
              <RefreshCw size={13} /> Re-download
            </Button>
          </span>
        </div>
      )
      break
  }

  return (
    <tr>
      <td>
        <div className={t.modelName} title={m.id}>
          {m.name}
        </div>
        <div className={t.modelMeta} title={meta}>
          {meta}
        </div>
      </td>
      <td className={t.num}>{compactBytes(m.sizeBytes)}</td>
      <td className={t.num}>
        ≈ {compactBytes(m.runtimeMemoryBytes)}
        {!m.memoryMeasured && (
          <div className={t.est} title="Estimated from the model file size; measured figures replace it after benchmarking">
            est.
          </div>
        )}
      </td>
      <td>{fit}</td>
      <td>
        <div className={t.statusCell}>{status}</div>
      </td>
    </tr>
  )
}
