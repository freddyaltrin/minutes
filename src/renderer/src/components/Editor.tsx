import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { EditorContent, useEditor, type Editor as TipTapEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { Bold, Italic, List, ListOrdered, ListChecks, Heading1, Heading2, Quote, Code, ChevronDown, ChevronUp, X, Link as LinkIcon } from 'lucide-react'
import s from './editor.module.css'
import { IconButton, Input } from './ui'
import { queueSave, flushSave } from '@renderer/state/actions'
import { store, useApp } from '@renderer/state/app-store'
import { bus } from '@renderer/lib/bus'

// ---------- Find-in-note plugin (decorations only, no document changes) ----------
interface FindState {
  query: string
  current: number
  matches: { from: number; to: number }[]
}
const findKey = new PluginKey<FindState>('find')

function computeMatches(doc: import('@tiptap/pm/model').Node, query: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  if (!query) return out
  const q = query.toLowerCase()
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    const text = node.text.toLowerCase()
    let i = text.indexOf(q)
    while (i >= 0) {
      out.push({ from: pos + i, to: pos + i + q.length })
      i = text.indexOf(q, i + q.length)
    }
  })
  return out
}

const FindExtension = Extension.create({
  name: 'find',
  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: () => ({ query: '', current: 0, matches: [] }),
          apply(tr, prev) {
            const meta = tr.getMeta(findKey) as Partial<FindState> | undefined
            if (meta) {
              const query = meta.query ?? prev.query
              const matches = meta.query !== undefined && meta.query !== prev.query ? computeMatches(tr.doc, query) : tr.docChanged ? computeMatches(tr.doc, query) : prev.matches
              const current = meta.current !== undefined ? meta.current : Math.min(prev.current, Math.max(0, matches.length - 1))
              return { query, current, matches }
            }
            if (tr.docChanged && prev.query) return { ...prev, matches: computeMatches(tr.doc, prev.query) }
            return prev
          }
        },
        props: {
          decorations(state) {
            const st = findKey.getState(state)
            if (!st || st.matches.length === 0) return DecorationSet.empty
            return DecorationSet.create(
              state.doc,
              st.matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === st.current ? 'search-match search-match-current' : 'search-match' }))
            )
          }
        }
      })
    ]
  }
})

function extractText(editor: TipTapEditor): string {
  return editor.getText({ blockSeparator: '\n' })
}

export function Editor({ noteId, initialJson }: { noteId: string; initialJson: string }): JSX.Element {
  const findOpen = useApp((st) => st.findInNote)
  const [findQuery, setFindQuery] = useState('')
  const [findInfo, setFindInfo] = useState({ current: 0, total: 0 })
  const loadedFor = useRef<string | null>(noteId)
  const findInput = useRef<HTMLInputElement>(null)
  const [, force] = useState(0)

  const initialContent = ((): object | string => {
    try {
      return initialJson ? (JSON.parse(initialJson) as object) : ''
    } catch {
      return initialJson
    }
  })()

  const editor = useEditor({
    content: initialContent,
    // We re-render explicitly on selection/focus changes for the toolbar; avoid TipTap's per-transaction re-render.
    shouldRerenderOnTransaction: false,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true, protocols: ['http', 'https', 'mailto'] }),
      Placeholder.configure({ placeholder: 'Write notes…' }),
      FindExtension
    ],
    editorProps: {
      attributes: { spellcheck: 'true', 'aria-label': 'Note body' },
      handleClick(_view, _pos, event) {
        const a = (event.target as HTMLElement).closest('a')
        if (a && (event.ctrlKey || event.metaKey)) {
          void window.minutes.app.openExternal(a.getAttribute('href') ?? '')
          return true
        }
        return false
      }
    },
    onUpdate({ editor: ed }) {
      const cur = store.get().current
      if (!cur || cur.id !== loadedFor.current) return
      // Serialization of large documents is expensive, so it happens once, at save time, not per keystroke.
      queueSave(cur.id, () => {
        const bodyJson = JSON.stringify(ed.getJSON())
        const bodyText = extractText(ed)
        return { bodyJson, bodyText }
      })
    },
    onSelectionUpdate() {
      force((n) => n + 1)
    },
    onFocus() {
      force((n) => n + 1)
    },
    onBlur() {
      force((n) => n + 1)
    }
  })

  // The component is keyed by note id (see NoteView), so each note gets a fresh editor and a fresh
  // undo history. Content is provided once through `content` below; later store updates never reset it.
  useEffect(() => {
    loadedFor.current = noteId
    setFindQuery('')
  }, [noteId])

  useEffect(() => () => void flushSave(), [])

  // Suggestions panel → "Add to note": append a task item at the end of the document.
  useEffect(() => {
    if (!editor) return
    return bus.on('editor.insertTask', (t) => {
      editor
        .chain()
        .focus('end')
        .insertContent({ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: String(t) }] }] }] })
        .run()
    })
  }, [editor])

  // Find bar wiring
  useEffect(() => {
    if (!editor) return
    editor.view.dispatch(editor.state.tr.setMeta(findKey, { query: findOpen ? findQuery : '', current: 0 }))
    const st = findKey.getState(editor.state)
    setFindInfo({ current: st?.matches.length ? st.current + 1 : 0, total: st?.matches.length ?? 0 })
    if (st && st.matches.length) scrollToMatch(editor, st.matches[st.current].from)
  }, [editor, findQuery, findOpen])
  useEffect(() => {
    if (findOpen) setTimeout(() => findInput.current?.select(), 0)
  }, [findOpen])

  const step = (delta: 1 | -1): void => {
    if (!editor) return
    const st = findKey.getState(editor.state)
    if (!st || st.matches.length === 0) return
    const current = (st.current + delta + st.matches.length) % st.matches.length
    editor.view.dispatch(editor.state.tr.setMeta(findKey, { current }))
    setFindInfo({ current: current + 1, total: st.matches.length })
    scrollToMatch(editor, st.matches[current].from)
  }

  const closeFind = (): void => {
    store.set({ findInNote: false })
    editor?.commands.focus()
  }

  if (!editor) return <div className={s.editor} />

  const fmt = (label: string, icon: JSX.Element, active: boolean, run: () => void): JSX.Element => (
    <button type="button" className={s.formatBtn} data-active={active ? 'true' : undefined} aria-label={label} title={label} onMouseDown={(e) => e.preventDefault()} onClick={run}>
      {icon}
    </button>
  )

  const toolbarHost = document.getElementById('editor-toolbar-host')
  const toolbar = (
    <div className={s.formatBar} role="toolbar" aria-label="Formatting" data-visible={editor.isFocused ? 'true' : undefined}>
        {fmt('Heading 1', <Heading1 size={15} />, editor.isActive('heading', { level: 1 }), () => editor.chain().focus().toggleHeading({ level: 1 }).run())}
        {fmt('Heading 2', <Heading2 size={15} />, editor.isActive('heading', { level: 2 }), () => editor.chain().focus().toggleHeading({ level: 2 }).run())}
        <span className={s.formatSep} />
        {fmt('Bold', <Bold size={15} />, editor.isActive('bold'), () => editor.chain().focus().toggleBold().run())}
        {fmt('Italic', <Italic size={15} />, editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run())}
        {fmt('Code', <Code size={15} />, editor.isActive('code'), () => editor.chain().focus().toggleCode().run())}
        {fmt('Link', <LinkIcon size={15} />, editor.isActive('link'), () => {
          if (editor.isActive('link')) {
            editor.chain().focus().unsetLink().run()
            return
          }
          const href = window.prompt('Link address')
          if (href && /^(https?:\/\/|mailto:)/i.test(href)) editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
        })}
        <span className={s.formatSep} />
        {fmt('Bulleted list', <List size={15} />, editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run())}
        {fmt('Numbered list', <ListOrdered size={15} />, editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run())}
        {fmt('Checklist', <ListChecks size={15} />, editor.isActive('taskList'), () => editor.chain().focus().toggleTaskList().run())}
    </div>
  )

  return (
    <div className={s.editor}>
      {findOpen && (
        <div className={s.findBar} role="search">
          <Input
            ref={findInput}
            value={findQuery}
            placeholder="Find in note"
            onChange={(e) => setFindQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') step(e.shiftKey ? -1 : 1)
              if (e.key === 'Escape') closeFind()
            }}
          />
          <span className={s.findCount}>{findQuery ? `${findInfo.current}/${findInfo.total}` : ''}</span>
          <IconButton label="Previous match" size="sm" onClick={() => step(-1)} disabled={findInfo.total === 0}>
            <ChevronUp size={14} />
          </IconButton>
          <IconButton label="Next match" size="sm" onClick={() => step(1)} disabled={findInfo.total === 0}>
            <ChevronDown size={14} />
          </IconButton>
          <IconButton label="Close" size="sm" onClick={closeFind}>
            <X size={14} />
          </IconButton>
        </div>
      )}
      <EditorContent editor={editor} />
      {toolbarHost ? createPortal(toolbar, toolbarHost) : toolbar}
    </div>
  )
}

function scrollToMatch(editor: TipTapEditor, pos: number): void {
  try {
    const coords = editor.view.coordsAtPos(pos)
    const dom = editor.view.domAtPos(pos).node as HTMLElement | Text
    const el = dom instanceof Text ? dom.parentElement : dom
    el?.scrollIntoView({ block: 'center' })
    void coords
  } catch {
    /* ignore */
  }
}
