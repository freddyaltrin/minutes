import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Clock, FileText, ListChecks, MessageSquareText, HelpCircle } from 'lucide-react'
import s from './SearchPalette.module.css'
import { EmptyState, Segmented, Select, Switch } from './ui'
import { store, useApp } from '@renderer/state/app-store'
import { openNote, toast } from '@renderer/state/actions'
import { formatDate } from '@renderer/lib/format'
import { formatTimestamp } from '@shared/text/transcript-parsers'
import type { AskResult, QuestionIntent, SearchFilters, SearchHit, SearchResult } from '@shared/types'

type Mode = 'search' | 'ask'
type Scope = SearchFilters['scope']

const DEBOUNCE_MS = 120
const RESULT_LIMIT = 80

const INTENT_LABELS: Record<QuestionIntent, string> = {
  deadline: 'dates and deadlines',
  assignment: 'who does what',
  decision: 'decisions',
  topic: 'discussion about',
  mention: 'mentions of',
  generic: 'passages matching'
}

const SCOPE_OPTIONS: { value: Scope; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'notes', label: 'Notes' },
  { value: 'transcripts', label: 'Transcripts' },
  { value: 'actions', label: 'Action items' }
]

/** The typed text survives closing and reopening the palette within a session. */
let lastText = ''

interface Group {
  noteId: string
  title: string
  date: number | null
  hits: { hit: SearchHit; index: number }[]
}

function groupHits(hits: SearchHit[]): Group[] {
  const groups: Group[] = []
  const byNote = new Map<string, Group>()
  hits.forEach((hit, index) => {
    let g = byNote.get(hit.noteId)
    if (!g) {
      g = { noteId: hit.noteId, title: hit.noteTitle, date: hit.meetingAt ?? hit.updatedAt, hits: [] }
      byNote.set(hit.noteId, g)
      groups.push(g)
    }
    g.hits.push({ hit, index })
  })
  return groups
}

function HitIcon({ kind }: { kind: SearchHit['kind'] }): JSX.Element {
  if (kind === 'transcript') return <MessageSquareText size={14} className={s.hitIcon} />
  if (kind === 'extraction') return <ListChecks size={14} className={s.hitIcon} />
  return <FileText size={14} className={s.hitIcon} />
}

export function SearchPalette({ mode: initialMode, onClose }: { mode: Mode; onClose: () => void }): JSX.Element {
  const folders = useApp((st) => st.folders)
  const tags = useApp((st) => st.tags)

  const [mode, setMode] = useState<Mode>(initialMode)
  const [text, setText] = useState(lastText)
  const [scope, setScope] = useState<Scope>('all')
  const [archived, setArchived] = useState(false)
  const [folderId, setFolderId] = useState<string>('')
  const [result, setResult] = useState<SearchResult | null>(null)
  const [ask, setAsk] = useState<AskResult | null>(null)
  const [recent, setRecent] = useState<string[]>([])
  const [active, setActive] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const requestSeq = useRef(0)

  const query = text.trim()
  const filters = useMemo<SearchFilters>(
    () => ({ scope: mode === 'ask' ? 'all' : scope, archived, folderId: folderId || null }),
    [mode, scope, archived, folderId]
  )

  useEffect(() => {
    lastText = text
  }, [text])

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  // Recent searches are shown when the search box is empty.
  const loadRecent = useCallback(() => {
    window.minutes.search
      .recent()
      .then(setRecent)
      .catch((err: Error) => toast(`Could not load recent searches: ${err.message}`, { kind: 'error' }))
  }, [])
  useEffect(() => {
    if (mode === 'search' && !query) loadRecent()
  }, [mode, query, loadRecent])

  // Debounced query → main.
  useEffect(() => {
    const seq = ++requestSeq.current
    if (!query) {
      setResult(null)
      setAsk(null)
      setActive(0)
      return
    }
    const timer = setTimeout(() => {
      const run = async (): Promise<void> => {
        try {
          if (mode === 'search') {
            const r = await window.minutes.search.query(query, filters, RESULT_LIMIT)
            if (seq !== requestSeq.current) return
            setResult(r)
            setAsk(null)
          } else {
            const a = await window.minutes.search.ask(query, filters)
            if (seq !== requestSeq.current) return
            setAsk(a)
            setResult(null)
          }
          setActive(0)
        } catch (err) {
          if (seq !== requestSeq.current) return
          toast(`Search failed: ${(err as Error).message}`, { kind: 'error' })
        }
      }
      void run()
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, mode, filters])

  const hits: SearchHit[] = mode === 'search' ? result?.hits ?? [] : ask?.hits ?? []
  const groups = useMemo(() => groupHits(hits), [hits])

  // Rows navigable with the keyboard when there is no query: recent searches or suggested questions.
  const suggestions = useMemo(() => {
    if (mode !== 'ask') return []
    const subject = tags[0]?.name ?? folders[0]?.name ?? 'the budget'
    return ['What deadlines were mentioned?', 'Which tasks were assigned?', 'What did we decide?', `Where was ${subject} mentioned?`]
  }, [mode, tags, folders])
  const emptyRows = query ? [] : mode === 'search' ? recent : suggestions
  const rowCount = query ? hits.length : emptyRows.length

  useEffect(() => {
    if (active >= rowCount) setActive(0)
  }, [active, rowCount])

  useEffect(() => {
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active, rowCount])

  const openHit = useCallback(
    (hit: SearchHit) => {
      if (hit.kind === 'transcript') void openNote(hit.noteId, { panel: 'transcript', jumpToSegment: hit.refId })
      else if (hit.kind === 'extraction') void openNote(hit.noteId, { panel: 'suggestions' })
      else void openNote(hit.noteId)
      onClose()
    },
    [onClose]
  )

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (rowCount === 0) return
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setActive((a) => (a + delta + rowCount) % rowCount)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (query) {
        const hit = hits[active]
        if (hit) openHit(hit)
      } else {
        const row = emptyRows[active]
        if (row) setText(row)
      }
    }
  }

  const clearRecent = (): void => {
    window.minutes.search
      .clearRecent()
      .then(() => setRecent([]))
      .catch((err: Error) => toast(`Could not clear recent searches: ${err.message}`, { kind: 'error' }))
  }

  const placeholder = mode === 'search' ? 'Search notes and transcripts…' : 'Ask a question, e.g. what deadlines were mentioned?'

  const renderHits = (): JSX.Element => (
    <>
      {groups.map((g) => (
        <div key={g.noteId} className={s.group}>
          <div className={s.groupHeader}>
            <span className={s.groupTitle}>{g.title || 'Untitled note'}</span>
            {g.date !== null && <span className={s.groupDate}>{formatDate(g.date)}</span>}
          </div>
          {g.hits.map(({ hit, index }) => (
            <button
              key={`${hit.kind}:${hit.refId}`}
              type="button"
              className={s.hit}
              data-row={index}
              data-active={index === active ? 'true' : undefined}
              onMouseEnter={() => setActive(index)}
              onClick={() => openHit(hit)}
            >
              <HitIcon kind={hit.kind} />
              <span className={s.snippet} dangerouslySetInnerHTML={{ __html: hit.snippet }} />
              {hit.kind === 'transcript' && hit.startMs !== null && <span className={s.timestamp}>{formatTimestamp(hit.startMs)}</span>}
            </button>
          ))}
        </div>
      ))}
    </>
  )

  const renderNoResults = (): JSX.Element => (
    <EmptyState
      title={`No matches for “${query}”`}
      body={
        mode === 'search' && scope === 'transcripts'
          ? 'Transcripts are only searchable after they are recorded or imported.'
          : mode === 'ask'
            ? 'Try fewer or shorter words. Transcripts are only searchable after they are recorded or imported.'
            : 'Try fewer or shorter words.'
      }
    />
  )

  const renderEmpty = (): JSX.Element => {
    if (mode === 'ask') {
      return (
        <>
          <div className={s.sectionTitle}>Try asking</div>
          {suggestions.map((q, i) => (
            <button key={q} type="button" className={s.simpleRow} data-row={i} data-active={i === active ? 'true' : undefined} onMouseEnter={() => setActive(i)} onClick={() => setText(q)}>
              <HelpCircle size={14} />
              <span>{q}</span>
            </button>
          ))}
        </>
      )
    }
    if (recent.length > 0) {
      return (
        <>
          <div className={s.sectionTitle}>
            <span>Recent searches</span>
            <button type="button" className={s.linkButton} onClick={clearRecent}>
              Clear
            </button>
          </div>
          {recent.map((q, i) => (
            <button key={q} type="button" className={s.simpleRow} data-row={i} data-active={i === active ? 'true' : undefined} onMouseEnter={() => setActive(i)} onClick={() => setText(q)}>
              <Clock size={14} />
              <span>{q}</span>
            </button>
          ))}
        </>
      )
    }
    return (
      <div className={s.hint}>
        Words match prefixes: <code>budg</code> finds “budget” and “budgeting”. <code>“quoted phrases”</code> match exactly. Notes, transcripts and action items are all searched.
      </div>
    )
  }

  const askLine = mode === 'ask' && ask && (
    <div className={s.intentLine}>
      Looking for: <b>{INTENT_LABELS[ask.intent]}</b>
      {ask.terms.length > 0 && (
        <>
          {' · terms: '}
          <b>{ask.terms.join(', ')}</b>
        </>
      )}
    </div>
  )

  return createPortal(
    <div className={s.backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={s.panel} role="dialog" aria-modal="true" aria-label={mode === 'search' ? 'Search' : 'Ask your notes'}>
        <div className={s.top}>
          <div className={s.modeRow}>
            <Segmented<Mode>
              value={mode}
              options={[
                { value: 'search', label: 'Search' },
                { value: 'ask', label: 'Ask' }
              ]}
              onChange={(m) => {
                setMode(m)
                inputRef.current?.focus()
              }}
            />
            <span className={s.modeHint}>{mode === 'search' ? 'Full-text search across notes, transcripts and action items' : 'Finds passages in your notes; nothing is generated'}</span>
          </div>
          <input
            ref={inputRef}
            className={s.input}
            value={text}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
            aria-label={placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {mode === 'search' && query && (
            <div className={s.filters}>
              <Segmented<Scope> value={scope} options={SCOPE_OPTIONS} onChange={setScope} />
              <label className={s.filterSwitch}>
                <Switch checked={archived} onChange={setArchived} label="Include archived" />
                <span>Include archived</span>
              </label>
              {folders.length > 0 && (
                <Select className={s.folderSelect} value={folderId} aria-label="Folder" onChange={(e) => setFolderId(e.target.value)}>
                  <option value="">Any folder</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </Select>
              )}
            </div>
          )}
        </div>

        <div className={s.body} ref={bodyRef}>
          {askLine}
          {!query ? renderEmpty() : hits.length > 0 ? renderHits() : (mode === 'search' ? result : ask) ? renderNoResults() : null}
        </div>

        <div className={s.footer}>
          <span>
            {mode === 'ask'
              ? ask && query
                ? `${hits.length} matching ${hits.length === 1 ? 'passage' : 'passages'}`
                : ''
              : result
                ? `${result.total} ${result.total === 1 ? 'result' : 'results'} · ${result.tookMs} ms`
                : ''}
          </span>
          <span className={s.footerKeys}>
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> move
            </span>
            <span>
              <kbd>Enter</kbd> open
            </span>
            <span>
              <kbd>Esc</kbd> close
            </span>
          </span>
        </div>
      </div>
    </div>,
    document.body
  )
}
