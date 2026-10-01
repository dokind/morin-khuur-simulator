import { useEffect, useRef, useSyncExternalStore } from 'react'
import { engine } from '@renderer/audio/engine'

/** Runs `callback` every animation frame while mounted. The latest callback is always used. */
export function useAnimationFrame(callback: (dt: number) => void): void {
  const ref = useRef(callback)
  useEffect(() => {
    ref.current = callback
  })
  useEffect(() => {
    let id = 0
    let last = performance.now()
    const loop = (now: number) => {
      ref.current(now - last)
      last = now
      id = requestAnimationFrame(loop)
    }
    id = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(id)
  }, [])
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

/**
 * Global key handlers for instrument-style input: repeats are dropped and keys typed into form
 * fields are ignored. Handlers return true when they consumed the key (prevents default).
 */
export function useKeyboard(handlers: { down?(e: KeyboardEvent): boolean | void; up?(e: KeyboardEvent): boolean | void }): void {
  const ref = useRef(handlers)
  useEffect(() => {
    ref.current = handlers
  })
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.repeat || isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
      if (ref.current.down?.(e)) e.preventDefault()
    }
    const up = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return
      if (ref.current.up?.(e)) e.preventDefault()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])
}

/** True once the AudioContext is running. */
export function useAudioRunning(): boolean {
  return useSyncExternalStore(
    (cb) => engine.onStateChange(cb),
    () => engine.running
  )
}
