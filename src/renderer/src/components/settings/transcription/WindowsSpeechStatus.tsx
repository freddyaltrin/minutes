import { useState } from 'react'
import { Button } from '../../ui'
import { store, useApp } from '@renderer/state/app-store'
import { toast } from '@renderer/state/actions'
import { formatDateTime } from '@renderer/lib/format'
import s from '../settings.module.css'

/** Probe result for the conventional Windows recognizer (System.Speech), shown only when that engine is selected. */
export function WindowsSpeechStatus(): JSX.Element {
  const engine = useApp((st) => st.engineInfo)
  const [checking, setChecking] = useState(false)
  const languages = engine?.languages ?? []

  const check = async (): Promise<void> => {
    setChecking(true)
    try {
      const info = await window.minutes.transcription.engineInfo(true)
      store.set({ engineInfo: info })
    } catch (err) {
      toast(`Could not check the recognizer: ${(err as Error).message}`, { kind: 'error' })
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className={s.status}>
      <span className={s.dot} data-ok={engine?.available ? 'true' : undefined} aria-hidden />
      <div className={s.statusText}>
        {engine === null ? (
          <>
            <div className={s.statusTitle}>Checking the Windows recognizer…</div>
            <div className={s.help}>The result appears here once the probe finishes.</div>
          </>
        ) : engine.available ? (
          <>
            <div className={s.statusTitle}>{engine.name}</div>
            <div className={s.help}>
              Installed languages: {languages.length > 0 ? languages.join(', ') : 'none reported'}
              {engine.detail && (
                <>
                  <br />
                  <span className={s.selectable}>{engine.detail}</span>
                </>
              )}
            </div>
            <div className={s.help}>
              This is the conventional recognizer that ships with Windows. Expect lower accuracy than the Whisper model, little punctuation and a few seconds of delay; it needs no
              download and very little memory.
            </div>
          </>
        ) : (
          <>
            <div className={s.statusTitle}>Windows recognizer not available</div>
            <div className={[s.statusDetail, s.selectable].join(' ')}>{engine.detail}</div>
            <ol className={s.steps}>
              <li>Install a speech language pack: Settings &gt; Time &amp; Language &gt; Language &amp; region &gt; your language &gt; Language options &gt; Speech recognition.</li>
              <li>Windows PowerShell 5.1 must be present and not blocked by policy. PowerShell 7 does not work because it has no System.Speech.</li>
              <li>Press Check again.</li>
            </ol>
          </>
        )}
        {engine && <div className={[s.help, s.muted].join(' ')}>Checked {formatDateTime(engine.checkedAt)}</div>}
      </div>
      <Button variant="outline" onClick={() => void check()} disabled={checking}>
        {checking ? 'Checking…' : 'Check again'}
      </Button>
    </div>
  )
}
