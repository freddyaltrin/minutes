import { useEffect, useState } from 'react'
import type { StorageInfo } from '@shared/types'
import { Group, Para, Path, Section } from './SettingsRow'

export function PrivacySection(): JSX.Element {
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const [dataPath, setDataPath] = useState<string | null>(null)
  useEffect(() => {
    void window.minutes.backup.storageInfo().then(setInfo).catch(() => setInfo(null))
    void window.minutes.settings
      .diagnostics()
      .then((d) => setDataPath(d.userDataPath))
      .catch(() => setDataPath(null))
  }, [])

  return (
    <Section title="Privacy">
      <Group title="What is stored, and where">
        <Para>
          Everything Minutes knows lives on this computer: notes, transcripts, the calendar cache and your settings are in one SQLite database, recordings (when you choose
          to keep them) are WAV files beside it, and backups and the application log sit in sibling folders.
          {info && (
            <ul>
              <li>
                Database: <Path value={info.databasePath} />
              </li>
              <li>
                Recordings: <Path value={info.recordingsPath} />
              </li>
              <li>
                Backups: <Path value={info.backupsPath} />
              </li>
              <li>
                Logs: <Path value={info.logsPath} />
              </li>
            </ul>
          )}
        </Para>
        <Para>
          Nothing is uploaded. There is no account, no sync, no analytics and no telemetry. Crash reports are not sent anywhere; the log file stays on disk for you to read or
          share if you want help.
        </Para>
      </Group>
      <Group title="When the network is used">
        <Para>
          Minutes connects to the internet in exactly three cases, all of which you control: checking GitHub Releases for a new version when <strong>Check automatically</strong>{' '}
          is on or you press Check now (Updates), downloading the iCal feeds you added yourself (Calendar), and downloading a speech model you asked for from
          huggingface.co/ggerganov/whisper.cpp (Transcription), once per model and verified against a pinned checksum. Nothing about your notes or usage is included in those
          requests. With no calendar feeds, automatic checks off and models already installed (or imported from a file), the app makes no network requests at all.
        </Para>
      </Group>
      <Group title="Audio and transcription">
        <Para>
          Audio is captured from the microphone and, if enabled, from the system output. Transcription runs on this computer with an open-source speech model (whisper.cpp);
          nothing is sent to any server. The model is a neural network that runs CPU-only in a local worker process; the optional Windows recognizer (System.Speech) is a
          conventional alternative. No audio, text or metadata leaves the machine. Suggestions and search are rule-based. Temporary audio chunks made for the engine are deleted
          when a recording ends.
        </Para>
      </Group>
      <Group title="Deleting everything">
        <Para>
          Uninstall Minutes from Windows Settings &gt; Apps, then delete the data folder{dataPath ? <> at <Path value={dataPath} /></> : ''}.
          The uninstaller leaves that folder in place on purpose so an accidental uninstall does not destroy your notes; removing it yourself leaves nothing behind.
          Settings &gt; Storage &amp; backup &gt; Open data folder takes you there.
        </Para>
      </Group>
    </Section>
  )
}
