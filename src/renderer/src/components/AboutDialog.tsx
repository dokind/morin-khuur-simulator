import { X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { PROJECT_REPO_URL, UNESCO_URL } from '@shared/project'
import { bridge, openExternal } from '@renderer/platform'
import { Logo } from './Logo'

export function AboutDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-[560px] rounded-2xl border border-line-2 bg-panel-2 p-0 text-text backdrop:bg-black/70"
      aria-labelledby="about-title"
    >
      <div className="flex items-start gap-4 p-6">
        <Logo size={56} />
        <div className="flex-1">
          <h2 id="about-title" className="text-xl font-bold">
            Morin Khuur Simulator
          </h2>
          <p className="text-sm text-muted">Морин хуурын онлайн симулятор · open-source cultural heritage project</p>
        </div>
        <button type="button" className="rounded-lg p-1 text-muted hover:text-text" onClick={onClose} aria-label="Close">
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="space-y-3 px-6 pb-6 text-sm leading-relaxed text-text/90">
        <p>
          The Morin Khuur (horsehead fiddle) is inscribed by UNESCO as Intangible Cultural Heritage of Humanity. This free simulator helps
          preserve and share its sound and playing techniques: two hovering horsehair strings stopped from the side, the underhand bow,
          tsatsal harmonics, galloping rhythms and the horse whinny.
        </p>
        <p className="text-muted">
          All sounds are synthesised in real time by a physical model — a bowed horsehair string (digital waveguide with bow friction)
          driving a modal model of the soundbox, tuned from published acoustic measurements of the instrument. No recorded samples are
          used yet.
          Musicians, teachers and researchers are warmly invited to contribute recordings, song transcriptions and corrections.
        </p>
        <div className="flex flex-wrap gap-2 pt-2">
          <button type="button" className="btn" onClick={() => openExternal(UNESCO_URL)}>
            UNESCO: Traditional music of the Morin Khuur
          </button>
          {PROJECT_REPO_URL && (
            <button type="button" className="btn" onClick={() => openExternal(PROJECT_REPO_URL)}>
              Source code
            </button>
          )}
        </div>
        <p className="pt-2 text-xs text-faint">
          MIT licensed · {bridge ? `Electron ${bridge.versions.electron} · Chromium ${bridge.versions.chrome}` : 'Browser preview'}
        </p>
      </div>
    </dialog>
  )
}
