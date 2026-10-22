import { createPortal } from 'react-dom'
import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes } from 'react'
import s from './ui.module.css'
import { Check, X } from 'lucide-react'
import { formatShortcut } from '@renderer/lib/format'

// ---------- Button ----------
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'outline' | 'danger' | 'recording'
  size?: 'sm' | 'md' | 'lg'
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'default', size = 'md', className, ...rest }, ref) {
  return <button ref={ref} type="button" className={[s.button, className].filter(Boolean).join(' ')} data-variant={variant} data-size={size} {...rest} />
})

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  shortcut?: string
  active?: boolean
  size?: 'sm' | 'md'
}
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ label, shortcut, active, size = 'md', className, children, ...rest }, ref) {
  return (
    <Tooltip label={label} shortcut={shortcut}>
      <button ref={ref} type="button" aria-label={label} className={[s.iconButton, className].filter(Boolean).join(' ')} data-active={active ? 'true' : undefined} data-size={size} {...rest}>
        {children}
      </button>
    </Tooltip>
  )
})

// ---------- Input ----------
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={[s.input, className].filter(Boolean).join(' ')} spellCheck={false} {...rest} />
})

export function Select({ className, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>): JSX.Element {
  return <select className={[s.select, className].filter(Boolean).join(' ')} {...rest} />
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }): JSX.Element {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className={s.switch} disabled={disabled} onClick={() => onChange(!checked)} />
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }): JSX.Element {
  return (
    <div className={s.segmented} role="group">
      {options.map((o) => (
        <button key={o.value} type="button" className={s.segment} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ---------- Tooltip ----------
export function Tooltip({ label, shortcut, children }: { label: string; shortcut?: string; children: ReactNode }): JSX.Element {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const show = (e: React.MouseEvent): void => {
    const target = e.currentTarget as HTMLElement
    timer.current = setTimeout(() => {
      const r = target.getBoundingClientRect()
      setPos({ x: r.left + r.width / 2, y: r.bottom + 6 })
    }, 450)
  }
  const hide = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setPos(null)
  }
  return (
    <span onMouseEnter={show} onMouseLeave={hide} onMouseDown={hide} style={{ display: 'contents' }}>
      {children}
      {pos && createPortal(<TooltipBubble label={label} shortcut={shortcut} x={pos.x} y={pos.y} />, document.body)}
    </span>
  )
}
function TooltipBubble({ label, shortcut, x, y }: { label: string; shortcut?: string; x: number; y: number }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [left, setLeft] = useState(x)
  const [top, setTop] = useState(y)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    setLeft(Math.max(6, Math.min(window.innerWidth - w - 6, x - w / 2)))
    setTop(y + h > window.innerHeight - 6 ? y - h - 34 : y)
  }, [x, y])
  return (
    <div ref={ref} className={s.tooltip} role="tooltip" style={{ left, top }}>
      {label}
      {shortcut && <kbd>{formatShortcut(shortcut)}</kbd>}
    </div>
  )
}

// ---------- Menu ----------
export interface MenuItem {
  id: string
  label: string
  icon?: ReactNode
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  checked?: boolean
  onSelect?: () => void
  /** Renders a non-interactive heading. */
  heading?: boolean
  separator?: boolean
}

export function Menu({ items, anchor, onClose, align = 'left' }: { items: MenuItem[]; anchor: { x: number; y: number } | DOMRect; onClose: () => void; align?: 'left' | 'right' }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 })
  const actionable = items.filter((i) => !i.separator && !i.heading && !i.disabled)
  const [focus, setFocus] = useState(-1)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    let left: number
    let top: number
    if ('width' in anchor) {
      left = align === 'right' ? anchor.right - w : anchor.left
      top = anchor.bottom + 4
      if (top + h > window.innerHeight - 8) top = anchor.top - h - 4
    } else {
      left = anchor.x
      top = anchor.y
      if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8)
    }
    left = Math.max(8, Math.min(window.innerWidth - w - 8, left))
    setPos({ left, top })
  }, [anchor, align])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setFocus((f) => (f + 1) % Math.max(1, actionable.length))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setFocus((f) => (f <= 0 ? actionable.length - 1 : f - 1))
      } else if (e.key === 'Enter' && focus >= 0) {
        e.preventDefault()
        actionable[focus]?.onSelect?.()
        onClose()
      }
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose, focus, actionable])

  return createPortal(
    <div ref={ref} className={s.popover} role="menu" style={pos}>
      {items.map((it, i) =>
        it.separator ? (
          <div key={it.id ?? i} className={s.menuSeparator} role="separator" />
        ) : it.heading ? (
          <div key={it.id} className={s.menuHeading}>
            {it.label}
          </div>
        ) : (
          <button
            key={it.id}
            type="button"
            role="menuitem"
            className={s.menuItem}
            data-danger={it.danger ? 'true' : undefined}
            data-focused={actionable[focus]?.id === it.id ? 'true' : undefined}
            disabled={it.disabled}
            onMouseEnter={() => setFocus(actionable.findIndex((a) => a.id === it.id))}
            onClick={() => {
              it.onSelect?.()
              onClose()
            }}
          >
            {it.icon}
            <span className={s.menuLabel}>{it.label}</span>
            {it.checked && <Check size={14} className={s.menuCheck} aria-hidden />}
            {it.shortcut && <span className={s.menuShortcut}>{formatShortcut(it.shortcut)}</span>}
          </button>
        )
      )}
    </div>,
    document.body
  )
}

/** Generic anchored popover for custom content. */
export function Popover({ anchor, onClose, children, align = 'left', width }: { anchor: DOMRect; onClose: () => void; children: ReactNode; align?: 'left' | 'right'; width?: number }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    let left = align === 'right' ? anchor.right - w : anchor.left
    let top = anchor.bottom + 4
    if (top + h > window.innerHeight - 8) top = Math.max(8, anchor.top - h - 4)
    left = Math.max(8, Math.min(window.innerWidth - w - 8, left))
    setPos({ left, top })
  }, [anchor, align])
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])
  return createPortal(
    <div ref={ref} className={s.popover} style={{ ...pos, width, padding: 8 }}>
      {children}
    </div>,
    document.body
  )
}

// ---------- Dialog ----------
export function Dialog({ title, onClose, children, footer, width }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return createPortal(
    <div className={s.backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={s.dialog} role="dialog" aria-modal="true" aria-label={title} style={width ? { width: `min(${width}px, calc(100vw - 48px))` } : undefined}>
        <div className={s.dialogHeader}>
          <span style={{ flex: 1 }}>{title}</span>
          <IconButton label="Close" size="sm" onClick={onClose}>
            <X size={15} />
          </IconButton>
        </div>
        <div className={s.dialogBody}>{children}</div>
        {footer && <div className={s.dialogFooter}>{footer}</div>}
      </div>
    </div>,
    document.body
  )
}

// ---------- Empty state ----------
export function EmptyState({ title, body, action, icon }: { title: string; body?: ReactNode; action?: ReactNode; icon?: ReactNode }): JSX.Element {
  return (
    <div className={s.empty}>
      {icon}
      <div className={s.emptyTitle}>{title}</div>
      {body && <div className={s.emptyBody}>{body}</div>}
      {action && <div className={s.emptyAction}>{action}</div>}
    </div>
  )
}

// ---------- Toasts ----------
export function ToastHost({ toasts, onDismiss }: { toasts: { id: string; message: string; kind: string; action?: { label: string; onClick: () => void } }[]; onDismiss: (id: string) => void }): JSX.Element {
  return (
    <div className={s.toasts} aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={s.toast} data-kind={t.kind}>
          <span>{t.message}</span>
          {t.action && (
            <button
              type="button"
              className={s.toastAction}
              onClick={() => {
                t.action?.onClick()
                onDismiss(t.id)
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" className={s.toastAction} aria-label="Dismiss" onClick={() => onDismiss(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
