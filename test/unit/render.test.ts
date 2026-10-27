import { describe, expect, it } from "vitest"
import { emptyTimeline, type Timeline } from "../../src/domain/Timeline.ts"
import { buildAss, captionLines, timelineWords } from "../../src/render/ass.ts"
import { buildRender, duckExpression, joinPieces } from "../../src/render/graph.ts"
import { inputCostMb, PIECE_BASE_MB, pieceBounds, splitPoint, sliceTimeline, stillRange } from "../../src/render/slice.ts"
import { mainDuration } from "../../src/domain/Timeline.ts"
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
    expect(graph).toContain("xfade=transition=fade:duration=1:offset=0")
    expect(graph).toContain("afade=t=out:d=1")
    expect(graph).toContain("eval=frame")
    expect(args.filter((a) => a === "-i").length).toBe(5)
    expect(args.filter((a) => a === "-vn").length).toBe(2)
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

  it("boxes any style that has a background, with opacity and size", () => {
    const t: Timeline = {
      ...timeline,
      captions: undefined,
      texts: [
        { id: "t1", text: "Calm line", start: 0, end: 2, style: "statement", position: "center", animation: "words", background: "#0B0B0FB3", size: 1.5 },
        { id: "t2", text: "Plain", start: 0, end: 2, style: "statement", position: "center", animation: "fade" }
      ]
    }
    const ass = buildAss(t, [])!
    const boxed = ass.split("\n").find((l) => l.startsWith("Style: statement.center.light.box"))!
    expect(boxed.split(",")[15]).toBe("3")
    expect(ass).toContain("Style: statement.center.light,")
    expect(ass).toContain("\\3c&H000F0B0B\\3a&H4C&")
    expect(ass).toMatch(/\\fs94/)
    expect(ass).toContain("\\1a&HFF&")
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

  it("renders a freeze frame from one seeked frame, silent", () => {
    const t: Timeline = { ...timeline, main: [clip("c1", 4, 6, { freeze: 4, volume: 0 })], texts: [], audio: [], captions: undefined }
    const { args, duration } = buildRender({
      timeline: t,
      source: (id) => ({ path: `/x/${id}.mp4`, kind: "video", hasAudio: true, width: 1080, height: 1920 }),
      canvas: { width: 540, height: 960, fps: 30, background: "#000000" },
      speech: [],
      quality: "draft",
      output: "/x/out.mp4"
    })
    const graph = args[args.indexOf("-filter_complex") + 1]!
    expect(duration).toBe(2)
    expect(graph).toContain("trim=end_frame=1,tpad=stop_mode=clone:stop=60")
    expect(graph).toContain("anullsrc")
    expect(args.filter((a) => a === "-i")).toHaveLength(1)
  })
})

describe("slices with transitions", () => {
  const t: Timeline = {
    ...emptyTimeline,
    main: [
      clip("c1", 0, 5),
      clip("c2", 10, 15, { transition: { type: "dissolve", duration: 1 } }),
      clip("c3", 20, 24.2, { transition: { type: "fade_black", duration: 1 } }),
      clip("c4", 30, 34.7, { transition: { type: "dissolve", duration: 1 } })
    ]
  }
  it("keeps the asked length when a transition is cut", () => {
    for (const [a, b] of [[3, 9], [10.5, 12.5], [9, 15.9], [4.5, 8.5], [0, 15.9]] as const) {
      expect(mainDuration(sliceTimeline(t, a, b).main)).toBeCloseTo(b - a, 3)
    }
  })
  it("widens still slices so a transition keeps its blend", () => {
    expect(stillRange(t, 4.5, 1 / 30)).toEqual({ from: 3, to: 6 })
    expect(stillRange(t, 2, 1 / 30).from).toBe(2)
    const sliced = sliceTimeline(t, 3, 6)
    expect(sliced.main[1]!.transition).toEqual({ type: "dissolve", duration: 1 })
  })
})

describe("cinematic", () => {
  it("renders blank cards with a glow, a grade and thin text", () => {
    const t: Timeline = {
      ...emptyTimeline,
      output: { width: 1080, height: 1920, fps: 30, background: "#07080A", look: "cinematic" },
      main: [{ ...clip("c1", 0, 2), mediaId: "blank", glow: "#9FB6CF" }, clip("c2", 0, 2, { transition: { type: "blur", duration: 0.3 } })],
      texts: [{ id: "t1", text: "Quiet line", start: 0, end: 2, style: "statement", position: "center", animation: "fade" }]
    }
    const { args } = buildRender({
      timeline: t,
      source: (id) => {
        if (id === "blank") throw new Error("blank is not media")
        return { path: `/x/${id}.mp4`, kind: "video", hasAudio: true, width: 1080, height: 1920 }
      },
      canvas: { width: 540, height: 960, fps: 30, background: "#07080A", look: "cinematic" },
      speech: [],
      quality: "draft",
      output: "/x/out.mp4"
    })
    const graph = args[args.indexOf("-filter_complex") + 1]!
    expect(args.filter((a) => a === "-i").length).toBe(2)
    expect(graph).toContain("geq=r=159:g=182:b=207")
    expect(graph).toContain("transition=hblur")
    expect(graph).toContain("vignette")
    expect(buildAss(t, [])).toContain("Inter Display Light")
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

describe("long edits in pieces", () => {
  const many = (count: number): Timeline => ({
    ...emptyTimeline,
    main: Array.from({ length: count }, (_, i) =>
      clip(`c${i}`, i, i + 0.51, i % 5 === 1 ? { transition: { type: "crossfade", duration: 0.2 } } : {})),
    overlays: [{
      id: "o1", mediaId: "m_b", start: 12, in: 0, out: 3, speed: 1, volume: 0, layout: "full", fit: "cover", fadeIn: 0.3, fadeOut: 0.5
    }],
    texts: [{ id: "t1", text: "Across", start: 11, end: 14, style: "title", position: "center", animation: "words" }],
    audio: [{ id: "a1", mediaId: "m_s", start: 0, in: 0, out: 120, volume: 1, fadeIn: 0, fadeOut: 2, duck: false, loop: false }]
  })

  const cost = () => 47
  it("keeps small edits whole", () => {
    expect(pieceBounds(many(20), 30, cost, 1500)).toHaveLength(2)
  })

  it("estimates memory per source from its frame size and codec", () => {
    // Measured: about 47 MB per H.264 and 85 MB per HEVC input for a 1179x2556 phone recording.
    expect(inputCostMb(1179, 2556, "h264")).toBeCloseTo(47, -1)
    expect(inputCostMb(1179, 2556, "hevc")).toBeCloseTo(90, -1)
    expect(inputCostMb(540, 960, "h264")).toBeLessThan(15)
  })

  it("splits big edits on whole frames at hard cuts", () => {
    const t = many(120)
    const bounds = pieceBounds(t, 30, cost, 1500)
    expect(bounds.length).toBeGreaterThan(3)
    expect(bounds[0]).toBe(0)
    expect(bounds[bounds.length - 1]).toBeCloseTo(mainDuration(t.main), 6)
    for (const b of bounds.slice(1, -1)) {
      expect(Math.abs(b * 30 - Math.round(b * 30))).toBeLessThan(1e-6)
      const piece = sliceTimeline(t, b, bounds[bounds.length - 1]!)
      expect(piece.main[0]!.transition).toBeUndefined()
      expect(piece.main.length).toBeGreaterThan(0)
    }
    for (let i = 0; i + 1 < bounds.length; i++) {
      const piece = sliceTimeline(t, bounds[i]!, bounds[i + 1]!)
      expect((piece.main.length + piece.overlays.length) * 47).toBeLessThanOrEqual(1500 - PIECE_BASE_MB + 47)
    }
  })

  it("renders a piece with raw audio, no end fade, and text moved into place", () => {
    const t = many(120)
    const piece = sliceTimeline(t, 10, 20)
    const { args } = buildRender({
      timeline: piece,
      source: (id) => ({ path: `/x/${id}.mp4`, kind: id === "m_s" ? "audio" : "video", hasAudio: true, width: 1920, height: 1080 }),
      canvas: { width: 960, height: 540, fps: 30, background: "#000000" },
      assPath: "/x/text.ass",
      textOffset: 10,
      speech: [],
      quality: "final",
      output: "/x/piece0.mkv",
      piece: { last: false }
    })
    const graph = args[args.indexOf("-filter_complex") + 1]!
    expect(graph).toContain("setpts=PTS+10/TB,ass=filename=/x/text.ass,setpts=PTS-STARTPTS")
    expect(graph).not.toContain("loudnorm")
    expect(graph).not.toMatch(/afade=t=out:st=[\d.]+:d=1\.5/)
    expect(args).toContain("pcm_f32le")
    expect(args).not.toContain("+faststart")
    // The overlay that runs past the piece does not fade out at the edge.
    expect(piece.overlays[0]).toMatchObject({ fadeOut: 0.5 })
    expect(sliceTimeline(t, 10, 13).overlays[0]).toMatchObject({ fadeOut: 0 })
  })

  it("splits a stuck piece at a hard cut near its middle", () => {
    const t = many(40)
    const at = splitPoint(t, 0, 20.4, 30)!
    expect(Math.abs(at - 10.2)).toBeLessThan(0.6)
    expect(Math.abs(at * 30 - Math.round(at * 30))).toBeLessThan(1e-6)
    expect(splitPoint(t, 0, 0.5, 30)).toBeUndefined()
  })

  it("joins pieces by copying video and finishing audio once", () => {
    const args = joinPieces({ list: "/x/pieces.txt", quality: "final", seconds: 61.2, output: "/x/out.mp4" })
    expect(args.slice(0, 6)).toEqual(["-f", "concat", "-safe", "0", "-i", "/x/pieces.txt"])
    expect(args[args.indexOf("-c:v") + 1]).toBe("copy")
    expect(args[args.indexOf("-af") + 1]).toContain("loudnorm")
  })
})
