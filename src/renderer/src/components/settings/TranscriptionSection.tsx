import { useEffect, useState } from 'react'
import type { EngineKind } from '@shared/transcription-types'
import { LANGUAGE_OPTIONS } from '@shared/model-labels'
import { Select, Switch } from '../ui'
import { useApp } from '@renderer/state/app-store'
import { updateTranscription } from '@renderer/state/actions'
import { useJobs, useModels, useTranscriptionOverview } from '@renderer/state/use-transcription'
import s from './settings.module.css'
import ui from '../ui.module.css'
import t from './transcription/transcription.module.css'
import { Group, Para, Row, Section } from './SettingsRow'
import { EngineStatusBlock, HardwareBlock, PlanBlock } from './transcription/StatusBlocks'
import { ProfilePicker } from './transcription/ProfilePicker'
import { ModelManager } from './transcription/ModelManager'
import { JobsList } from './transcription/JobsList'
import { WindowsSpeechStatus } from './transcription/WindowsSpeechStatus'

export function TranscriptionSection(): JSX.Element {
  const config = useApp((st) => st.settings.transcription)
  const sapi = useApp((st) => st.engineInfo)
  const { overview, error: overviewError, refresh } = useTranscriptionOverview()
  const { models, error: modelsError } = useModels()
  const { jobs, loaded: jobsLoaded } = useJobs()
  const [vocab, setVocab] = useState(config.customVocabulary.join('\n'))

  // Keep the textarea in sync if the setting changes elsewhere while it is not being edited.
  useEffect(() => {
    setVocab(config.customVocabulary.join('\n'))
  }, [config.customVocabulary])

  const saveVocabulary = (): void => {
    const terms = Array.from(new Set(vocab.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)))
    const same = terms.length === config.customVocabulary.length && terms.every((x, i) => x === config.customVocabulary[i])
    if (same) return
    void updateTranscription({ customVocabulary: terms })
  }

  const whisper = config.engine === 'whisper'
  const installed = models?.filter((m) => m.state === 'installed') ?? []
  const languageOptions = config.engine === 'windows-sapi' ? (sapi?.languages ?? []).map((code) => ({ code, label: code })) : LANGUAGE_OPTIONS
  const savedLanguageMissing = config.language !== null && !languageOptions.some((o) => o.code === config.language)
  const englishOnlyInUse = whisper && overview?.plan.modelId ? overview.plan.modelId.includes('.en') : false
  const inUseId = overview?.plan.modelId ?? (config.profile === 'custom' ? config.modelId : null)

  return (
    <Section
      title="Transcription"
      intro="Speech is turned into text on this computer by an open-source neural speech model (whisper.cpp) running on the CPU. Nothing is uploaded. Suggestions and search stay rule-based."
    >
      <Group title="Engine">
        <Row label="Transcribe recordings" help="Produces a transcript while recording, or afterwards in the background when the computer cannot keep up live.">
          <Switch label="Transcribe recordings" checked={config.enabled} onChange={(v) => void updateTranscription({ enabled: v })} />
        </Row>
        <Row
          label="Engine"
          help={
            whisper
              ? 'Whisper needs a one-time model download (30–200 MB for the recommended sizes) and a few hundred MB of memory while running.'
              : config.engine === 'windows-sapi'
                ? 'The recognizer built into Windows. No download, basic accuracy, English and other installed language packs only.'
                : 'Recordings are kept as audio only (when “Keep audio files” is on) and can be transcribed later from the Transcript panel once an engine is chosen.'
          }
        >
          <Select aria-label="Transcription engine" value={config.engine} disabled={!config.enabled} onChange={(e) => void updateTranscription({ engine: e.target.value as EngineKind })}>
            <option value="whisper">Whisper (local model, recommended)</option>
            <option value="windows-sapi">Windows Speech (conventional)</option>
            <option value="none">Off</option>
          </Select>
        </Row>
        {config.engine === 'windows-sapi' && <WindowsSpeechStatus />}
      </Group>

      {overviewError && <div className={t.inlineError}>Could not read the transcription status: {overviewError}</div>}

      {whisper && overview && (
        <>
          <Group>
            <HardwareBlock hardware={overview.hardware} onRechecked={refresh} />
          </Group>

          <Group title="Profile">
            <ProfilePicker config={config} profiles={overview.profiles} recommended={overview.recommendedProfile} hardware={overview.hardware} models={models ?? []} />
            <Row label="Allow fallback to a smaller model" help="When the chosen model does not fit in memory, use the largest installed model that does instead of giving up.">
              <Switch label="Allow fallback to a smaller model" checked={config.allowFallback} onChange={(v) => void updateTranscription({ allowFallback: v })} />
            </Row>
            <Row
              label="Transcribe saved recordings after the meeting when live transcription was not possible"
              help="Queues a background job over the saved audio when the live engine was unavailable or fell behind. Needs “Keep audio files” (Audio)."
            >
              <Switch label="Transcribe saved recordings after the meeting" checked={config.backgroundAfterMeeting} onChange={(v) => void updateTranscription({ backgroundAfterMeeting: v })} />
            </Row>
          </Group>
        </>
      )}

      {config.engine !== 'none' && (
        <Group title="Speech">
          <Row
            label="Language"
            help={
              savedLanguageMissing ? (
                <span className={s.warning}>The saved language ({config.language}) is not in this list; it is still sent to the engine as-is.</span>
              ) : whisper ? (
                englishOnlyInUse ? (
                  <>
                    Models whose name ends in <span className={s.mono}>.en</span> transcribe English only; the model in use is one of them. Pick a multilingual model for other languages.
                  </>
                ) : (
                  'Automatic lets the model detect the language. Models whose name ends in .en transcribe English only.'
                )
              ) : (
                'Automatic uses the first installed Windows speech pack. Only installed packs are listed.'
              )
            }
          >
            <Select aria-label="Transcription language" value={config.language ?? ''} onChange={(e) => void updateTranscription({ language: e.target.value || null })}>
              <option value="">Automatic</option>
              {savedLanguageMissing && config.language && <option value={config.language}>{config.language} (not listed)</option>}
              {languageOptions.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Row>
          <Row label="Custom vocabulary" help="Names and jargon the engine should prefer (e.g. company or client names). One term per line. Saved when you leave the field." stacked>
            <textarea
              className={[ui.input, s.textarea, 'selectable'].join(' ')}
              aria-label="Custom vocabulary"
              value={vocab}
              spellCheck={false}
              placeholder={'Dexterity\nPetroka'}
              onChange={(e) => setVocab(e.target.value)}
              onBlur={saveVocabulary}
            />
          </Row>
        </Group>
      )}

      {whisper && overview && (
        <>
          <Group title="Current plan">
            <PlanBlock plan={overview.plan} enabled={config.enabled} />
          </Group>
          <Group title="Engine status">
            <EngineStatusBlock status={overview.engine} />
          </Group>
          <Group title="Models">
            <ModelManager models={models} inUseId={inUseId} modelsError={modelsError} />
          </Group>
        </>
      )}

      {whisper && !overview && !overviewError && (
        <Group>
          <div className={t.empty}>Reading hardware and model status…</div>
        </Group>
      )}

      <Group title="Background jobs">
        <JobsList jobs={jobs} loaded={jobsLoaded} />
      </Group>

      <Group title="What to expect">
        <Para>
          Whisper gives a readable transcript with punctuation in most quiet-room meetings; expect a draft to tidy up, not a verbatim record. It cannot tell speakers apart beyond
          the microphone and system-audio channels, and live text appears about one chunk (10–12 s) behind speech. {installed.length === 0 && whisper ? 'Download a model above to get started. ' : ''}
          If the computer cannot keep up during a meeting, the saved recording is transcribed afterwards when “Keep audio files” is on.
        </Para>
        <Para>
          Audio never leaves this computer: the model runs in a local worker process, CPU-only. Suggestions and search remain rule-based. If this is not good enough, import a
          transcript (SRT, VTT or TXT) made elsewhere.
        </Para>
      </Group>
    </Section>
  )
}
