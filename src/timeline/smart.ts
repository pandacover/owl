import type { Analysis } from "../domain/Media.ts"
import { round3 } from "../domain/Time.ts"
import { placeMain, type Timeline } from "../domain/Timeline.ts"
import type { ClipInput, EditOp } from "./Ops.ts"

/**
 * Edits computed from analysis. Each returns ordinary edit operations, so the
 * result goes through the same engine, history and undo as a manual edit.
 */

export interface Range {
  readonly start: number
  readonly end: number
}

/** Maps source ranges of each main clip's media to timeline ranges, merged and sorted. */
const toTimeline = (
  timeline: Timeline,
  sourceRanges: (mediaId: string) => ReadonlyArray<Range>,
  clipIds: ReadonlyArray<string> | undefined,
  minLength: number,
  /** Shrinks each range on any side that does not touch a clip edge. */
  padding = 0
): Array<Range> => {
  const out: Array<Range> = []
  for (const p of placeMain(timeline.main)) {
    if (clipIds && !clipIds.includes(p.clip.id)) continue
    const c = p.clip
    if (c.freeze !== undefined) continue
    // Keep transition overlaps intact: only cut inside the part of the clip that plays alone.
    const lead = p.index > 0 && c.transition ? c.transition.duration : 0
    const next = timeline.main[p.index + 1]
    const tail = next?.transition ? next.transition.duration : 0
    const lo = c.in + lead * c.speed
    const hi = c.out - tail * c.speed
    for (const r of sourceRanges(c.mediaId)) {
      let s = Math.max(r.start, lo)
      let e = Math.min(r.end, hi)
      if (e - s < Math.max(0.01, minLength)) continue
      if (s > lo) s += padding
      if (e < hi) e -= padding
      if (e - s < 0.01) continue
      out.push({ start: round3(p.start + (s - c.in) / c.speed), end: round3(p.start + (e - c.in) / c.speed) })
    }
  }
  out.sort((a, b) => a.start - b.start)
  const merged: Array<Range> = []
  for (const r of out) {
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end + 0.01) merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, r.end) }
    else merged.push(r)
  }
  return merged
}

/** Deletes from the end backwards so earlier ranges keep their timeline positions. */
const deleteOps = (ranges: ReadonlyArray<Range>): Array<EditOp> =>
  [...ranges].reverse().map((r) => ({ op: "delete_range", start: r.start, end: r.end }))

export interface PauseOptions {
  /** Pauses shorter than this stay. */
  readonly minPause: number
  /** Silence kept on each side of a cut so speech does not sound clipped. */
  readonly padding: number
  readonly clipIds?: ReadonlyArray<string> | undefined
}

/**
 * Pauses between words when there is a transcript, otherwise quiet stretches
 * from the audio analysis.
 */
export const pauseRanges = (
  timeline: Timeline,
  analysisOf: (mediaId: string) => Analysis | undefined,
  options: PauseOptions
): Array<Range> =>
  toTimeline(timeline, (mediaId) => {
    const analysis = analysisOf(mediaId)
    const words = analysis?.transcript?.segments.flatMap((s) => s.words) ?? []
    const gaps: Array<Range> = []
    if (words.length > 0) {
      for (let i = 1; i < words.length; i++) gaps.push({ start: words[i - 1]!.e, end: words[i]!.s })
      gaps.unshift({ start: 0, end: words[0]!.s })
      gaps.push({ start: words[words.length - 1]!.e, end: Number.MAX_SAFE_INTEGER })
    } else {
      gaps.push(...(analysis?.audio?.silences ?? []).map(([start, end]) => ({ start, end })))
    }
    return gaps
  }, options.clipIds, options.minPause, options.padding)

export const removePausesOps = (ranges: ReadonlyArray<Range>) => deleteOps(ranges)

const FILLERS = new Set(["um", "umm", "uh", "uhh", "uhm", "er", "erm", "ah", "ahh", "hmm", "hm", "mm", "mhm"])

export const fillerRanges = (
  timeline: Timeline,
  analysisOf: (mediaId: string) => Analysis | undefined,
  extraWords: ReadonlyArray<string>,
  clipIds?: ReadonlyArray<string>
): { readonly ranges: Array<Range>; readonly words: Array<string> } => {
  const fillers = new Set([...FILLERS, ...extraWords.map((w) => w.toLowerCase())])
  const found: Array<string> = []
  const ranges = toTimeline(timeline, (mediaId) => {
    const words = analysisOf(mediaId)?.transcript?.segments.flatMap((s) => s.words) ?? []
    return words.flatMap((w, i) => {
      const clean = w.w.toLowerCase().replace(/[^\p{L}']/gu, "")
      if (!fillers.has(clean)) return []
      found.push(clean)
      // Cut up to the neighbouring words, but leave a little air around them.
      const prev = words[i - 1]?.e ?? w.s - 0.1
      const next = words[i + 1]?.s ?? w.e + 0.1
      return [{ start: Math.max(prev + 0.03, w.s - 0.08), end: Math.min(next - 0.03, w.e + 0.08) }]
    })
  }, clipIds, 0.01)
  return { ranges, words: found }
}

export interface MontageCandidate {
  readonly media: string
  readonly in: number
  readonly out: number
}

export interface MontagePlan {
  readonly clips: Array<ClipInput>
  readonly musicIn: number
  readonly length: number
  readonly beatsPerCut: number
  readonly skipped: Array<string>
}

/** Picks how many beats each cut lasts so cuts land roughly every 1.2s. */
export const autoBeatsPerCut = (tempo: number) => {
  const beat = 60 / tempo
  return [1, 2, 4, 8].reduce((best, n) => Math.abs(n * beat - 1.2) < Math.abs(best * beat - 1.2) ? n : best, 1)
}

/**
 * Cuts candidates on the beat. Each clip lasts a whole number of beats, taken
 * from the middle of the candidate, so cuts land on beats of the music.
 */
export const planMontage = (
  candidates: ReadonlyArray<MontageCandidate>,
  beats: ReadonlyArray<number>,
  options: { readonly beatsPerCut: number; readonly musicStart: number; readonly maxLength?: number | undefined }
): MontagePlan => {
  const skipped: Array<string> = []
  const clips: Array<ClipInput> = []
  let k = beats.findIndex((b) => b >= options.musicStart - 0.02)
  if (k < 0) return { clips, musicIn: options.musicStart, length: 0, beatsPerCut: options.beatsPerCut, skipped }
  const musicIn = beats[k]!
  for (const c of candidates) {
    if (k >= beats.length - 1) {
      skipped.push(`${c.media} ${c.in}-${c.out} (music ran out of beats)`)
      continue
    }
    const available = c.out - c.in
    let n = Math.min(options.beatsPerCut, beats.length - 1 - k)
    while (n > 1 && beats[k + n]! - beats[k]! > available) n--
    const span = beats[k + n]! - beats[k]!
    if (span > available + 0.01) {
      skipped.push(`${c.media} ${c.in}-${c.out} (shorter than one beat)`)
      continue
    }
    if (options.maxLength !== undefined && beats[k + n]! - musicIn > options.maxLength + 0.01) break
    const mid = (c.in + c.out) / 2
    const start = Math.max(c.in, Math.min(c.out - span, mid - span / 2))
    clips.push({ media: c.media, in: round3(start), out: round3(start + span) })
    k += n
  }
  return {
    clips,
    musicIn: round3(musicIn),
    length: round3(beats[k]! - musicIn),
    beatsPerCut: options.beatsPerCut,
    skipped
  }
}
