import type { CSSProperties } from 'react'

/**
 * Minutes mark — a 12 o'clock tick that sweeps through a quarter arc into the
 * first note rule, with two shorter rules beneath. Drawn in `currentColor` so
 * it follows whatever text colour the surrounding theme sets.
 *
 * Geometry is shared with scripts/build-icons.py; change it there first.
 */
const MARK_PATHS = [
  'M160 104 V112 A96 96 0 0 0 256 208 H352',
  'M160 304 H320',
  'M160 400 H288'
] as const

const MARK_STROKE = 56

/** The mark's own bounds in the 512 space (stroke caps included) plus a little air. */
const MARK_VIEWBOX = '96 48 352 416'

/** Standalone SVG string of the mark, for places that need markup rather than a component. */
export const LogoMarkSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK_VIEWBOX}" fill="none" stroke="currentColor" stroke-width="${MARK_STROKE}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${MARK_PATHS.map(
  (d) => `<path d="${d}"/>`
).join('')}</svg>`

export interface LogoProps {
  /** Height of the mark in CSS pixels. The wordmark scales with it. */
  size?: number
  variant?: 'mark' | 'wordmark'
  className?: string
  style?: CSSProperties
  /** Accessible name; the mark alone is decorative unless a title is given. */
  title?: string
}

const SYSTEM_FONT =
  '-apple-system, "Segoe UI Variable Text", "Segoe UI", system-ui, "Helvetica Neue", Arial, sans-serif'

function Mark({ size, title }: { size: number; title?: string }): JSX.Element {
  // Mark viewBox is 352 wide x 416 tall; keep the aspect so `size` is the height.
  const width = Math.round((size * 352) / 416)
  return (
    <svg
      width={width}
      height={size}
      viewBox={MARK_VIEWBOX}
      fill="none"
      stroke="currentColor"
      strokeWidth={MARK_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {MARK_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

export function Logo({
  size = 24,
  variant = 'mark',
  className,
  style,
  title
}: LogoProps): JSX.Element {
  if (variant === 'mark') {
    return (
      <span className={className} style={{ display: 'inline-flex', lineHeight: 0, ...style }}>
        <Mark size={size} title={title} />
      </span>
    )
  }

  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: Math.round(size * 0.4),
        color: 'inherit',
        ...style
      }}
    >
      <Mark size={size} title={title ?? 'Minutes'} />
      <span
        aria-hidden="true"
        style={{
          fontFamily: SYSTEM_FONT,
          fontWeight: 500,
          fontSize: size * 0.92,
          lineHeight: 1,
          letterSpacing: '-0.01em',
          whiteSpace: 'nowrap'
        }}
      >
        Minutes
      </span>
    </span>
  )
}

export default Logo
