import type { HardwareInfo, ModelState, ProfileDefinition, ProfileId } from '@shared/transcription-types'
import type { TranscriptionSettings } from '@shared/types'
import { Button, Select } from '../../ui'
import { updateTranscription } from '@renderer/state/actions'
import s from '../settings.module.css'
import t from './transcription.module.css'
import { Row } from '../SettingsRow'

const ORDER: ProfileId[] = ['lightweight', 'balanced', 'high-accuracy', 'custom']

export function ProfilePicker({
  config,
  profiles,
  recommended,
  hardware,
  models
}: {
  config: TranscriptionSettings
  profiles: ProfileDefinition[]
  recommended: ProfileId
  hardware: HardwareInfo
  models: ModelState[]
}): JSX.Element {
  const byId = new Map(profiles.map((p) => [p.id, p]))
  const ordered = ORDER.map((id) => byId.get(id)).filter((p): p is ProfileDefinition => !!p)
  const installed = models.filter((m) => m.state === 'installed')
  const maxThreads = Math.max(1, hardware.logicalCores - 1)
  const threadOptions = Array.from({ length: maxThreads }, (_, i) => i + 1)
  const pinnedMissing = config.modelId !== null && !installed.some((m) => m.id === config.modelId)

  return (
    <>
      <div className={t.recommend}>
        <span>
          Recommended for this computer: <strong>{byId.get(recommended)?.name ?? recommended}</strong>
        </span>
        {config.profile !== recommended && (
          <Button size="sm" variant="outline" onClick={() => void updateTranscription({ profile: recommended })}>
            Use recommended
          </Button>
        )}
      </div>
      <div className={t.profiles} role="radiogroup" aria-label="Transcription profile">
        {ordered.map((p) => (
          <label key={p.id} className={t.profile}>
            <input type="radio" name="transcription-profile" value={p.id} checked={config.profile === p.id} onChange={() => void updateTranscription({ profile: p.id })} />
            <span className={t.profileText}>
              <span className={t.profileName}>
                {p.name}
                {p.id === recommended && <span className={t.tag}>Recommended</span>}
              </span>
              <span className={t.profileDesc}>{p.description}</span>
            </span>
          </label>
        ))}
      </div>
      {config.profile === 'custom' && (
        <div className={t.customFields}>
          <Row
            label="Model"
            help={
              installed.length === 0 ? (
                <span className={s.warning}>No model is installed yet. Download one in the Models list below.</span>
              ) : pinnedMissing ? (
                <span className={s.warning}>The pinned model ({config.modelId}) is not installed. Pick an installed one.</span>
              ) : (
                'Only installed models are listed. The memory check still applies.'
              )
            }
          >
            <Select aria-label="Model" value={config.modelId ?? ''} onChange={(e) => void updateTranscription({ modelId: e.target.value || null })}>
              <option value="">{installed.length === 0 ? 'No models installed' : 'Choose a model…'}</option>
              {pinnedMissing && config.modelId && <option value={config.modelId}>{config.modelId} (not installed)</option>}
              {installed.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Row>
          <Row label="Threads" help={`Worker threads for the model. This CPU has ${hardware.logicalCores} logical cores; one is always left for the rest of the system.`}>
            <Select aria-label="Threads" value={config.threads ?? ''} onChange={(e) => void updateTranscription({ threads: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Automatic</option>
              {threadOptions.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Row>
        </div>
      )}
    </>
  )
}
