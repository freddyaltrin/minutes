# Renderer conventions (read before adding components)

- React 18 + TypeScript, CSS Modules (`*.module.css`, camelCase class names). No Tailwind, no styled-components, no new deps.
- All colors, spacing, radii and type sizes come from `src/renderer/src/styles/tokens.css`. Never hard-code hex values; use `var(--fg-muted)` etc. Text roles: `--fg` body, `--fg-secondary` labels, `--fg-muted` help/meta (≥4.5:1 on `--bg`), `--fg-faint` placeholders and decoration only (≈3:1, never for information). Hyperlinks use `--link`.
- Primitives live in `src/renderer/src/components/ui.tsx`: `Button` (variants default/primary/outline/danger/recording), `IconButton` (needs `label`, shows a tooltip, optional `shortcut`), `Input`, `Select`, `Switch`, `Segmented`, `Menu` (context/dropdown; `items: MenuItem[]`, `anchor: DOMRect | {x,y}`), `Popover`, `Dialog`, `EmptyState`, `Tooltip`.
- Icons: `lucide-react`, size 14–16, strokeWidth default. Never decorative icons.
- State: `store` / `useApp(selector)` from `state/app-store.ts`; mutations through functions in `state/actions.ts` (`toast`, `openNote`, `selectNote`, `setPanel`, `setOverlay`, `updateSettings`, `queueSave`, `flushSave`, `patchCurrent`…). Never call `store.set` for note content; use the actions.
- IPC: only `window.minutes.*` (typed `MinutesApi` in `src/shared/api.ts`). Never fake data; show real empty/error states.
- Events from main: `window.minutes.on.*` (returns unsubscribe). In-renderer routing of shortcut ids / capture commands: `bus.on(id, cb)` from `lib/bus.ts`. Shortcut ids are in `src/shared/defaults.ts`.
- Formatting helpers: `lib/format.ts` (`formatTime`, `formatDate`, `formatDuration`, `formatShortcut`, `formatBytes`, `attendeeSummary`…).
- Design rules: no cards-in-cards, no gradients, no shadows except popovers/dialogs, borders only for structure, 28px control height, 4px spacing grid, text selectable only where reading/editing happens (`className="selectable"`). Every interactive element needs hover/focus-visible/active/disabled states (primitives already do). Respect `prefers-reduced-motion` (tokens zero the durations).
- Empty states must explain the situation and offer the next action. Errors are shown with `toast(message, {kind:'error'})` or inline, never swallowed.
