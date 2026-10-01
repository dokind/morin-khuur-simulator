/** Minimal horse-head-fiddle mark used in the sidebar and About dialog. */
export function Logo({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="logo-wood" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#d99a5b" />
          <stop offset="100%" stopColor="#8a5528" />
        </linearGradient>
      </defs>
      <path d="M30 4 L34 9 C37 10 40 13 40 17 L37 19 C35 18 33 18 32 20 L32 38 L28 38 L28 17 C26 16 25 14 26 11 Z" fill="url(#logo-wood)" />
      <path d="M17 38 L47 36 Q50 36 50 39 L52 58 Q52 61 49 61 L15 61 Q12 61 12 58 L14 41 Q14 38 17 38 Z" fill="url(#logo-wood)" />
      <path d="M22 45 q4 -4 2 2 q-2 5 2 5" fill="none" stroke="#2a170a" strokeWidth={2} strokeLinecap="round" />
      <path d="M42 45 q-4 -4 -2 2 q2 5 -2 5" fill="none" stroke="#2a170a" strokeWidth={2} strokeLinecap="round" />
      <line x1={29} y1={20} x2={29} y2={57} stroke="#f2e9d8" strokeWidth={1.2} />
      <line x1={31.5} y1={20} x2={31.5} y2={57} stroke="#f2e9d8" strokeWidth={1} />
    </svg>
  )
}
