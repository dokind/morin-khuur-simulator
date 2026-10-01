import { AudioWaveform, Drum, Info, ListChecks, ListMusic, Music2, Volume2 } from 'lucide-react'
import { useEffect, useState, type ComponentType } from 'react'
import { engine } from '@renderer/audio/engine'
import { AboutDialog } from '@renderer/components/AboutDialog'
import { Logo } from '@renderer/components/Logo'
import { useAudioRunning } from '@renderer/hooks'
import { isDesktop } from '@renderer/platform'
import { useSettings, type ViewId } from '@renderer/state/settings'
import { BeatMaker } from '@renderer/views/BeatMaker'
import { Playground } from '@renderer/views/Playground'
import { Playlist } from '@renderer/views/Playlist'
import { SongTester } from '@renderer/views/SongTester'
import { Studio } from '@renderer/views/Studio'

const VIEWS: { id: ViewId; label: string; icon: ComponentType<{ className?: string }>; component: ComponentType }[] = [
  { id: 'playground', label: 'Playground', icon: Music2, component: Playground },
  { id: 'beatmaker', label: 'Beat Maker', icon: Drum, component: BeatMaker },
  { id: 'songs', label: 'Song Tester', icon: ListChecks, component: SongTester },
  { id: 'playlist', label: 'Playlist', icon: ListMusic, component: Playlist },
  { id: 'studio', label: 'Studio', icon: AudioWaveform, component: Studio }
]

export function App() {
  const { view, setView, roomId, masterDb, setMasterDb, soundboard } = useSettings()
  const running = useAudioRunning()
  const [aboutOpen, setAboutOpen] = useState(false)
  const Active = VIEWS.find((v) => v.id === view)?.component ?? Playground

  // Desktop builds may start audio immediately; browsers need a first gesture.
  useEffect(() => {
    if (isDesktop) void engine.resume()
    const unlock = () => void engine.resume()
    window.addEventListener('pointerdown', unlock, { once: true })
    window.addEventListener('keydown', unlock, { once: true })
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [])

  useEffect(() => engine.setRoom(roomId), [roomId])
  useEffect(() => engine.setMasterDb(masterDb), [masterDb])
  useEffect(() => engine.setSoundboard(soundboard), [soundboard])

  return (
    <div className="flex h-full">
      <nav className="flex w-[84px] shrink-0 flex-col items-center gap-1 border-r border-line bg-[#12100d] py-4" aria-label="Views">
        <div className="mb-4 flex flex-col items-center gap-1">
          <Logo />
          <span className="text-[10px] font-semibold tracking-wide text-muted">Морин хуур</span>
        </div>
        {VIEWS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              engine.resetTransport()
              setView(id)
            }}
            aria-current={view === id ? 'page' : undefined}
            className={`flex w-[72px] flex-col items-center gap-1 rounded-xl py-2.5 text-[11px] font-medium transition-colors ${
              view === id ? 'bg-panel-3 text-bilag shadow-[inset_0_0_0_1px_var(--color-line-2)]' : 'text-muted hover:bg-panel-2 hover:text-text'
            }`}
          >
            <Icon className="h-5 w-5" />
            {label}
          </button>
        ))}
        <div className="mt-auto flex flex-col items-center gap-3">
          <label className="flex flex-col items-center gap-1 text-muted" title="Master volume">
            <Volume2 className="h-4 w-4" />
            <input
              type="range"
              min={-40}
              max={6}
              step={1}
              value={masterDb}
              onChange={(e) => setMasterDb(Number(e.target.value))}
              aria-label="Master volume"
              className="h-24 w-4 accent-[var(--color-bilag)] [writing-mode:vertical-lr] [direction:rtl]"
            />
            <span className="text-[10px] tabular-nums">{masterDb} dB</span>
          </label>
          <button type="button" onClick={() => setAboutOpen(true)} className="rounded-lg p-2 text-muted hover:text-text" aria-label="About">
            <Info className="h-5 w-5" />
          </button>
        </div>
      </nav>

      <main className="relative min-w-0 flex-1 overflow-hidden">
        <Active />
        {!running && (
          <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-line-2 bg-panel-3/95 px-4 py-2 text-xs text-muted shadow-lg">
            Click or press any key to enable sound
          </div>
        )}
      </main>
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </div>
  )
}
