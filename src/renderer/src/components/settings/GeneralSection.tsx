import { Segmented, Select, Switch } from '../ui'
import { useApp } from '@renderer/state/app-store'
import { updateSettings } from '@renderer/state/actions'
import type { ThemePreference } from '@shared/types'
import { Group, Row, Section } from './SettingsRow'

const FONT_SIZES = [13, 14, 15, 16, 17, 18]

export function GeneralSection(): JSX.Element {
  const settings = useApp((st) => st.settings)
  return (
    <Section title="General">
      <Group title="Appearance">
        <Row label="Theme" help="System follows the Windows light/dark setting.">
          <Segmented<ThemePreference>
            value={settings.theme}
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' }
            ]}
            onChange={(theme) => void updateSettings({ theme })}
          />
        </Row>
        <Row label="Editor text size" help="Applies to note bodies. Lists and controls keep their size.">
          <Select aria-label="Editor text size" value={settings.editorFontSize} onChange={(e) => void updateSettings({ editorFontSize: Number(e.target.value) })}>
            {FONT_SIZES.map((n) => (
              <option key={n} value={n}>
                {n} px
              </option>
            ))}
          </Select>
        </Row>
        <Row label="Show sidebar" help="Folders, tags and views. The same as the Toggle sidebar shortcut.">
          <Switch label="Show sidebar" checked={!settings.sidebarCollapsed} onChange={(v) => void updateSettings({ sidebarCollapsed: !v })} />
        </Row>
      </Group>
      <Group title="Startup">
        <Row label="Default view on launch" help="Which list opens when Minutes starts. Recent shows notes from the last 30 days.">
          <Select aria-label="Default view on launch" value={settings.defaultView} onChange={(e) => void updateSettings({ defaultView: e.target.value as 'recent' | 'all' })}>
            <option value="recent">Recent</option>
            <option value="all">All notes</option>
          </Select>
        </Row>
        <Row label="Launch at login" help="Registers Minutes with Windows so it starts when you sign in.">
          <Switch label="Launch at login" checked={settings.launchAtLogin} onChange={(v) => void updateSettings({ launchAtLogin: v })} />
        </Row>
        <Row label="Start minimized to tray" help={settings.launchAtLogin ? 'When launched at login, open hidden in the tray instead of showing the window.' : 'Available when Launch at login is on.'}>
          <Switch label="Start minimized to tray" checked={settings.startMinimized} disabled={!settings.launchAtLogin} onChange={(v) => void updateSettings({ startMinimized: v })} />
        </Row>
      </Group>
    </Section>
  )
}
