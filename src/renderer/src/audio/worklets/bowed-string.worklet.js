/**
 * Bowed horsehair string — digital waveguide with a friction bow junction
 * (McIntyre, Schumacher & Woodhouse 1983; structure after STK's Bowed by Cook & Scavone).
 *
 * Two delay lines carry velocity waves between the bow and the nut (neck side) and between the
 * bow and the bridge. The bow injects velocity through a nonlinear friction table, so stick-slip
 * (Helmholtz) motion, attack scratch and bow noise all emerge from the physics.
 *
 * Horsehair-specific: stronger loop damping than gut/steel, and "roughness" — the bundle of
 * ~100+ hairs never grips uniformly, modelled as band-limited noise on the bow velocity and a
 * slow random wander of the string length.
 *
 * Loaded as a Blob module (see ../dsp.ts); keep it dependency-free plain JS.
 */

const MAX_DELAY = 8192
const MAX_BOW_VELOCITY = 0.25
/** Samples of loop delay contributed by the junction structure (calibrated with YIN). */
const LOOP_OVERHEAD = 1.75
/** Integrator gain of the pitch lock, per measured period. */
const LOCK_GAIN = 0.1
/** Cycles of output compared when timing the waveform's period. */
const LOCK_PERIODS = 2
/**
 * Largest loop correction: 2.5 samples, and never more than 1.5% of the period (26 cents) — the
 * friction flattening it corrects is a few cents, and a trim beyond the 3% acceptance window
 * could never be measured back.
 */
const LOCK_RANGE = 2.5
/** Samples of bowing to ignore before locking (the attack transient). */
const LOCK_SETTLE = Math.round(0.06 * sampleRate)
/** Loss-filter cutoff in multiples of the fundamental. */
const BRIGHTNESS = 14
/**
 * Scale of the friction table's slope (5 − 4·force), i.e. the inverse of how hard the hair grips.
 * The regime depends only on bow speed × slope (the waveguide is linear, so scaling both leaves the
 * motion the same up to amplitude). Helmholtz motion is the only stable regime for speed × slope
 * between about 0.3 and 1.3 at the default contact point; below, the bow presses too hard, above
 * it too lightly and the string falls into double slip (the octave). Unscaled, every pulled stroke
 * sat at 1.1–1.4, on that edge, and hair noise decided whether a note flipped. Scaled, strokes sit
 * at 0.5–0.8; the steady spectrum and level are unchanged (bowed-string.test.ts).
 */
const GRIP = 0.55
/**
 * The hair can press no harder than the bow's speed allows (Schelleng's maximum bow force, in
 * proportion to the speed and in inverse proportion to the distance from the bridge): speed ×
 * slope never drops below FORCE_LIMIT × β, where the Helmholtz corner can always release the hair.
 * A slow bow then sustains the same motion as a faster one, scaled down (the regime depends only
 * on speed × slope), as a player drawing slowly lightens the bow. Pressed harder, a bow at a crawl
 * pinned the string: the short bridge side squeaked, and the nut side, which has no losses of its
 * own, kept its energy until the bow lifted and came back as a pop. The grip that first faded with
 * the speed below a tenth of full speed instead silenced every slow bow (bowed-string.test.ts).
 */
const FORCE_LIMIT = 1.1
/** Below this bow speed the bow has stopped: it leaves the string, which rings down on its own. */
const STOP_SPEED = 0.01
/**
 * Samples over which a landing bow takes the string over (from the output onwards, along the loop).
 * A bow set on the string with the hair pressed grips it and lets go once a period from the first
 * slip (Guettler's "perfect attack"): the string starts in Helmholtz motion at the bow's speed.
 * The friction model alone takes ~10 periods of double slip to find it at the default contact
 * point — an octave chirp on every attack, and sometimes a note that stays up an octave.
 */
const TAKEOVER = 64
/** The landing takes the string over only nearer the bridge than this contact point. */
const TAKEOVER_BETA = 0.25
/**
 * A landing bow takes the string over at LAND_SPEED; drawn slower, LAND_WAIT samples after it
 * reaches LAND_MIN, and a bow that stays slower than that after LAND_SLOW samples of moving. Taken
 * over at a crawl, the tiny Helmholtz motion does not always keep up with a bow still accelerating
 * fast (tens of milliseconds of octave on some attacks, and on a quarter of the male string's
 * bow-pad strokes drawn up to speed over 80 ms while the wait began as soon as the bow moved); from
 * about a tenth of full speed on, it always does, and a bow that stays at a crawl barely
 * accelerates. The note starts a few milliseconds later.
 */
const LAND_SPEED = 0.15
const LAND_MIN = 0.05
const LAND_WAIT = Math.round(0.006 * sampleRate)
const LAND_SLOW = Math.round(0.03 * sampleRate)

class BowedStringProcessor extends AudioWorkletProcessor {
  // Every minValue is 0 on purpose: Tone.js drives these params by zeroing their intrinsic value
  // and adding a signal, and Chromium clamps the intrinsic value to minValue first — a floor of
  // 20 Hz would make every note exactly 20 Hz sharp. Ranges are enforced in process() instead.
  static get parameterDescriptors() {
    return [
      { name: 'frequency', defaultValue: 233, minValue: 0, maxValue: 5000, automationRate: 'a-rate' },
      // Cents, for vibrato.
      { name: 'detune', defaultValue: 0, minValue: -2400, maxValue: 2400, automationRate: 'a-rate' },
      // Bow speed 0–1 (0 lifts the bow; the string then rings down freely).
      { name: 'velocity', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      // Bow force 0–1: low = slippery surface sound, high = gripping, raucous.
      { name: 'force', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      // Bow contact point as a fraction of string length from the bridge.
      { name: 'beta', defaultValue: 0.127, minValue: 0, maxValue: 0.5, automationRate: 'a-rate' },
      { name: 'roughness', defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      // Loop gain of the string filter; horsehair is lossier than gut or steel.
      { name: 'damping', defaultValue: 0.94, minValue: 0, maxValue: 0.999, automationRate: 'k-rate' }
    ]
  }

  constructor() {
    super()
    this.neck = new Float32Array(MAX_DELAY)
    this.bridge = new Float32Array(MAX_DELAY)
    this.w = 0
    this.neckOut = 0
    this.bridgeOut = 0
    this.lp = 0
    this.seed = 0x2545f491
    this.hairNoise = 0
    this.wander = 0
    this.wanderTarget = 0
    this.wanderCount = 0
    // Pitch lock: once a cycle (an upward zero crossing of the fundamental, isolated by two
    // cascaded band-passes) the waveform's period is timed on the recent output, and the
    // measured period drives a loop trim.
    this.bp = [new Float64Array(4), new Float64Array(4)]
    this.bpFreq = 0
    this.bpCoef = new Float64Array(5)
    this.prevY = 0
    this.hist = new Float32Array(MAX_DELAY)
    this.hw = 0
    this.diff = new Float64Array(5)
    this.lockFreq = 0
    this.error = 0
    this.trim = 0
    this.bowing = 0
    // The bow is off the string; samples it has been moving since, and at LAND_MIN or faster,
    // before it lands (LAND_SLOW, LAND_WAIT).
    this.lifted = true
    this.moving = 0
    this.landingWait = 0
  }

  /**
   * The landing bow takes the string over: the loop is set to Helmholtz motion with stick velocity
   * `V` (one corner; the bow point at the start of its stick phase), crossfaded from what the string
   * was doing over the TAKEOVER samples that reach the output first, so a ringing string does not
   * click. In the unfolded loop the Helmholtz velocity wave is a sawtooth of height V/β per period.
   */
  land(V, base, beta, period) {
    const dn = base * (1 - beta)
    const db = base * beta
    const height = -V / beta
    const saw = (u) => height * ((((u / period) % 1) + 1) % 1 - 0.5)
    // Distance (samples) along the loop until a stored sample reaches the output; the ones about to
    // be read (and their interpolation taps) keep their value.
    const weight = (p) => (p <= 4 ? 0 : p >= 4 + TAKEOVER ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * (p - 4)) / TAKEOVER))
    for (let d = 1; d <= Math.ceil(dn) + 4; d++) {
      const i = (this.w - d + MAX_DELAY) % MAX_DELAY
      const a = weight(dn - d + db)
      this.neck[i] += a * (saw(-d) - this.neck[i])
    }
    for (let d = 1; d <= Math.ceil(db) + 4; d++) {
      const i = (this.w - d + MAX_DELAY) % MAX_DELAY
      const a = weight(db - d)
      this.bridge[i] += a * (-saw(-d - dn) - this.bridge[i])
    }
  }

  /**
   * Period of the recent output near `target` samples: the lag minimising the squared difference
   * between the last LOCK_PERIODS cycles and the ones before (a YIN-style difference function at
   * five lags, with parabolic interpolation). -1 if there is no clear minimum.
   *
   * It times the whole waveform, which is what the ear hears as pitch. The band-passed
   * fundamental alone runs several cents flat of it while Helmholtz motion builds up, and more
   * on the rough male string; locking that made low notes start up to 15 cents sharp.
   */
  periodicity(target) {
    const mask = MAX_DELAY - 1
    const t0 = Math.round(target)
    const n = Math.min(2048, Math.max(64, Math.round(target * LOCK_PERIODS)))
    const h = this.hist
    const end = this.hw - 1
    for (let k = 0; k < 5; k++) {
      const lag = t0 + k - 2
      let sum = 0
      for (let i = 0; i < n; i++) {
        const q = h[(end - i) & mask] - h[(end - i - lag) & mask]
        sum += q * q
      }
      this.diff[k] = sum
    }
    let j = 1
    for (let k = 2; k <= 3; k++) if (this.diff[k] < this.diff[j]) j = k
    const a = this.diff[j - 1]
    const b = this.diff[j]
    const c = this.diff[j + 1]
    const den = a - 2 * b + c
    if (!(den > 0)) return -1
    return t0 + j - 2 + (a - c) / (2 * den)
  }

  bandpass(x, f) {
    if (Math.abs(f - this.bpFreq) > f * 0.0005) {
      // RBJ constant-peak band-pass, Q = 3.
      const w0 = (2 * Math.PI * f) / sampleRate
      const alpha = Math.sin(w0) / 6
      const a0 = 1 + alpha
      const c = this.bpCoef
      c[0] = alpha / a0
      c[1] = 0
      c[2] = -alpha / a0
      c[3] = (-2 * Math.cos(w0)) / a0
      c[4] = (1 - alpha) / a0
      this.bpFreq = f
    }
    const c = this.bpCoef
    let y = x
    for (const st of this.bp) {
      // st: x1, x2, y1, y2
      const out = c[0] * y + c[1] * st[0] + c[2] * st[1] - c[3] * st[2] - c[4] * st[3]
      st[1] = st[0]
      st[0] = y
      st[3] = st[2]
      st[2] = out
      y = out
    }
    return y
  }

  random() {
    // xorshift32 → [-1, 1)
    let x = this.seed
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.seed = x >>> 0
    return (this.seed / 4294967296) * 2 - 1
  }

  read(buf, delay) {
    // Sample written `delay` ticks ago, by cubic Lagrange interpolation. Linear interpolation
    // low-passes twice per round trip — on short, high strings that erases the upper harmonics.
    let r = this.w - 1 - Math.max(2, delay)
    while (r < 1) r += MAX_DELAY
    const i = Math.floor(r)
    const d = r - i
    const x0 = buf[(i - 1) % MAX_DELAY]
    const x1 = buf[i % MAX_DELAY]
    const x2 = buf[(i + 1) % MAX_DELAY]
    const x3 = buf[(i + 2) % MAX_DELAY]
    const dm1 = d - 1
    const dm2 = d - 2
    const dp1 = d + 1
    return (-d * dm1 * dm2 * x0) / 6 + (dp1 * dm1 * dm2 * x1) / 2 - (dp1 * d * dm2 * x2) / 2 + (dp1 * d * dm1 * x3) / 6
  }

  process(_inputs, outputs, params) {
    const out = outputs[0][0]
    if (!out) return true
    const freq = params.frequency
    const detune = params.detune
    const velocity = params.velocity
    // Force and contact point are a-rate, so a stroke's own values hold from the sample its bow
    // lands on. Read once per render quantum, a landing a few samples in took the string over at
    // the previous stroke's contact point, and the jump at the next quantum scrambled the motion.
    const force = params.force
    const contact = params.beta
    const rough = params.roughness[0]
    const damping = params.damping[0]

    // Idle: bow lifted and the string has rung down — skip the maths.
    if (velocity.length === 1 && velocity[0] <= 1e-5 && Math.abs(this.neckOut) + Math.abs(this.bridgeOut) + Math.abs(this.lp) < 1e-9) {
      this.lifted = true
      out.fill(0)
      return true
    }

    for (let i = 0; i < out.length; i++) {
      const f = Math.max(20, (freq.length > 1 ? freq[i] : freq[0]) * Math.pow(2, (detune.length > 1 ? detune[i] : detune[0]) / 1200))
      const v = velocity.length > 1 ? velocity[i] : velocity[0]
      const beta = Math.min(0.5, Math.max(0.02, contact.length > 1 ? contact[i] : contact[0]))
      const slope = Math.max((5 - 4 * (force.length > 1 ? force[i] : force[0])) * GRIP, (FORCE_LIMIT * beta) / Math.max(v, 1e-6))

      // Loop length: the period minus the string filter's phase delay and the junction's unit
      // delays (measured: 1.75 samples net of interpolation), so the model sounds at exactly `f`.
      // String losses: a one-pole low-pass whose cutoff tracks the pitch (~BRIGHTNESS harmonics),
      // so short, high strings aren't damped far harder per second than long, low ones.
      const pole = Math.min(0.8, Math.max(0.15, Math.exp((-2 * Math.PI * BRIGHTNESS * f) / sampleRate)))
      const gain = damping * (1 - pole)
      const w = (2 * Math.PI * f) / sampleRate
      const filterDelay = Math.atan2(pole * Math.sin(w), 1 - pole * Math.cos(w)) / w
      // Slow random wander of effective length: the hairs share the load unevenly.
      if (--this.wanderCount <= 0) {
        this.wanderTarget = this.random() * 0.06 * rough
        this.wanderCount = 2048
      }
      this.wander += (this.wanderTarget - this.wander) * 0.0005
      const target = sampleRate / f
      const base = Math.max(4, target - LOOP_OVERHEAD - filterDelay + this.wander - this.trim)

      // The bow leaves the string when it stops, and lands when it moves again, taking the string
      // over once it is up to speed (LAND_SPEED, LAND_WAIT or LAND_SLOW). A quarter of the string
      // or more from the bridge (no contact point BowedVoice uses) the friction model finds
      // Helmholtz motion within a period by itself, and imposing it there sometimes locks the
      // string onto its octave instead: there the grip comes in with the speed.
      if (v < STOP_SPEED) {
        this.lifted = true
        this.moving = 0
        this.landingWait = 0
      } else if (this.lifted) {
        if (beta >= TAKEOVER_BETA) this.lifted = false
        else if (v >= LAND_SPEED || (v >= LAND_MIN && ++this.landingWait >= LAND_WAIT) || ++this.moving >= LAND_SLOW) {
          this.lifted = false
          this.land(v * MAX_BOW_VELOCITY, base, beta, target)
        }
      }
      const bowed = v > 1e-5 && !this.lifted

      // Reflections: lossy, inverting at the bridge; inverting at the nut.
      this.lp = gain * this.bridgeOut + pole * this.lp
      const bridgeRefl = -this.lp
      const nutRefl = -this.neckOut
      const stringVel = bridgeRefl + nutRefl

      let newVel = 0
      if (bowed) {
        // Hair roughness: band-limited noise on the bow velocity.
        this.hairNoise += (this.random() - this.hairNoise) * 0.35
        const bowVel = v * MAX_BOW_VELOCITY * (1 + rough * 0.6 * this.hairNoise)
        const dv = bowVel - stringVel
        let friction = Math.pow(Math.abs(dv * slope) + 0.75, -4)
        if (friction > 1) friction = 1
        newVel = dv * friction
      }

      this.neck[this.w] = bridgeRefl + newVel
      this.bridge[this.w] = nutRefl + newVel
      this.w = (this.w + 1) % MAX_DELAY

      this.neckOut = this.read(this.neck, base * (1 - beta))
      this.bridgeOut = this.read(this.bridge, base * beta)
      out[i] = this.bridgeOut
      this.hist[this.hw] = this.bridgeOut
      this.hw = (this.hw + 1) & (MAX_DELAY - 1)

      // Pitch lock. Bow friction delays the Helmholtz corner, so a bowed string sounds slightly
      // flat — more on short, high strings and with more bow force (real strings do the same).
      // Timing the waveform and trimming the loop keeps notes in tune at any force or tuning.
      const y = this.bandpass(this.bridgeOut, f)
      this.bowing = bowed ? this.bowing + 1 : 0
      if (this.prevY < 0 && y >= 0) {
        // Settled bowing at a steady pitch only: skip the attack, and hold the trim while the
        // pitch moves (vibrato, slides), whose period the recent cycles cannot show yet.
        const steady = Math.abs(f - this.lockFreq) < f * 0.001
        this.lockFreq = f
        if (!steady) this.error = 0
        else if (this.bowing > LOCK_SETTLE) {
          const measured = this.periodicity(target)
          // Only periods within 3% of the target: the correction needed is a fraction of a
          // sample, so anything wider is a jump or noise.
          if (measured > 0 && Math.abs(measured - target) < 0.03 * target) {
            this.error = this.error * 0.8 + (measured - target) * 0.2
            const range = Math.min(LOCK_RANGE, 0.015 * target)
            this.trim = Math.max(-range, Math.min(range, this.trim + LOCK_GAIN * this.error))
          }
        }
      }
      this.prevY = y
      if (!bowed) this.error = 0
    }
    return true
  }
}

registerProcessor('mkhuur-bowed-string', BowedStringProcessor)
