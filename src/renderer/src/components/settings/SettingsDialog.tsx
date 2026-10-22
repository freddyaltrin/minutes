import { useEffect, useState, type ReactNode } from 'react'
import { Calendar, Database, Download, Keyboard, Mic, Settings2, ShieldCheck, Stethoscope, Type } from 'lucide-react'
import { Dialog } from '../ui'
import { store } from '@renderer/state/app-store'
import s from './settings.module.css'
import { GeneralSection } from './GeneralSection'
import { AudioSection } from './AudioSection'
import { TranscriptionSection } from './TranscriptionSection'
import { ShortcutsSection } from './ShortcutsSection'
import { CalendarSection } from './CalendarSection'
import { StorageSection } from './StorageSection'
import { UpdatesSection } from './UpdatesSection'
import { PrivacySection } from './PrivacySection'
import { DiagnosticsSection } from './DiagnosticsSection'

interface NavItem {
  id: string
  label: string
  icon: ReactNode
  render: () => JSX.Element
}

const ICON = 15

const SECTIONS: NavItem[] = [
  { id: 'general', label: 'General', icon: <Settings2 size={ICON} />, render: () => <GeneralSection /> },
  { id: 'audio', label: 'Audio', icon: <Mic size={ICON} />, render: () => <AudioSection /> },
  { id: 'transcription', label: 'Transcription', icon: <Type size={ICON} />, render: () => <TranscriptionSection /> },
  { id: 'shortcuts', label: 'Shortcuts', icon: <Keyboard size={ICON} />, render: () => <ShortcutsSection /> },
  { id: 'calendar', label: 'Calendar', icon: <Calendar size={ICON} />, render: () => <CalendarSection /> },
  { id: 'storage', label: 'Storage', icon: <Database size={ICON} />, render: () => <StorageSection /> },
  { id: 'updates', label: 'Updates', icon: <Download size={ICON} />, render: () => <UpdatesSection /> },
  { id: 'privacy', label: 'Privacy', icon: <ShieldCheck size={ICON} />, render: () => <PrivacySection /> },
  { id: 'diagnostics', label: 'Diagnostics', icon: <Stethoscope size={ICON} />, render: () => <DiagnosticsSection /> }
]

export function SettingsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const requested = store.get().settingsSection
  const [section, setSection] = useState<string>(SECTIONS.some((x) => x.id === requested) ? requested : 'general')

  // A later setOverlay('settings', 'updates') while the dialog is open should still jump to that section.
  useEffect(() => {
    return store.subscribe(() => {
      const next = store.get().settingsSection
      if (next !== requested && SECTIONS.some((x) => x.id === next)) setSection(next)
    })
  }, [requested])

  const active = SECTIONS.find((x) => x.id === section) ?? SECTIONS[0]

  return (
    <Dialog title="Settings" onClose={onClose} width={760}>
      <div className={s.shell}>
        <nav className={s.nav} aria-label="Settings sections">
          {SECTIONS.map((item) => (
            <button key={item.id} type="button" className={s.navItem} aria-current={item.id === section ? 'true' : undefined} onClick={() => setSection(item.id)}>
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>
        <div className={s.content} key={active.id}>
          {active.render()}
        </div>
      </div>
    </Dialog>
  )
}

export { SECTIONS as SETTINGS_SECTIONS }
