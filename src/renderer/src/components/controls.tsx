import type { ReactNode } from 'react'

export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  className = ''
}: {
  value: T
  options: readonly { value: T; label: string }[]
  onChange(value: T): void
  label: string
  className?: string
}) {
  return (
    <select aria-label={label} className={`field pr-8 ${className}`} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function ToggleButton({
  on,
  onClick,
  children,
  accent,
  title,
  className = ''
}: {
  on: boolean
  onClick(): void
  children: ReactNode
  accent?: string
  title?: string
  className?: string
}) {
  return (
    <button
      type="button"
      className={`btn ${className}`}
      data-on={on}
      aria-pressed={on}
      title={title}
      style={accent ? ({ '--btn-accent': accent } as React.CSSProperties) : undefined}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

export function Kbd({ children, hideWhenNarrow = false }: { children: ReactNode; hideWhenNarrow?: boolean }) {
  return <kbd className={`kbd ${hideWhenNarrow ? 'narrow:hidden' : ''}`}>{children}</kbd>
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  onChange,
  left,
  right,
  className = ''
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange(v: number): void
  left?: string
  right?: string
  className?: string
}) {
  return (
    <label className={`flex flex-col gap-1 ${className}`}>
      <span className="text-[11px] text-muted">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-[var(--color-bilag)] w-full"
      />
      {(left || right) && (
        <span className="flex justify-between text-[10px] text-faint">
          <span>{left}</span>
          <span>{right}</span>
        </span>
      )}
    </label>
  )
}
