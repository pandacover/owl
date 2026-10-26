import { describe, expect, it } from "vitest"
import { emptyTimeline, type Timeline } from "../../src/domain/Timeline.ts"
import { buildAss, captionLines, timelineWords } from "../../src/render/ass.ts"
import { buildRender, duckExpression } from "../../src/render/graph.ts"
import { sliceTimeline } from "../../src/render/slice.ts"
import { detectMoments } from "../../src/analysis/shots.ts"

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
    expect(sliced.texts[0]).toMatchObject({ start: 0, end: 3, animation: "none" })
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

  it("shifts zoom keys and blurs when slicing", () => {
    const t: Timeline = {
      ...timeline,
      main: [clip("c1", 0, 4, { zoom: [{ at: 0, scale: 1 }, { at: 3, scale: 2 }] })],
      blurs: [{ id: "b1", start: 1, end: 3, x: 0, y: 0, w: 0.5, h: 0.5 }]
    }
    const sliced = sliceTimeline(t, 2, 4)
    expect(sliced.main[0]!.zoom!.map((k) => k.at)).toEqual([-2, 1])
    expect(sliced.blurs![0]).toMatchObject({ start: 0, end: 1 })
  })

  it("writes pinned, word by word text in the chosen font", () => {
    const t: Timeline = {
      ...timeline,
      captions: undefined,
      texts: [{ id: "t1", text: "Speak to write", start: 0, end: 2, style: "headline", position: "top", animation: "words", font: "serif", y: 0.1 }]
    }
    const ass = buildAss(t, [])!
    expect(ass).toContain("Instrument Serif")
    expect(ass).toContain("\\an8\\pos(960,108)")
    expect(ass.match(/\\alpha&HFF&/g)!.length).toBe(3)
  })

  it("builds a card with finite loops, zoom and blur", () => {
    const t: Timeline = {
      ...timeline,
      main: [clip("c1", 0, 4, { fit: "card", zoom: [{ at: 0, scale: 1 }, { at: 2, scale: 1.5 }] })],
      texts: [],
      audio: [],
      captions: undefined,
      blurs: [{ id: "b1", start: 1, end: 3, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }]
    }
    const { args } = buildRender({
      timeline: t,
      source: (id) => ({ path: `/x/${id}.mp4`, kind: "video", hasAudio: true, width: 1080, height: 1920 }),
      canvas: { width: 540, height: 960, fps: 30, background: "#F5EEE6", gradient: "#E3C9B3" },
      speech: [],
      quality: "draft",
      output: "/x/out.mp4"
    })
    const graph = args[args.indexOf("-filter_complex") + 1]!
    expect(graph).toContain("gradients=")
    expect(graph).toContain("alphamerge")
    expect(graph).toContain("perspective=")
    expect(graph).toContain("gblur")
    expect(graph).not.toMatch(/loop=loop=-1/)
  })
})

describe("moments", () => {
  it("splits a still screen recording at bursts of change", () => {
    const frames = Array.from({ length: 300 }, (_, i) => {
      const t = i / 30
      const burst = (t > 3 && t < 3.3) || (t > 6 && t < 6.3)
      return { t, mafd: burst ? 8 : 0.1, score: 0 }
    })
    const moments = detectMoments(frames, 0, 10)
    expect(moments.length).toBe(3)
    expect(moments[1]!.start).toBeCloseTo(2.95, 1)
    expect(moments[1]!.keyframe).toBeGreaterThan(3.3)
  })

  it("keeps camera footage whole", () => {
    const frames = Array.from({ length: 300 }, (_, i) => ({ t: i / 30, mafd: 3, score: 0 }))
    expect(detectMoments(frames, 0, 10)).toEqual([])
  })
})
