import { describe, expect, it } from "vitest"
import { emptyTimeline, type Timeline } from "../../src/domain/Timeline.ts"
import { buildAss, captionLines, timelineWords } from "../../src/render/ass.ts"
import { buildRender, duckExpression } from "../../src/render/graph.ts"
import { sliceTimeline } from "../../src/render/slice.ts"

const clip = (id: string, inT: number, out: number, extra: object = {}) =>
  ({ id, mediaId: "m_a", in: inT, out, speed: 1, volume: 1, fit: "auto" as const, ...extra })

const timeline: Timeline = {
  ...emptyTimeline,
  main: [clip("c1", 0, 4), clip("c2", 10, 14, { transition: { type: "crossfade", duration: 1 } })],
  texts: [{ id: "t1", text: "Hi {there}", start: 1, end: 6, style: "title", position: "center", animation: "pop" }],
  audio: [{ id: "a1", mediaId: "m_s", start: 0, in: 0, out: 30, volume: 0.3, fadeIn: 0, fadeOut: 0, duck: true, loop: false }],
  captions: { style: "bold", position: "bottom", maxWordsPerLine: 3, uppercase: true, highlightColor: "#FFD400" }
}

describe("render building blocks", () => {
  it("maps words into timeline time and skips cut words", () => {
    const words = timelineWords(timeline, () => [
      { w: "one", s: 1, e: 1.5 },
      { w: "gone", s: 6, e: 6.5 },
      { w: "two", s: 11, e: 11.5 }
    ])
    expect(words).toEqual([{ w: "one", s: 1, e: 1.5 }, { w: "two", s: 4, e: 4.5 }])
  })

  it("breaks caption lines on word count, sentence end and pauses", () => {
    const w = (text: string, s: number) => ({ w: text, s, e: s + 0.3 })
    const lines = captionLines([w("a", 0), w("b.", 0.4), w("c", 0.8), w("d", 1.2), w("e", 3)], 3)
    expect(lines.map((l) => l.map((x) => x.w).join(" "))).toEqual(["a b.", "c d", "e"])
  })

  it("writes ASS with escaped text and caption events", () => {
    const ass = buildAss(timeline, [{ w: "hello", s: 0.5, e: 0.9 }])!
    expect(ass).toContain("PlayResX: 1920")
    expect(ass).toContain("Hi (there)")
    expect(ass).toContain("Style: Caption")
    expect(ass).toContain(",HELLO")
  })

  it("ducks with ramps and merges close ranges", () => {
    const expr = duckExpression([{ start: 1, end: 2 }, { start: 2.3, end: 3 }, { start: 8, end: 9 }])!
    expect(expr.match(/clip\(/g)!.length).toBe(2)
  })

  it("slices a range for previews", () => {
    const sliced = sliceTimeline(timeline, 2, 5)
    expect(sliced.main.map((c) => [c.in, c.out])).toEqual([[2, 4], [10, 12]])
    expect(sliced.main[1]!.transition).toEqual({ type: "crossfade", duration: 1 })
    expect(sliceTimeline(timeline, 3.5, 5).main[0]!.transition).toBeUndefined()
    expect(sliced.texts[0]).toMatchObject({ start: 0, end: 3 })
    expect(sliced.audio[0]).toMatchObject({ start: 0, in: 2 })
  })

  it("builds one FFmpeg command with exact output length", () => {
    const { args, duration } = buildRender({
      timeline,
      source: (id) => ({ path: `/x/${id}.mp4`, kind: id === "m_s" ? "audio" : "video", hasAudio: true, width: 1920, height: 1080 }),
      canvas: { width: 960, height: 540, fps: 30, background: "#000000" },
      speech: [{ start: 1, end: 2 }],
      quality: "draft",
      output: "/x/out.mp4"
    })
    expect(duration).toBe(7)
    const graph = args[args.indexOf("-filter_complex") + 1]!
    expect(graph).toContain("xfade=transition=fade:duration=1:offset=3")
    expect(graph).toContain("acrossfade=d=1")
    expect(graph).toContain("eval=frame")
    expect(args.filter((a) => a === "-i").length).toBe(3)
  })
})
