import { useCallback, useEffect, useState } from 'react'
import { Button, Input } from '../ui'
import { toast } from '@renderer/state/actions'
import { formatDateTime } from '@renderer/lib/format'
import type { CalendarSource } from '@shared/types'
import s from './settings.module.css'
import { Group, Para, Section } from './SettingsRow'

const KIND_LABEL: Record<CalendarSource['kind'], string> = { 'ics-url': 'iCal feed', 'ics-file': '.ics file' }

function validUrl(raw: string): string | null {
  const v = raw.trim().replace(/^webcals?:\/\//i, 'https://')
  try {
    const u = new URL(v)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return u.toString()
  } catch {
    return null
  }
}

export function CalendarSection(): JSX.Element {
  const [sources, setSources] = useState<CalendarSource[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    try {
      setSources(await window.minutes.calendar.listSources())
    } catch (err) {
      setSources([])
      toast(`Could not load calendars: ${(err as Error).message}`, { kind: 'error' })
    }
  }, [])

  useEffect(() => {
    void load()
    return window.minutes.on.calendarChanged(() => void load())
  }, [load])

  const refresh = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      setSources(await window.minutes.calendar.refresh(id))
    } catch (err) {
      toast(`Refresh failed: ${(err as Error).message}`, { kind: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const remove = async (src: CalendarSource): Promise<void> => {
    const ok = await window.minutes.app.confirm({
      title: 'Remove calendar',
      message: `Remove “${src.label}”?`,
      detail: 'Its upcoming events disappear from Minutes. Notes already created from its events are kept.',
      confirmLabel: 'Remove',
      destructive: true
    })
    if (!ok) return
    try {
      await window.minutes.calendar.removeSource(src.id)
      await load()
    } catch (err) {
      toast(`Could not remove calendar: ${(err as Error).message}`, { kind: 'error' })
    }
  }

  const addUrl = async (): Promise<void> => {
    const normalized = validUrl(url)
    if (!normalized) {
      setFormError('Enter a full http(s) or webcal address ending in an .ics feed.')
      return
    }
    setFormError(null)
    setAdding(true)
    try {
      const src = await window.minutes.calendar.addIcsUrl(label.trim(), normalized)
      setLabel('')
      setUrl('')
      await load()
      toast(src.lastError ? `Added “${src.label}”, but the first fetch failed: ${src.lastError}` : `Added “${src.label}” (${src.eventCount} events)`, { kind: src.lastError ? 'error' : 'info' })
    } catch (err) {
      setFormError((err as Error).message)
    } finally {
      setAdding(false)
    }
  }

  const addFile = async (): Promise<void> => {
    setAdding(true)
    try {
      const src = await window.minutes.calendar.addIcsFile()
      if (src) {
        await load()
        toast(`Added “${src.label}” (${src.eventCount} events)`)
      }
    } catch (err) {
      toast(`Could not add file: ${(err as Error).message}`, { kind: 'error' })
    } finally {
      setAdding(false)
    }
  }

  return (
    <Section title="Calendar" intro="Upcoming meetings from your calendars appear in the sidebar so a note can be started with the title, time and attendees filled in.">
      <Group title="Your calendars">
        {sources === null ? (
          <div className={s.help}>Loading…</div>
        ) : sources.length === 0 ? (
          <div className={s.help}>No calendars yet. Add an iCal feed address or an .ics file below.</div>
        ) : (
          <div className={s.list}>
            {sources.map((src) => (
              <div key={src.id} className={s.listRow}>
                <div className={s.listMain}>
                  <div className={s.listTitle}>
                    {src.label} <span className={s.scope}>{KIND_LABEL[src.kind]}</span>
                  </div>
                  <div className={s.listMeta}>
                    {src.eventCount} {src.eventCount === 1 ? 'event' : 'events'}
                    {' · '}
                    {src.lastFetchedAt ? `refreshed ${formatDateTime(src.lastFetchedAt)}` : 'never refreshed'}
                    {src.url && (
                      <>
                        <br />
                        <span className={[s.mono, s.selectable].join(' ')}>{src.url}</span>
                      </>
                    )}
                    {src.lastError && (
                      <>
                        <br />
                        <span className={[s.danger, s.selectable].join(' ')}>{src.lastError}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className={s.listActions}>
                  <Button size="sm" onClick={() => void refresh(src.id)} disabled={busy === src.id}>
                    {busy === src.id ? 'Refreshing…' : 'Refresh'}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => void remove(src)}>
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Group>
      <Group title="Add calendar">
        <form
          className={s.form}
          onSubmit={(e) => {
            e.preventDefault()
            void addUrl()
          }}
        >
          <div className={s.formRow}>
            <Input aria-label="Label" placeholder="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} style={{ maxWidth: 180 }} />
            <Input aria-label="ICS URL" placeholder="https://…/basic.ics" value={url} onChange={(e) => setUrl(e.target.value)} />
            <Button type="submit" variant="primary" disabled={adding || !url.trim()}>
              {adding ? 'Adding…' : 'Add'}
            </Button>
          </div>
          {formError && <div className={s.formError}>{formError}</div>}
          <div className={s.help}>
            Paste the secret/private iCal address from Google Calendar (Settings → your calendar → Secret address in iCal format), Outlook (Settings → Calendar → Shared
            calendars → Publish → ICS link), or any calendar that can publish an .ics feed.
          </div>
          <div className={s.inlineButtons}>
            <Button variant="outline" onClick={() => void addFile()} disabled={adding}>
              Add .ics file…
            </Button>
          </div>
        </form>
      </Group>
      <Group title="How this works">
        <Para>
          Minutes reads calendars through published iCal feeds. No Google or Microsoft sign-in or account is required, and nothing is sent back to the calendar: the feed
          is only downloaded. Keep the secret address private, since anyone who has it can read the calendar.
        </Para>
        <details className={s.details}>
          <summary>About Google / Microsoft OAuth</summary>
          <p className={[s.paragraph, s.selectable].join(' ')}>
            Signing in with a Google or Microsoft account is not built in. It would require registering Minutes as an OAuth application with each provider, keeping
            client credentials inside the app and completing each provider&apos;s verification process, and it would add a network dependency on their account APIs.
            The published-feed approach gives the same list of upcoming meetings without any of that.
          </p>
        </details>
      </Group>
    </Section>
  )
}
