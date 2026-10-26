import { round3 } from "../domain/Time.ts"
import { clipDuration, type MainClip, placeMain, type Timeline } from "../domain/Timeline.ts"

/**
 * A copy of the timeline that only covers [start, end), shifted to start at 0.
 * Used for partial previews and for single-frame stills.
 */
export const sliceTimeline = (timeline: Timeline, start: number, end: number): Timeline => {
  const main: Array<MainClip> = []
  for (const p of placeMain(timeline.main)) {
    if (p.end <= start + 1e-6 || p.start >= end - 1e-6) continue
    const c = p.clip
    const headCut = Math.max(0, start - p.start)
    const tailCut = Math.max(0, p.end - end)
    const clip: MainClip = {
      ...c,
      in: round3(c.in + headCut * c.speed),
      out: round3(c.out - tailCut * c.speed),
      // A transition that crosses the slice edge becomes a hard cut.
      transition: main.length === 0 || headCut > 0 ? undefined : c.transition
    }
    if (clip.out - clip.in > 0.001) main.push(clip)
  }
  // Clips that only survive inside a transition overlap can leave a transition longer than its clips.
  const fixed = main.map((c, i) =>
    c.transition && (c.transition.duration * 2 > clipDuration(c) || c.transition.duration * 2 > clipDuration(main[i - 1]!))
      ? { ...c, transition: undefined }
      : c
  )
  const length = end - start

  const overlays = timeline.overlays.flatMap((o) => {
    const oEnd = o.start + clipDuration(o)
    if (oEnd <= start || o.start >= end) return []
    const skip = Math.max(0, start - o.start)
    const s = Math.max(0, o.start - start)
    const inT = o.in + skip * o.speed
    const out = Math.min(o.out, inT + (length - s) * o.speed)
    return [{ ...o, start: round3(s), in: round3(inT), out: round3(out), fadeIn: skip > 0 ? 0 : o.fadeIn }]
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

  const texts = timeline.texts.flatMap((t) =>
    t.end <= start || t.start >= end
      ? []
      : [{ ...t, start: round3(Math.max(0, t.start - start)), end: round3(Math.min(length, t.end - start)) }]
  )

  return { ...timeline, main: fixed, overlays, audio, texts }
}
