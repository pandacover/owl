/**
 * Shot detection from FFmpeg's `scdet` filter output, plus keyframe planning.
 * Pure functions: input is the per-frame scene score and motion (MAFD).
 */
import type { Moment, Shot } from "../domain/Media.ts"

export interface FrameStat {
  readonly t: number
  /** Mean absolute frame difference, roughly 0 to 30 at our analysis size. */
  readonly mafd: number
  /** Scene change score 0 to 100. */
  readonly score: number
}

/** Parses the two files written by `metadata=mode=print:key=...` for mafd and score. */
/** Bump when shot or moment detection changes, so stored analyses are redone. */
export const DETECTOR = 2

export const parseSceneMetadata = (mafdText: string, scoreText: string): Array<FrameStat> => {
  const read = (text: string, key: string) => {
    const out = new Map<number, number>()
    let frame = -1
    let time = 0
    const times = new Map<number, number>()
    for (const line of text.split("\n")) {
      if (line.startsWith("frame:")) {
        const f = /frame:(\d+)/.exec(line)
        const t = /pts_time:([\d.eE+-]+)/.exec(line)
        frame = f ? Number(f[1]) : frame + 1
        time = t ? Number(t[1]) : time
        times.set(frame, time)
      } else if (line.startsWith(key)) {
        out.set(frame, Number(line.slice(key.length + 1)))
      }
    }
    return { values: out, times }
  }
  const mafd = read(mafdText, "lavfi.scd.mafd")
  const score = read(scoreText, "lavfi.scd.score")
  const frames: Array<FrameStat> = []
  for (const [frame, t] of mafd.times) {
    frames.push({ t, mafd: mafd.values.get(frame) ?? 0, score: score.values.get(frame) ?? 0 })
  }
  frames.sort((a, b) => a.t - b.t)
  return frames
}

const round3 = (n: number) => Math.round(n * 1000) / 1000

export interface ShotOptions {
  readonly threshold?: number
  readonly minShot?: number
}

/** Cuts are local score peaks above the threshold, at least `minShot` seconds apart. */
export const detectCuts = (frames: ReadonlyArray<FrameStat>, options: ShotOptions = {}): Array<number> => {
  const threshold = options.threshold ?? 10
  const minShot = options.minShot ?? 0.5
  const candidates: Array<{ t: number; score: number }> = []
  for (let i = 1; i < frames.length; i++) {
    const f = frames[i]!
    if (f.score < threshold) continue
    const prev = frames[i - 1]!.score
    const next = frames[i + 1]?.score ?? 0
    if (f.score >= prev && f.score >= next) candidates.push({ t: f.t, score: f.score })
  }
  // Strongest cuts first, so a weak cut next to a strong one is the one dropped.
  candidates.sort((a, b) => b.score - a.score)
  const end = frames.length ? frames[frames.length - 1]!.t : 0
  const chosen: Array<number> = []
  for (const c of candidates) {
    if (c.t < minShot || end - c.t < minShot) continue
    if (chosen.every((t) => Math.abs(t - c.t) >= minShot)) chosen.push(c.t)
  }
  return chosen.sort((a, b) => a - b)
}

const motionLabel = (mafd: number): Shot["motionLabel"] =>
  mafd < 0.5 ? "static" : mafd < 2 ? "low" : mafd < 6 ? "medium" : "high"

/** Keyframe times inside a shot: one for short shots, more for long ones. */
export const planKeyframes = (start: number, end: number): Array<number> => {
  const length = end - start
  const at = (fraction: number) => round3(start + length * fraction)
  if (length < 3) return [at(0.5)]
  if (length < 8) return [at(0.2), at(0.5), at(0.8)]
  const count = Math.min(6, Math.ceil(length / 4))
  return Array.from({ length: count }, (_, i) => at((i + 0.5) / count))
}

const MOMENT_ACTIVE = 0.8
/** A burst must peak this high, so compression noise is never a step. */
const MOMENT_PEAK = 2
const MOMENT_MIN = 0.8
const MOMENT_MAX = 12

/**
 * Splits a mostly still shot at bursts of change: screen recordings, slides,
 * tripod shots where something appears. Returns nothing when the shot is one
 * continuous scene, so ordinary camera footage keeps whole shots.
 *
 * Everything is weighted by time, not frame count: phone screen recordings
 * are variable frame rate and store frames mostly while the screen changes.
 */
export const detectMoments = (frames: ReadonlyArray<FrameStat>, start: number, end: number): Array<Moment> => {
  if (end - start < 2 * MOMENT_MIN + 0.5) return []
  const inside = frames.filter((f) => f.t > start + 0.05 && f.t < end - 0.02)
  if (inside.length < 4) return []
  // How long each frame stays on screen.
  const held = inside.map((f, i) => Math.max(0, Math.min(1, (inside[i + 1]?.t ?? end) - f.t)))
  const total = held.reduce((a, b) => a + b, 0)
  if (total <= 0) return []
  const byValue = inside.map((f, i) => ({ v: f.mafd, w: held[i]! })).sort((a, b) => a.v - b.v)
  let acc = 0
  const median = byValue.find((x) => (acc += x.w) >= total / 2)?.v ?? 0
  const active = Math.max(MOMENT_ACTIVE, median * 2.5)
  const activeTime = inside.reduce((sum, f, i) => sum + (f.mafd > active ? held[i]! : 0), 0)
  // Constant motion means camera footage, not discrete steps.
  if (activeTime / total > 0.6) return []
  const bursts: Array<{ start: number; end: number; peak: number }> = []
  for (const f of inside) {
    if (f.mafd <= active) continue
    const last = bursts[bursts.length - 1]
    if (last && f.t - last.end < 0.4) {
      last.end = f.t
      last.peak = Math.max(last.peak, f.mafd)
    } else bursts.push({ start: f.t, end: f.t, peak: f.mafd })
  }
  const candidates = bursts
    .filter((b) => b.peak >= Math.max(MOMENT_PEAK, median * 4))
    .filter((b) => b.start - start >= MOMENT_MIN * 0.8 && end - b.start >= MOMENT_MIN * 0.8)
    .sort((a, b) => b.peak - a.peak)
  const cuts: Array<{ t: number; settled: number }> = []
  for (const b of candidates) {
    if (cuts.length >= MOMENT_MAX - 1) break
    const t = Math.max(start, b.start - 0.05)
    if (cuts.every((c) => Math.abs(c.t - t) >= MOMENT_MIN)) cuts.push({ t, settled: b.end })
  }
  if (cuts.length === 0) return []
  cuts.sort((a, b) => a.t - b.t)
  const bounds = [{ t: start, settled: start }, ...cuts, { t: end, settled: end }]
  const moments: Array<Moment> = []
  for (let i = 0; i < bounds.length - 1; i++) {
    const s = bounds[i]!.t
    const e = bounds[i + 1]!.t
    const settled = Math.min(e - 0.1, Math.max(s, bounds[i]!.settled + 0.15))
    moments.push({ start: round3(s), end: round3(e), keyframe: round3(settled + (e - settled) * 0.5) })
  }
  return moments
}

export const buildShots = (
  frames: ReadonlyArray<FrameStat>,
  duration: number,
  options: ShotOptions = {}
): Array<Shot> => {
  const cuts = detectCuts(frames, options)
  const bounds = [0, ...cuts, duration]
  const shots: Array<Shot> = []
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i]!
    const end = bounds[i + 1]!
    if (end - start <= 0.01) continue
    // Skip the frames at the cut itself so the cut does not count as motion.
    // Weighted by how long each frame is shown, since phone recordings store frames mostly while things move.
    const inside = frames.filter((f) => f.t > start + 0.05 && f.t < end - 0.02)
    const held = inside.map((f, i) => Math.max(0, Math.min(1, (inside[i + 1]?.t ?? end) - f.t)))
    const heldTotal = held.reduce((a, b) => a + b, 0)
    const mafd = heldTotal > 0 ? inside.reduce((s, f, i) => s + f.mafd * held[i]!, 0) / heldTotal : 0
    const moments = detectMoments(frames, start, end)
    shots.push({
      index: shots.length + 1,
      start: round3(start),
      end: round3(end),
      motion: Math.round(Math.min(1, mafd / 10) * 100) / 100,
      motionLabel: motionLabel(mafd),
      keyframes: moments.length > 0 ? moments.map((m) => m.keyframe) : planKeyframes(start, end),
      ...(moments.length > 0 ? { moments } : {})
    })
  }
  return shots
}
