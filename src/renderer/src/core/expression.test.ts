import { describe, expect, it } from 'vitest'
import { EXPRESSION, legatoGlideSeconds } from './expression'

describe('legato glides', () => {
  it('makes wider legato slides take longer, up to a cap', () => {
    expect(legatoGlideSeconds(60, 62)).toBeLessThan(legatoGlideSeconds(60, 67))
    expect(legatoGlideSeconds(62, 60)).toBe(legatoGlideSeconds(60, 62))
    expect(legatoGlideSeconds(50, 80)).toBe(EXPRESSION.glideMax)
    expect(legatoGlideSeconds(60, 60)).toBe(EXPRESSION.glideBase)
  })
})
