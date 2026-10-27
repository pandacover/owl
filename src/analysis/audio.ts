/**
 * Audio analysis on mono 16-bit PCM: loudness, silences, onsets, tempo, beats.
 *
 * Pure functions with no Effect dependencies, so they can run in a worker
 * thread without blocking the server. The beat tracker is the dynamic
 * programming method from Ellis (2007), "Beat Tracking by Dynamic Programming".
 */
import type { AudioAnalysis, AudioSection } from "../domain/Media.ts"

export const PCM_SAMPLE_RATE = 22050

const LOUDNESS_HOP = 0.1
const SILENCE_HOP = 0.05
const FLOOR_DB = -90

const percentile = (values: ArrayLike<number>, p: number): number => {
  if (values.length === 0) return FLOOR_DB
  const sorted = Float64Array.from(values).sort()
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))
  return sorted[index]!
}

const rmsDb = (samples: Float32Array, hopSeconds: number, sampleRate: number): Float32Array => {
  const hop = Math.max(1, Math.round(hopSeconds * sampleRate))
  const frames = Math.ceil(samples.length / hop)
  const out = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    const start = f * hop
    const end = Math.min(samples.length, start + hop)
    for (let i = start; i < end; i++) sum += samples[i]! * samples[i]!
    const rms = Math.sqrt(sum / Math.max(1, end - start))
    out[f] = Math.max(FLOOR_DB, 20 * Math.log10(rms + 1e-12))
  }
  return out
}

/** Spans quieter than an adaptive threshold for at least `minDuration` seconds. */
export const findSilences = (
  db: Float32Array,
  hopSeconds: number,
  minDuration = 0.3
): Array<readonly [number, number]> => {
  const loud = percentile(db, 0.9)
  const floor = percentile(db, 0.05)
  // Somewhere between the noise floor and the content level, kept in a sane range.
  const threshold = Math.min(-28, Math.max(-60, Math.max(floor + 8, loud - 26)))
  const silences: Array<readonly [number, number]> = []
  let runStart = -1
  for (let i = 0; i <= db.length; i++) {
    const quiet = i < db.length && db[i]! < threshold
    if (quiet && runStart < 0) runStart = i
    if (!quiet && runStart >= 0) {
      const start = runStart * hopSeconds
      const end = i * hopSeconds
      if (end - start >= minDuration) silences.push([round3(start), round3(end)])
      runStart = -1
    }
  }
  return silences
}

const round3 = (n: number) => Math.round(n * 1000) / 1000
const round1 = (n: number) => Math.round(n * 10) / 10

// Radix-2 FFT with precomputed tables, for one fixed size.
class Fft {
  readonly cos: Float64Array
  readonly sin: Float64Array
  readonly rev: Uint32Array
  readonly n: number
  constructor(n: number) {
    this.n = n
    this.cos = new Float64Array(n / 2)
    this.sin = new Float64Array(n / 2)
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / n)
      this.sin[i] = Math.sin((-2 * Math.PI * i) / n)
    }
    this.rev = new Uint32Array(n)
    const bits = Math.log2(n)
    for (let i = 0; i < n; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.rev[i] = r
    }
  }
  /** In-place transform of (re, im). */
  transform(re: Float64Array, im: Float64Array) {
    const n = this.n
    for (let i = 0; i < n; i++) {
      const j = this.rev[i]!
      if (j > i) {
        const tr = re[i]!
        re[i] = re[j]!
        re[j] = tr
        const ti = im[i]!
        im[i] = im[j]!
        im[j] = ti
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1
      const step = n / size
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const a = start + k
          const b = a + half
          const wr = this.cos[k * step]!
          const wi = this.sin[k * step]!
          const xr = re[b]! * wr - im[b]! * wi
          const xi = re[b]! * wi + im[b]! * wr
          re[b] = re[a]! - xr
          im[b] = im[a]! - xi
          re[a] = re[a]! + xr
          im[a] = im[a]! + xi
        }
      }
    }
  }
}

export interface OnsetEnvelope {
  readonly values: Float32Array
  readonly hopSeconds: number
}

/** Log-magnitude spectral flux, computed at half the PCM rate for speed. */
export const onsetEnvelope = (samples: Float32Array, sampleRate: number): OnsetEnvelope => {
  const decimated = new Float32Array(Math.floor(samples.length / 2))
  for (let i = 0; i < decimated.length; i++) decimated[i] = (samples[2 * i]! + samples[2 * i + 1]!) * 0.5
  const rate = sampleRate / 2
  const n = 512
  const hop = 128
  const fft = new Fft(n)
  const window = new Float64Array(n)
  for (let i = 0; i < n; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
  const bins = n / 2
  const frames = Math.max(0, Math.floor((decimated.length - n) / hop) + 1)
  const values = new Float32Array(frames)
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  let previous = new Float64Array(bins)
  let current = new Float64Array(bins)
  for (let f = 0; f < frames; f++) {
    const offset = f * hop
    for (let i = 0; i < n; i++) {
      re[i] = decimated[offset + i]! * window[i]!
      im[i] = 0
    }
    fft.transform(re, im)
    let flux = 0
    for (let k = 1; k < bins; k++) {
      const mag = Math.log1p(100 * Math.hypot(re[k]!, im[k]!))
      current[k] = mag
      const diff = mag - previous[k]!
      if (diff > 0 && f > 0) flux += diff
    }
    values[f] = flux
    const swap = previous
    previous = current
    current = swap
  }
  // Remove the slowly varying part so only sharp attacks remain.
  const smoothed = movingAverage(values, Math.round(0.4 / (hop / rate)))
  for (let i = 0; i < frames; i++) values[i] = Math.max(0, values[i]! - smoothed[i]!)
  const std = Math.sqrt(values.reduce((s, v) => s + v * v, 0) / Math.max(1, frames)) || 1
  for (let i = 0; i < frames; i++) values[i] = values[i]! / std
  return { values, hopSeconds: hop / rate }
}

const movingAverage = (values: Float32Array, radius: number): Float32Array => {
  const out = new Float32Array(values.length)
  let sum = 0
  let count = 0
  let lo = 0
  let hi = -1
  for (let i = 0; i < values.length; i++) {
    const wantHi = Math.min(values.length - 1, i + radius)
    const wantLo = Math.max(0, i - radius)
    while (hi < wantHi) {
      hi++
      sum += values[hi]!
      count++
    }
    while (lo < wantLo) {
      sum -= values[lo]!
      count--
      lo++
    }
    out[i] = sum / Math.max(1, count)
  }
  return out
}

export interface TempoEstimate {
  readonly bpm: number
  readonly periodFrames: number
  readonly confidence: number
}

/**
 * Autocorrelation of the onset envelope, weighted toward a typical tempo.
 * Between a tempo and its double, the slower one wins when both correlate
 * similarly, because cutting on every eighth note is rarely what an editor wants.
 */
export const estimateTempo = (envelope: OnsetEnvelope): TempoEstimate | undefined => {
  const { values, hopSeconds } = envelope
  if (values.length < Math.round(4 / hopSeconds)) return undefined
  const minLag = Math.floor(60 / 200 / hopSeconds)
  const maxLag = Math.ceil(60 / 55 / hopSeconds)
  let mean = 0
  for (const v of values) mean += v
  mean /= values.length
  const centered = Float64Array.from(values, (v) => v - mean)
  let ac0 = 0
  for (const v of centered) ac0 += v * v
  if (ac0 <= 0) return undefined
  const limit = Math.min(2 * maxLag, centered.length - 1)
  const acs = new Float64Array(limit + 1)
  for (let lag = Math.max(1, Math.floor(minLag / 2)); lag <= limit; lag++) {
    let ac = 0
    for (let i = lag; i < centered.length; i++) ac += centered[i]! * centered[i - lag]!
    acs[lag] = ac / ac0
  }
  let best = -1
  let bestScore = -Infinity
  for (let lag = minLag; lag <= Math.min(maxLag, limit); lag++) {
    const bpm = 60 / (lag * hopSeconds)
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 115) / 0.7) ** 2)
    const score = acs[lag]! * prior
    if (score > bestScore) {
      bestScore = score
      best = lag
    }
  }
  if (best < 0) return undefined
  const bpmOf = (lag: number) => 60 / (lag * hopSeconds)
  if (bpmOf(best) > 150 && 2 * best <= limit && acs[2 * best]! >= 0.75 * acs[best]!) best = 2 * best
  // Parabolic interpolation for a sub-frame period.
  const y0 = acs[best - 1] ?? acs[best]!
  const y1 = acs[best]!
  const y2 = acs[best + 1] ?? acs[best]!
  const denom = y0 - 2 * y1 + y2
  const shift = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0
  const period = best + shift
  return { bpm: 60 / (period * hopSeconds), periodFrames: period, confidence: Math.max(0, Math.min(1, acs[best]!)) }
}

/** Beat times by dynamic programming over the onset envelope. */
export const trackBeats = (envelope: OnsetEnvelope, periodFrames: number, tightness = 100): Array<number> => {
  const { values, hopSeconds } = envelope
  const n = values.length
  if (n === 0) return []
  const score = new Float64Array(n)
  const backlink = new Int32Array(n).fill(-1)
  const lo = Math.round(periodFrames / 2)
  const hi = Math.round(periodFrames * 2)
  for (let t = 0; t < n; t++) {
    let bestPrev = -1
    let bestValue = 0
    for (let prev = t - hi; prev <= t - lo; prev++) {
      if (prev < 0) continue
      const ratio = Math.log((t - prev) / periodFrames)
      const value = score[prev]! - tightness * ratio * ratio
      if (bestPrev < 0 || value > bestValue) {
        bestValue = value
        bestPrev = prev
      }
    }
    score[t] = values[t]! + (bestPrev >= 0 ? Math.max(0, bestValue) : 0)
    backlink[t] = bestPrev >= 0 && bestValue > 0 ? bestPrev : -1
  }
  // Start from the best score in the last period, then follow links back.
  let end = n - 1
  for (let t = Math.max(0, n - Math.round(periodFrames)); t < n; t++) if (score[t]! > score[end]!) end = t
  const beats: Array<number> = []
  for (let t = end; t >= 0; t = backlink[t]!) {
    beats.push(t)
    if (backlink[t]! < 0) break
  }
  beats.reverse()
  // Trim weak beats at the edges, where the tracker tends to invent beats in silence.
  const strengths = beats.map((b) => localMax(values, b, 2))
  const median = percentile(strengths, 0.5)
  let first = 0
  let last = beats.length - 1
  while (first < last && strengths[first]! < median * 0.2) first++
  while (last > first && strengths[last]! < median * 0.2) last--
  return beats.slice(first, last + 1).map((b) => round3(b * hopSeconds))
}

const localMax = (values: Float32Array, index: number, radius: number): number => {
  let m = 0
  for (let i = Math.max(0, index - radius); i <= Math.min(values.length - 1, index + radius); i++) {
    m = Math.max(m, values[i]!)
  }
  return m
}

/** Picks the beat phase whose beats carry the most energy as bar starts (4/4). */
export const pickDownbeats = (beats: ReadonlyArray<number>, envelope: OnsetEnvelope): Array<number> => {
  if (beats.length < 8) return []
  let bestPhase = 0
  let bestEnergy = -1
  for (let phase = 0; phase < 4; phase++) {
    let energy = 0
    for (let i = phase; i < beats.length; i += 4) {
      energy += localMax(envelope.values, Math.round(beats[i]! / envelope.hopSeconds), 2)
    }
    if (energy > bestEnergy) {
      bestEnergy = energy
      bestPhase = phase
    }
  }
  return beats.filter((_, i) => i % 4 === bestPhase % 4)
}

/** Strong isolated onsets, good spots for hard cuts or text pops. */
export const findAccents = (envelope: OnsetEnvelope, limit = 40): Array<number> => {
  const { values, hopSeconds } = envelope
  const peaks: Array<{ t: number; v: number }> = []
  const gap = Math.round(0.25 / hopSeconds)
  for (let i = 1; i < values.length - 1; i++) {
    const v = values[i]!
    if (v < 2.5 || v < values[i - 1]! || v < values[i + 1]!) continue
    peaks.push({ t: i, v })
  }
  peaks.sort((a, b) => b.v - a.v)
  const chosen: Array<number> = []
  for (const peak of peaks) {
    if (chosen.length >= limit) break
    if (chosen.every((c) => Math.abs(c - peak.t) >= gap)) chosen.push(peak.t)
  }
  return chosen.sort((a, b) => a - b).map((t) => round3(t * hopSeconds))
}

/** Bump when the audio analysis changes, so stored analyses are redone. */
export const AUDIO_VERSION = 2

const SECTION_MIN = 8
const SECTION_WINDOW = 8
const SECTION_GAP = 1.5

const smooth = (values: ReadonlyArray<number>, radius: number): Array<number> =>
  values.map((_, i) => {
    let sum = 0
    let n = 0
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) {
      sum += values[j]!
      n++
    }
    return sum / n
  })

const mean = (values: ReadonlyArray<number>, from: number, to: number) => {
  let sum = 0
  let n = 0
  for (let i = Math.max(0, from); i < Math.min(values.length, to); i++) {
    sum += values[i]!
    n++
  }
  return n > 0 ? sum / n : 0
}

/**
 * Splits a track into parts by energy, one value per second from loudness and
 * onset density, each scaled against the track's own range. Long pauses (the
 * break between movements) always end a part; inside, a part ends where the
 * next stretch is clearly calmer or busier than the last.
 */
export const findSections = (
  loudness: ArrayLike<number>,
  loudnessHop: number,
  envelope: OnsetEnvelope,
  silences: ReadonlyArray<readonly [number, number]>,
  duration: number
): { sections: Array<AudioSection>; rises: Array<number> } => {
  const seconds = Math.floor(duration)
  if (seconds < 20) return { sections: [], rises: [] }
  const perL = Math.round(1 / loudnessHop)
  const perE = Math.round(1 / envelope.hopSeconds)
  const loud: Array<number> = []
  const busy: Array<number> = []
  for (let s = 0; s < seconds; s++) {
    let l = 0
    for (let i = s * perL; i < (s + 1) * perL && i < loudness.length; i++) l += Math.pow(10, loudness[i]! / 10)
    loud.push(10 * Math.log10(Math.max(1e-9, l / perL)))
    let e = 0
    for (let i = s * perE; i < (s + 1) * perE && i < envelope.values.length; i++) e += envelope.values[i]!
    busy.push(e / perE)
  }
  const quiet = (s: number) => silences.some(([a, b]) => b - a >= SECTION_GAP && s + 0.5 >= a && s + 0.5 <= b)
  const audible = loud.map((_, s) => s).filter((s) => !quiet(s))
  const scale = (values: Array<number>) => {
    const picked = audible.map((s) => values[s]!)
    const lo = percentile(picked, 0.05)
    const hi = percentile(picked, 0.95)
    return values.map((v) => Math.min(1, Math.max(0, (v - lo) / Math.max(1e-6, hi - lo))))
  }
  const l = scale(loud)
  const b = scale(busy)
  const energy = smooth(l.map((v, i) => 0.5 * v + 0.5 * b[i]!), 2)

  // Regions between long pauses.
  const regions: Array<[number, number]> = []
  let open: number | undefined
  for (let s = 0; s <= seconds; s++) {
    const inside = s < seconds && !quiet(s)
    if (inside && open === undefined) open = s
    if (!inside && open !== undefined) {
      regions.push([open, s])
      open = undefined
    }
  }

  const novelty = (i: number, w: number) => mean(energy, i, i + w) - mean(energy, i - w, i)
  const cutsIn = (from: number, to: number, threshold: number) => {
    const peaks: Array<{ at: number; v: number }> = []
    for (let i = from + SECTION_MIN; i <= to - SECTION_MIN; i++) {
      const v = Math.abs(novelty(i, Math.min(SECTION_WINDOW, i - from, to - i)))
      if (v >= threshold && v >= Math.abs(novelty(i - 1, SECTION_WINDOW)) && v >= Math.abs(novelty(i + 1, SECTION_WINDOW))) {
        peaks.push({ at: i, v })
      }
    }
    peaks.sort((x, y) => y.v - x.v)
    const chosen: Array<number> = []
    for (const p of peaks) if (chosen.every((c) => Math.abs(c - p.at) >= SECTION_MIN)) chosen.push(p.at)
    return chosen.sort((x, y) => x - y)
  }

  const build = (threshold: number) => {
    const out: Array<AudioSection> = []
    for (const [from, to] of regions) {
      if (to - from < 2) continue
      const edges = [from, ...cutsIn(from, to, threshold), to]
      for (let k = 0; k < edges.length - 1; k++) {
        const s = edges[k]!
        const e = edges[k + 1]!
        const third = Math.max(1, Math.floor((e - s) / 3))
        const slope = mean(energy, e - third, e) - mean(energy, s, s + third)
        let peak = s
        for (let i = s; i < e; i++) if (energy[i]! > energy[peak]!) peak = i
        out.push({
          start: s,
          end: e,
          energy: Math.round(mean(energy, s, e) * 100) / 100,
          peak,
          trend: e - s >= 12 && slope > 0.18 ? "builds" : e - s >= 12 && slope < -0.18 ? "fades" : "steady"
        })
      }
    }
    return out
  }
  let threshold = 0.14
  let sections = build(threshold)
  while (sections.length > 14 && threshold < 0.6) sections = build(threshold += 0.04)
  sections = sections.map((x) => ({ ...x, start: round3(x.start), end: round3(Math.min(duration, x.end === seconds ? duration : x.end)) }))

  // Sharpest short-range jumps up, at least 20s apart.
  const jumps: Array<{ at: number; v: number }> = []
  for (let i = 3; i < seconds - 3; i++) {
    if (quiet(i)) continue
    // Compare with the last sounding seconds, so a loud part after a pause counts as a rise.
    const before: Array<number> = []
    for (let j = i - 1; j >= 0 && before.length < 3; j--) if (!quiet(j)) before.push(energy[j]!)
    if (before.length === 0) continue
    const v = mean(energy, i, i + 3) - before.reduce((x, y) => x + y, 0) / before.length
    if (v > 0.2) jumps.push({ at: i, v })
  }
  jumps.sort((x, y) => y.v - x.v)
  const rises: Array<number> = []
  for (const j of jumps) {
    if (rises.length >= 6) break
    if (rises.every((r) => Math.abs(r - j.at) >= 20)) rises.push(j.at)
  }
  // Snap each rise to the strongest attack in the second around it.
  const snapped = rises.map((r) => {
    let best = r * perE
    for (let i = Math.max(0, (r - 1) * perE); i < Math.min(envelope.values.length, (r + 1) * perE); i++) {
      if (envelope.values[i]! > envelope.values[best]!) best = i
    }
    return round3(best * envelope.hopSeconds)
  })
  return { sections, rises: snapped.sort((x, y) => x - y) }
}

/** Full analysis. `pcm` is mono signed 16-bit little-endian at `sampleRate`. */
export const analyzeAudio = (pcm: Int16Array, sampleRate = PCM_SAMPLE_RATE): AudioAnalysis => {
  const samples = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i]! / 32768

  const loudness = rmsDb(samples, LOUDNESS_HOP, sampleRate)
  const fine = rmsDb(samples, SILENCE_HOP, sampleRate)
  const peakDb = loudness.length ? Math.max(...loudness) : FLOOR_DB
  const audible = Array.from(loudness).filter((v) => v > -60)
  const meanDb = audible.length ? audible.reduce((a, b) => a + b, 0) / audible.length : FLOOR_DB

  if (peakDb < -55) {
    return {
      kind: "silent",
      hop: LOUDNESS_HOP,
      loudness: Array.from(loudness, round1),
      meanDb: round1(meanDb),
      peakDb: round1(peakDb),
      silences: [[0, round3(samples.length / sampleRate)]],
      tempoConfidence: 0,
      beats: [],
      downbeats: [],
      accents: []
    }
  }

  const silences = findSilences(fine, SILENCE_HOP)
  const envelope = onsetEnvelope(samples, sampleRate)
  const tempo = estimateTempo(envelope)
  // Rhythmic audio (music) has a clear autocorrelation peak; speech does not.
  const rhythmic = tempo !== undefined && tempo.confidence >= 0.12
  const beats = rhythmic && tempo ? trackBeats(envelope, tempo.periodFrames) : []
  const { sections, rises } = findSections(loudness, LOUDNESS_HOP, envelope, silences, samples.length / sampleRate)
  return {
    kind: rhythmic ? "music" : "sound",
    hop: LOUDNESS_HOP,
    loudness: Array.from(loudness, round1),
    meanDb: round1(meanDb),
    peakDb: round1(peakDb),
    silences,
    tempo: tempo && rhythmic ? round1(tempo.bpm) : undefined,
    tempoConfidence: tempo ? Math.round(tempo.confidence * 100) / 100 : 0,
    beats,
    downbeats: rhythmic ? pickDownbeats(beats, envelope) : [],
    accents: findAccents(envelope),
    ...(sections.length > 0 ? { sections, rises } : {})
  }
}
