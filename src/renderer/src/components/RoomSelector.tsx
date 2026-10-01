import { ChevronRight } from 'lucide-react'
import { ROOMS, getRoom, type RoomId } from '@renderer/audio/room'

const SCENES: Record<RoomId, string> = {
  steppe: 'linear-gradient(180deg, #7fa7c9 0%, #b9cbd6 38%, #8a9a55 55%, #5d6b33 100%)',
  ger: 'radial-gradient(ellipse at 50% 110%, #f2e6cf 0%, #d9c6a2 35%, #7a5230 70%, #3b2615 100%)',
  hall: 'repeating-linear-gradient(90deg, #6b4222 0 14px, #7d5129 14px 28px), linear-gradient(#000, #000)',
  dry: 'linear-gradient(180deg, #2b2b2b, #151515)'
}

/** Scenic room card; click to cycle through the acoustic spaces. */
export function RoomSelector({ value, onChange }: { value: RoomId; onChange(id: RoomId): void }) {
  const room = getRoom(value)
  const next = () => {
    const i = ROOMS.findIndex((r) => r.id === value)
    onChange(ROOMS[(i + 1) % ROOMS.length]!.id)
  }
  return (
    <button
      type="button"
      onClick={next}
      title={`${room.description} Click for the next room.`}
      className="relative h-12 w-full max-w-60 overflow-hidden rounded-lg border border-line-2 text-left shadow-inner"
      style={{ background: SCENES[room.id] }}
      aria-label={`Room: ${room.name}. Click to change.`}
    >
      <span className="absolute inset-0 bg-linear-to-t from-black/60 via-black/10 to-transparent" />
      <span className="absolute inset-0 flex items-center justify-between px-4">
        <span className="text-[15px] font-semibold text-white drop-shadow">{room.name}</span>
        <ChevronRight className="h-5 w-5 text-white/90" />
      </span>
    </button>
  )
}
