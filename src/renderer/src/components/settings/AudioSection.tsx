import { useCallback, useEffect, useState } from 'react'
import { Button, Select, Switch } from '../ui'
import { useApp } from '@renderer/state/app-store'
import { updateSettings } from '@renderer/state/actions'
import { AudioCapture } from '@renderer/lib/audio-capture'
import type { AudioDevice, StorageInfo } from '@shared/types'
import s from './settings.module.css'
import { Group, Path, Row, Section } from './SettingsRow'

const SILENCE_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'Off' },
  { value: 5, label: '5 minutes' },
  { value: 10, label: '10 minutes' },
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 60, label: '60 minutes' }
]

export function AudioSection(): JSX.Element {
  const audio = useApp((st) => st.settings.audio)
  const [devices, setDevices] = useState<AudioDevice[] | null>(null)
  const [deviceError, setDeviceError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [storage, setStorage] = useState<StorageInfo | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setDeviceError(null)
    try {
      setDevices(await AudioCapture.listInputs())
    } catch (err) {
      setDevices([])
      setDeviceError((err as Error).message || 'Could not list microphones.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    void window.minutes.backup.storageInfo().then(setStorage).catch(() => setStorage(null))
  }, [refresh])

  const inputs = (devices ?? []).filter((d) => d.kind === 'audioinput')
  const selectedMissing = audio.micDeviceId !== null && devices !== null && !inputs.some((d) => d.deviceId === audio.micDeviceId)

  return (
    <Section title="Audio">
      <Group title="Input">
        <Row
          label="Microphone"
          help={
            deviceError ? (
              <span className={s.danger}>{deviceError}</span>
            ) : devices !== null && inputs.length === 0 ? (
              'No microphone was found. Connect one, allow microphone access in Windows privacy settings, then Refresh.'
            ) : selectedMissing ? (
              <span className={s.warning}>The saved microphone is not connected. System default will be used until it returns.</span>
            ) : (
              'System default follows the input device chosen in Windows sound settings.'
            )
          }
        >
          <Select aria-label="Microphone" value={audio.micDeviceId ?? ''} disabled={devices === null} onChange={(e) => void updateSettings({ audio: { ...audio, micDeviceId: e.target.value || null } })}>
            <option value="">System default</option>
            {selectedMissing && audio.micDeviceId && <option value={audio.micDeviceId}>Saved device (not connected)</option>}
            {inputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || 'Microphone'}
              </option>
            ))}
          </Select>
          <Button variant="outline" onClick={() => void refresh()} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </Row>
        <Row
          label="Capture system audio (other participants)"
          help={
            <>
              On Windows 10 1903 and later this records what you hear through the default output device (WASAPI loopback), so remote participants are captured as a
              separate channel. Applications that use exclusive-mode audio cannot be captured.
            </>
          }
        >
          <Switch label="Capture system audio" checked={audio.captureSystemAudio} onChange={(v) => void updateSettings({ audio: { ...audio, captureSystemAudio: v } })} />
        </Row>
      </Group>
      <Group title="Recordings">
        <Row
          label="Keep audio recordings"
          help={
            <>
              Saves the audio as 16 kHz mono WAV, one file per channel, roughly 115 MB per hour per channel. Files stay on this computer and are never uploaded.
              {storage && (
                <>
                  <br />
                  Folder: <Path value={storage.recordingsPath} />
                </>
              )}
              <br />
              When off, only short temporary chunks are written for the recognizer, in a temp folder that is removed when the recording ends.
            </>
          }
        >
          <Switch label="Keep audio recordings" checked={audio.keepRecordings} onChange={(v) => void updateSettings({ audio: { ...audio, keepRecordings: v } })} />
        </Row>
        <Row label="Auto-stop after silence" help="Ends the recording when neither channel has had sound for this long, so a forgotten recording does not run all day.">
          <Select aria-label="Auto-stop after silence" value={audio.autoStopSilenceMin} onChange={(e) => void updateSettings({ audio: { ...audio, autoStopSilenceMin: Number(e.target.value) } })}>
            {SILENCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Row>
      </Group>
    </Section>
  )
}
