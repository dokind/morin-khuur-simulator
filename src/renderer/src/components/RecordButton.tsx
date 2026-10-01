import { useEffect, useState } from 'react'
import { engine } from '@renderer/audio/engine'
import { saveFile } from '@renderer/platform'

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')

/** Records the master output and offers the take as a WAV file. */
export function QuickRecordButton() {
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    if (!recording) return
    const started = performance.now()
    const id = window.setInterval(() => setElapsed((performance.now() - started) / 1000), 200)
    return () => window.clearInterval(id)
  }, [recording])

  const toggle = async () => {
    if (!recording) {
      await engine.startRecording()
      setElapsed(0)
      setStatus(null)
      setRecording(true)
      return
    }
    setRecording(false)
    const wav = await engine.stopRecording()
    if (!wav) return
    const saved = await saveFile({
      title: 'Save recording',
      defaultName: `morin-khuur-take-${stamp()}.wav`,
      filters: [{ name: 'WAV audio', extensions: ['wav'] }],
      data: wav
    })
    setStatus(saved ? 'Saved' : 'Discarded')
  }

  const mm = Math.floor(elapsed / 60)
  const ss = Math.floor(elapsed % 60)
    .toString()
    .padStart(2, '0')

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => void toggle()}
        className="btn h-11 px-5 text-sm"
        data-on={recording}
        style={
          {
            '--btn-accent': 'var(--color-rec)',
            background: recording ? 'linear-gradient(180deg,#c9373c,#8f2226)' : 'linear-gradient(180deg,#a93337,#7a1d20)',
            borderColor: '#d8565a'
          } as React.CSSProperties
        }
        aria-label={recording ? 'Stop recording' : 'Start quick record'}
      >
        <span className={`h-3 w-3 rounded-full bg-white ${recording ? 'animate-pulse' : ''}`} />
        {recording ? `REC ${mm}:${ss}` : 'QUICK RECORD'}
      </button>
      <span className="narrow:hidden">
        <Cassette spinning={recording} />
      </span>
      {status && <span className="text-xs text-muted">{status}</span>}
    </div>
  )
}

function Cassette({ spinning }: { spinning: boolean }) {
  return (
    <svg width="64" height="40" viewBox="0 0 64 40" aria-hidden>
      <rect x="1" y="1" width="62" height="38" rx="4" fill="#2a2420" stroke="#5b4f44" />
      <rect x="7" y="6" width="50" height="14" rx="2" fill="#d9573f" />
      <rect x="7" y="10" width="50" height="3" fill="#f2c45a" />
      <rect x="16" y="22" width="32" height="11" rx="5" fill="#141110" />
      {[24, 40].map((cx) => (
        <g key={cx} style={{ transformOrigin: `${cx}px 27.5px`, animation: spinning ? 'reel-spin 1.2s linear infinite' : undefined }}>
          <circle cx={cx} cy={27.5} r={4} fill="#e8e0d4" />
          <path d={`M${cx - 2.5} 27.5 H${cx + 2.5} M${cx} 25 V30`} stroke="#141110" strokeWidth={1.2} />
        </g>
      ))}
    </svg>
  )
}
