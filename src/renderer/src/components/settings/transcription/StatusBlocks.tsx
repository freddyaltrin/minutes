import { useState } from 'react'
import type { EngineStatus, HardwareInfo, ResourcePlan } from '@shared/transcription-types'
import { modelLabel } from '@shared/model-labels'
import { Button } from '../../ui'
import { toast } from '@renderer/state/actions'
import { formatBytes, formatDateTime } from '@renderer/lib/format'
import s from '../settings.module.css'
import t from './transcription.module.css'

// ---------- hardware ----------

export function HardwareBlock({ hardware, onRechecked }: { hardware: HardwareInfo; onRechecked: () => Promise<void> }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const recheck = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.minutes.transcription.hardware(true)
      await onRechecked()
    } catch (err) {
      toast(`Could not read the hardware details: ${(err as Error).message}`, { kind: 'error' })
    } finally {
      setBusy(false)
    }
  }
  const avail = hardware.availableMemoryBytes ?? hardware.freeMemoryBytes
  return (
    <>
      <div className={t.groupHeader}>
        <h3 className={s.groupTitle} style={{ margin: 0 }}>
          This computer
        </h3>
        <Button size="sm" variant="outline" onClick={() => void recheck()} disabled={busy}>
          {busy ? 'Checking…' : 'Recheck'}
        </Button>
      </div>
      <dl className={s.dl}>
        <dt>CPU</dt>
        <dd>
          <span className={s.selectable}>{hardware.cpuModel || 'Unknown'}</span>
        </dd>
        <dt>Cores</dt>
        <dd>
          <span>
            {hardware.logicalCores} logical{hardware.physicalCores !== null ? ` · ${hardware.physicalCores} physical (estimate)` : ''}
          </span>
        </dd>
        <dt>Memory</dt>
        <dd>
          <span>
            {formatBytes(hardware.totalMemoryBytes)} total · {formatBytes(avail)} {hardware.availableMemoryBytes !== null ? 'available' : 'free'}
          </span>
        </dd>
        <dt>Instruction sets</dt>
        <dd>
          <span className={hardware.features.length === 0 ? s.muted : s.selectable}>
            {hardware.features.length > 0
              ? hardware.features.join(', ') + (hardware.featuresReliable ? '' : ' (unconfirmed)')
              : 'Not detected — the runtime reports the CPU variant after the first use'}
          </span>
        </dd>
        <dt>Checked</dt>
        <dd>
          <span className={s.muted}>{formatDateTime(hardware.checkedAt)}</span>
        </dd>
      </dl>
    </>
  )
}

// ---------- plan ----------

export function PlanBlock({ plan, enabled }: { plan: ResourcePlan; enabled: boolean }): JSX.Element {
  const over = plan.modelId !== null && plan.requiredBytes > plan.budgetBytes
  let title: string
  let kind: 'ok' | 'warn' = 'ok'
  if (!enabled || plan.engine === 'none') {
    title = 'Transcription is off'
    kind = 'warn'
  } else if (plan.engine === 'windows-sapi') {
    title = 'Will use the Windows speech recognizer (no model needed)'
  } else if (plan.modelId) {
    title = `Will use ${modelLabel(plan.modelId)} with ${plan.threads} ${plan.threads === 1 ? 'thread' : 'threads'}`
  } else {
    title = 'No eligible model installed'
    kind = 'warn'
  }
  return (
    <>
      <div className={t.planTitle} data-kind={kind}>
        {title}
      </div>
      {plan.rationale.length > 0 && (
        <ul className={t.rationale}>
          {plan.rationale.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
      {plan.engine === 'whisper' && (
        <div className={t.memoryLine} data-over={over ? 'true' : undefined}>
          {plan.modelId ? `Needs ≈ ${formatBytes(plan.requiredBytes)} of a budget of ${formatBytes(plan.budgetBytes)}` : `Memory budget ${formatBytes(plan.budgetBytes)}`} (available memory minus the
          profile's safety margin)
        </div>
      )}
      <div className={[s.help, s.muted].join(' ')}>Planned {formatDateTime(plan.plannedAt)}</div>
    </>
  )
}

// ---------- engine status ----------

export function EngineStatusBlock({ status }: { status: EngineStatus }): JSX.Element {
  // The runtime reports "whisper.cpp 1.9.1 (ggml …) — <build flags>"; keep the version on the line and fold the rest into the detail.
  const raw = status.runtimeVersion ?? ''
  const dash = raw.indexOf(' — ')
  const version = dash > 0 ? raw.slice(0, dash) : raw
  const detail = [dash > 0 ? raw.slice(dash + 3) : '', status.runtimeDetail].filter(Boolean).join(' · ')
  return (
    <dl className={s.dl}>
      <dt>Runtime</dt>
      <dd>
        <span>
          <span className={status.runtimeAvailable ? undefined : s.warning}>
            {status.runtimeAvailable ? (version ? (version.startsWith('whisper') ? version : `whisper.cpp ${version}`) : 'whisper.cpp') : 'Not available'}
          </span>
          {detail && (
            <div className={t.runtimeDetail} title={detail}>
              {detail}
            </div>
          )}
        </span>
      </dd>
      <dt>Loaded model</dt>
      <dd>
        <span className={status.loadedModelId ? undefined : s.muted}>
          {status.loadedModelId ? modelLabel(status.loadedModelId) : 'None'}
          {status.loadedModelId && status.loadTimeMs !== null && <span className={s.muted}> · loaded in {(status.loadTimeMs / 1000).toFixed(1)} s</span>}
        </span>
      </dd>
      <dt>Worker process</dt>
      <dd>
        <span className={status.processAlive ? undefined : s.muted}>
          {status.processAlive ? 'Running' : 'Not running'}
          {status.processAlive && status.workerMemoryBytes !== null && <span className={s.muted}> · {formatBytes(status.workerMemoryBytes)} resident</span>}
          {status.cpuVariant && <span className={s.muted}> · CPU backend {status.cpuVariant}</span>}
        </span>
      </dd>
      {status.lastError && (
        <>
          <dt>Last error</dt>
          <dd>
            <span className={[s.danger, s.selectable].join(' ')}>{status.lastError}</span>
          </dd>
        </>
      )}
    </dl>
  )
}
