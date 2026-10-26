import { describe, expect, it } from "vitest"
import type { Analysis } from "../../src/domain/Media.ts"
import { emptyTimeline, type Timeline } from "../../src/domain/Timeline.ts"
import { autoBeatsPerCut, fillerRanges, pauseRanges, planMontage } from "../../src/timeline/smart.ts"

const clip = (id: string, mediaId: string, inT: number, out: number) =>
  ({ id, mediaId, in: inT, out, speed: 1, volume: 1, fit: "auto" as const })

const words = (list: Array<[string, number, number]>) => list.map(([w, s, e]) => ({ w, s, e }))
const analysis: Analysis = {
  version: 1,
  shots: [],
  transcript: {
    language: "en",
    segments: [{ start: 1, end: 9, text: "", words: words([["Hello", 1, 1.4], ["um", 1.5, 1.8], ["world", 1.9, 2.3], ["again", 5, 5.5]]) }]
  }
}

describe("smart edits", () => {
  const timeline: Timeline = { ...emptyTimeline, main: [clip("c1", "m_a", 0, 8)] }

  it("finds pauses between words, with padding", () => {
    const r = pauseRanges(timeline, () => analysis, { minPause: 0.6, padding: 0.15 })
    expect(r).toEqual([{ start: 0, end: 0.85 }, { start: 2.45, end: 4.85 }, { start: 5.65, end: 8 }])
  })

  it("maps source ranges through trims", () => {
    const t: Timeline = { ...emptyTimeline, main: [clip("c1", "m_x", 0, 1), clip("c2", "m_a", 2, 6)] }
    const r = pauseRanges(t, (id) => id === "m_a" ? analysis : undefined, { minPause: 0.6, padding: 0.15 })
    expect(r).toEqual([{ start: 1.45, end: 3.85 }])
  })

  it("finds filler words", () => {
    const r = fillerRanges(timeline, () => analysis, [])
    expect(r.words).toEqual(["um"])
    expect(r.ranges[0]!.start).toBeCloseTo(1.43)
    expect(r.ranges[0]!.end).toBeCloseTo(1.87)
  })

  it("cuts on beats", () => {
    const beats = Array.from({ length: 40 }, (_, i) => 0.3 + i * 0.5)
    expect(autoBeatsPerCut(120)).toBe(2)
    const plan = planMontage(
      [{ media: "a", in: 0, out: 5 }, { media: "b", in: 10, out: 10.6 }, { media: "c", in: 0, out: 0.2 }, { media: "d", in: 2, out: 4 }],
      beats,
      { beatsPerCut: 2, musicStart: 0 }
    )
    expect(plan.musicIn).toBe(0.3)
    expect(plan.clips).toEqual([
      { media: "a", in: 2, out: 3 },
      { media: "b", in: 10.05, out: 10.55 },
      { media: "d", in: 2.5, out: 3.5 }
    ])
    expect(plan.length).toBe(2.5)
    expect(plan.skipped.length).toBe(1)
  })
})
