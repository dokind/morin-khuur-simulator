import { engine } from './engine'
import { LivePerformer } from './performer'

let performer: LivePerformer | null = null

/** The Playground's performer, bound to the shared instrument. */
export function getPerformer(): LivePerformer {
  performer ??= new LivePerformer(engine.morinKhuur())
  return performer
}
