import type { ReactNode } from 'react'
import s from './settings.module.css'

/** One setting: label + optional help on the left, control on the right. */
export function Row({ label, help, children, stacked }: { label: ReactNode; help?: ReactNode; children?: ReactNode; stacked?: boolean }): JSX.Element {
  return (
    <div className={s.row} data-stacked={stacked ? 'true' : undefined}>
      <div className={s.rowText}>
        <div className={s.rowLabel}>{label}</div>
        {help && <div className={s.help}>{help}</div>}
      </div>
      {children && <div className={s.rowControl}>{children}</div>}
    </div>
  )
}

export function Section({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <section aria-label={title}>
      <h2 className={s.sectionTitle}>{title}</h2>
      {intro && <p className={[s.help, s.sectionIntro].join(' ')}>{intro}</p>}
      {children}
    </section>
  )
}

export function Group({ title, children }: { title?: string; children: ReactNode }): JSX.Element {
  return (
    <div className={s.group}>
      {title && <h3 className={s.groupTitle}>{title}</h3>}
      {children}
    </div>
  )
}

export function Para({ children }: { children: ReactNode }): JSX.Element {
  // A div, not a <p>, so lists and paths can be nested without invalid markup.
  return <div className={[s.paragraph, s.selectable].join(' ')}>{children}</div>
}

export function Path({ value }: { value: string }): JSX.Element {
  return <span className={[s.mono, s.selectable].join(' ')}>{value}</span>
}
