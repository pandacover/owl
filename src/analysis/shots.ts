/**
 * Shot detection from FFmpeg's `scdet` filter output, plus keyframe planning.
 * Pure functions: input is the per-frame scene score and motion (MAFD).
 */
import type { Shot } from "../domain/Media.ts"

export interface FrameStat {
  readonly t: number
  /** Mean absolute frame difference, roughly 0 to 30 at our analysis size. */
  readonly mafd: number
  /** Scene change score 0 to 100. */
  readonly score: number
}

/** Parses the two files written by `metadata=mode=print:key=...` for mafd and score. */
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
    const inside = frames.filter((f) => f.t > start + 0.05 && f.t < end - 0.02)
    const mafd = inside.length ? inside.reduce((s, f) => s + f.mafd, 0) / inside.length : 0
    shots.push({
      index: shots.length + 1,
      start: round3(start),
      end: round3(end),
      motion: Math.round(Math.min(1, mafd / 10) * 100) / 100,
      motionLabel: motionLabel(mafd),
      keyframes: planKeyframes(start, end)
    })
  }
  return shots
}
