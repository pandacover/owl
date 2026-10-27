import { round3 } from "../domain/Time.ts"
import { BLANK, clipDuration, type MainClip, placeMain, type Timeline, timelineDuration, type ZoomKey } from "../domain/Timeline.ts"

/** Zoom keys are relative to the clip start, so a clip that loses its head moves its keys earlier. */
const shiftZoom = (zoom: ReadonlyArray<ZoomKey> | undefined, by: number): ReadonlyArray<ZoomKey> | undefined =>
  zoom && by > 0 ? zoom.map((k) => ({ ...k, at: round3(k.at - by) })) : zoom

/**
 * The range to slice for a still at `at`. Inside a transition it spans the
 * transition with room on both sides, so the slice keeps the blend.
 */
export const stillRange = (timeline: Timeline, at: number, frame: number): { readonly from: number; readonly to: number } => {
  for (const p of placeMain(timeline.main)) {
    const d = p.clip.transition?.duration ?? 0
    if (d > 0 && p.start <= at + 1e-6 && at < p.start + d) {
      return { from: Math.max(0, p.start - d), to: Math.min(p.end, Math.max(at + frame * 2, p.start + 2 * d)) }
    }
  }
  return { from: at, to: at + frame * 2 }
}

/**
 * A copy of the timeline that only covers [start, end), shifted to start at 0.
 * Used for partial previews and for single-frame stills.
 */
export const sliceTimeline = (timeline: Timeline, start: number, end: number): Timeline => {
  // Transitions that survive the cut keep their overlap. A dropped transition
  // would play its clip after the previous one instead of over it, making the
  // slice longer than asked, so its clip loses the overlapped head instead.
  const main: Array<MainClip> = []
  let prevEnd = 0
  for (const p of placeMain(timeline.main)) {
    if (p.end <= start + 1e-6 || p.start >= end - 1e-6) continue
    const c = p.clip
    let headCut = Math.max(0, start - p.start)
    const tailCut = Math.max(0, p.end - end)
    const relStart = Math.max(p.start, start) - start
    const relEnd = Math.min(p.end, end) - start
    const prev = main[main.length - 1]
    const transition = c.transition
    const keep = transition !== undefined && prev !== undefined && headCut === 0 &&
      transition.duration * 2 <= relEnd - relStart + 1e-6 && transition.duration * 2 <= clipDuration(prev) + 1e-6
    if (!keep && prev !== undefined && prevEnd > relStart + 1e-6) headCut += prevEnd - relStart
    const clip: MainClip = {
      ...c,
      in: round3(c.in + headCut * c.speed),
      out: round3(c.out - tailCut * c.speed),
      zoom: shiftZoom(c.zoom, headCut),
      transition: keep ? transition : undefined
    }
    if (clip.out - clip.in <= 0.001) continue
    main.push(clip)
    prevEnd = relEnd
  }
  const length = end - start

  const overlays = timeline.overlays.flatMap((o) => {
    const oEnd = o.start + clipDuration(o)
    if (oEnd <= start || o.start >= end) return []
    const skip = Math.max(0, start - o.start)
    const s = Math.max(0, o.start - start)
    const inT = o.in + skip * o.speed
    const out = Math.min(o.out, inT + (length - s) * o.speed)
    return [{
      ...o,
      start: round3(s),
      in: round3(inT),
      out: round3(out),
      fadeIn: skip > 0 ? 0 : o.fadeIn,
      // Cut at the slice end, it carries on in the next slice: no fade out here.
      fadeOut: out < o.out - 1e-6 ? 0 : o.fadeOut,
      zoom: shiftZoom(o.zoom, skip)
    }]
  })

  const audio = timeline.audio.flatMap((a) => {
    if (a.start >= end) return []
    const skip = Math.max(0, start - a.start)
    const sourceLength = a.out - a.in
    if (!a.loop && skip >= sourceLength) return []
    const offset = a.loop ? skip % sourceLength : skip
    return [{
      ...a,
      start: round3(Math.max(0, a.start - start)),
      in: round3(a.in + offset),
      duration: a.loop && a.duration !== undefined ? Math.max(0, a.duration - skip) : a.duration,
      fadeIn: skip > 0 ? 0 : a.fadeIn
    }]
  })

  // Text cut by the slice edge shows fully: replaying its fade or pop from the
  // edge would leave a still frame with invisible or half-faded text.
  const texts = timeline.texts.flatMap((t) =>
    t.end <= start || t.start >= end
      ? []
      : [{
        ...t,
        start: round3(Math.max(0, t.start - start)),
        end: round3(Math.min(length, t.end - start)),
        animation: t.start < start || t.end > end ? "none" as const : t.animation
      }]
  )

  const blurs = (timeline.blurs ?? []).flatMap((b) =>
    b.end <= start || b.start >= end
      ? []
      : [{ ...b, start: round3(Math.max(0, b.start - start)), end: round3(Math.min(length, b.end - start)) }]
  )

  return { ...timeline, main, overlays, audio, texts, blurs }
}

/** Video inputs one render piece may open. Each open decoder holds full-size frames. */
export const PIECE_INPUTS = 24

/**
 * Where to split a long edit into pieces that render one at a time, as
 * timeline times from 0 to the end. One piece when the edit is small. Splits
 * sit on hard cuts between main clips, on whole frames, and avoid overlays
 * that span the cut when they can.
 */
export const pieceBounds = (timeline: Timeline, fps: number): ReadonlyArray<number> => {
  const total = timelineDuration(timeline)
  const placed = placeMain(timeline.main)
  const inputs = placed.filter((p) => p.clip.mediaId !== BLANK).length + timeline.overlays.length
  if (inputs <= PIECE_INPUTS * 1.5) return [0, total]
  const overlaysIn = (from: number, to: number) => timeline.overlays.filter((o) => o.start >= from && o.start < to).length
  const within = (t: number, from: number, to: number) => from < t - 1e-6 && to > t + 1e-6
  // A fade cut in two would restart at full strength in the next piece.
  const crossed = (t: number) =>
    timeline.overlays.some((o) => within(t, o.start, o.start + clipDuration(o))) ||
    timeline.audio.some((a) => {
      const end = a.start + (a.loop ? (a.duration ?? total - a.start) : a.out - a.in)
      return within(t, a.start, a.start + a.fadeIn) || within(t, end - a.fadeOut, end)
    })
  const bounds = [0]
  let count = 0
  placed.forEach((p, i) => {
    const next = placed[i + 1]
    count += (p.clip.mediaId === BLANK ? 0 : 1) + overlaysIn(p.start, next ? next.start : total + 1)
    if (!next || next.clip.transition) return
    const at = Math.round(next.start * fps) / fps
    if (at <= bounds[bounds.length - 1]! + 1 / fps || at >= total - 1 / fps) return
    if (count >= PIECE_INPUTS * 2 || (count >= PIECE_INPUTS && !crossed(next.start))) {
      bounds.push(at)
      count = 0
    }
  })
  bounds.push(total)
  return bounds
}
