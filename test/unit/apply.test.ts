import { describe, expect, it } from "vitest"
import { emptyTimeline, mainDuration, type Project } from "../../src/domain/Timeline.ts"
import { applyEdits, EditFailure, type MediaInfo } from "../../src/timeline/apply.ts"
import type { EditOp } from "../../src/timeline/Ops.ts"

const media: Record<string, MediaInfo> = {
  m_a: { id: "m_a", name: "a.mp4", kind: "video", duration: 20, width: 1080, height: 1920, fps: 29.97, hasAudio: true, hasTranscript: true, shots: [{ index: 1, start: 0, end: 8, moments: [{ start: 0, end: 3, keyframe: 1.5 }, { start: 3, end: 8, keyframe: 4.2 }] }, { index: 2, start: 8, end: 20 }] },
  m_b: { id: "m_b", name: "b.mp4", kind: "video", duration: 10, width: 1920, height: 1080, fps: 25, hasAudio: true, hasTranscript: false, shots: [] },
  m_s: { id: "m_s", name: "song.mp3", kind: "audio", duration: 120, width: 0, height: 0, fps: 0, hasAudio: true, hasTranscript: false, shots: [] },
  m_i: { id: "m_i", name: "logo.png", kind: "image", duration: 0, width: 800, height: 600, fps: 0, hasAudio: false, hasTranscript: false, shots: [] }
}
const ctx = {
  media: (id: string) => {
    const m = media[id]
    if (!m) throw new EditFailure(`No media ${id}`)
    return m
  }
}
const empty: Project = {
  id: "p_x", name: "t", createdAt: "", updatedAt: "", version: 0, timeline: emptyTimeline,
  counters: { c: 0, o: 0, a: 0, t: 0 }, outputLocked: false, undo: [], redo: []
}
const run = (project: Project, ops: ReadonlyArray<EditOp>) => {
  const r = applyEdits(project, ops, ctx)
  return { ...project, timeline: r.timeline, counters: r.counters, outputLocked: r.outputLocked, result: r }
}

describe("applyEdits", () => {
  it("lays out clips by shot and sets output from the first clip", () => {
    const p = run(empty, [{ op: "set_main", clips: [{ media: "m_a", shot: 2 }, { media: "m_b", in: 1, out: 3 }] }])
    expect(p.timeline.main.map((c) => [c.id, c.in, c.out])).toEqual([["c1", 8, 20], ["c2", 1, 3]])
    expect(p.timeline.output).toMatchObject({ width: 1080, height: 1920, fps: 30 })
    expect(mainDuration(p.timeline.main)).toBe(14)
  })

  it("ripples text and overlays with their clip when an earlier clip is deleted", () => {
    let p = run(empty, [
      { op: "set_main", clips: [{ media: "m_a", in: 0, out: 5 }, { media: "m_b", in: 0, out: 5 }] },
      { op: "add_text", text: "hi", start: 6, end: 8 },
      { op: "add_overlay", media: "m_i", start: 7, duration: 1 }
    ])
    p = run(p, [{ op: "delete", ids: ["c1"] }])
    expect(p.timeline.texts[0]).toMatchObject({ start: 1, end: 3 })
    expect(p.timeline.overlays[0]!.start).toBe(2)
  })

  it("delete_range splits clips, removes covered text and keeps the rest in sync", () => {
    let p = run(empty, [
      { op: "set_main", clips: [{ media: "m_a", in: 0, out: 10 }] },
      { op: "add_text", text: "gone", start: 3, end: 4 },
      { op: "add_text", text: "stays", start: 7, end: 8 }
    ])
    p = run(p, [{ op: "delete_range", start: 2, end: 5 }])
    expect(p.timeline.main.map((c) => [c.in, c.out])).toEqual([[0, 2], [5, 10]])
    expect(p.timeline.texts.map((t) => [t.text, t.start, t.end])).toEqual([["stays", 4, 5]])
    expect(p.result.notes.join(" ")).toContain("t1")
  })

  it("inserts at a time by splitting", () => {
    let p = run(empty, [{ op: "set_main", clips: [{ media: "m_a", in: 0, out: 10 }] }])
    p = run(p, [{ op: "add_clips", at: 4, clips: [{ media: "m_b", in: 0, out: 2 }] }])
    expect(p.timeline.main.map((c) => [c.mediaId, c.in, c.out])).toEqual([["m_a", 0, 4], ["m_b", 0, 2], ["m_a", 4, 10]])
  })

  it("speed changes stretch later items", () => {
    let p = run(empty, [
      { op: "set_main", clips: [{ media: "m_a", in: 0, out: 10 }, { media: "m_b", in: 0, out: 4 }] },
      { op: "add_text", text: "x", start: 11, end: 12 }
    ])
    p = run(p, [{ op: "update", id: "c1", speed: 2 }])
    expect(p.timeline.texts[0]).toMatchObject({ start: 6, end: 7 })
  })

  it("clamps transitions and reports it", () => {
    const p = run(empty, [{
      op: "set_main",
      clips: [{ media: "m_a", in: 0, out: 1 }, { media: "m_b", in: 0, out: 4, transition: { type: "crossfade", duration: 2 } }]
    }])
    expect(p.timeline.main[1]!.transition!.duration).toBe(0.5)
    expect(mainDuration(p.timeline.main)).toBe(4.5)
  })

  it("moves a clip and text follows it", () => {
    let p = run(empty, [
      { op: "set_main", clips: [{ media: "m_a", in: 0, out: 5 }, { media: "m_b", in: 0, out: 3 }] },
      { op: "add_text", text: "on b", start: 6, end: 7 }
    ])
    p = run(p, [{ op: "move_clip", clip: "c2", to: "start" }])
    expect(p.timeline.main.map((c) => c.id)).toEqual(["c2", "c1"])
    expect(p.timeline.texts[0]).toMatchObject({ start: 1, end: 2 })
  })

  it("rejects bad input with an actionable message and applies nothing", () => {
    expect(() => run(empty, [
      { op: "set_main", clips: [{ media: "m_a" }] },
      { op: "trim_clip", clip: "c9", in: 1 }
    ])).toThrow(/Operation 2 \(trim_clip\) failed: No main clip "c9". Main clips are: c1/)
    expect(() => run(empty, [{ op: "add_clips", clips: [{ media: "m_s" }] }])).toThrow(/audio only/)
    expect(() => run(empty, [{ op: "add_clips", clips: [{ media: "m_a", out: 30 }] }])).toThrow(/past the end/)
    expect(() => run(empty, [{ op: "add_clips", clips: [{ media: "m_a", shot: 5 }] }])).toThrow(/shots 1 to 2/)
  })

  it("update rejects fields that do not apply", () => {
    const p = run(empty, [{ op: "add_text", text: "a", start: 0 }])
    expect(() => run(p, [{ op: "update", id: "t1", speed: 2 }])).toThrow(/does not have speed/)
  })

  it("music fills to the end", () => {
    const p = run(empty, [{ op: "add_audio", media: "m_s", fill: true, volume: 0.3 }])
    expect(p.timeline.audio[0]).toMatchObject({ loop: true, duration: undefined, duck: true })
  })

  it("takes a moment of a shot and keeps zoom and card on clips", () => {
    const p = run(empty, [{
      op: "set_main",
      clips: [{ media: "m_a", shot: 1, moment: 2, fit: "card", card: { scale: 0.7, y: 0.1 }, zoom: [{ at: 0, scale: 1 }, { at: 1, scale: 1.8, x: 0.5, y: 0.3 }] }]
    }])
    const c = p.timeline.main[0]!
    expect([c.in, c.out, c.fit]).toEqual([3, 8, "card"])
    expect(c.card).toEqual({ scale: 0.7, y: 0.1 })
    expect(c.zoom![1]).toMatchObject({ scale: 1.8, x: 0.5, y: 0.3 })
    expect(() => run(empty, [{ op: "set_main", clips: [{ media: "m_a", shot: 1, moment: 3 }] }])).toThrow(/moments 1 to 2/)
    expect(() => run(empty, [{ op: "set_main", clips: [{ media: "m_a", shot: 2, moment: 1 }] }])).toThrow(/no moments/)
  })

  it("adds blurs that ripple with the main track and get deleted", () => {
    let p = run(empty, [
      { op: "set_main", clips: [{ media: "m_a", in: 0, out: 5 }, { media: "m_b", in: 0, out: 5 }] },
      { op: "add_blur", start: 6, x: 0.1, y: 0.1, w: 0.3, h: 0.1 }
    ])
    expect(p.timeline.blurs![0]).toMatchObject({ id: "b1", start: 6, end: 10 })
    p = run(p, [{ op: "delete", ids: ["c1"] }])
    expect(p.timeline.blurs![0]).toMatchObject({ start: 1, end: 5 })
    p = run(p, [{ op: "delete", ids: ["b1"] }])
    expect(p.timeline.blurs ?? []).toEqual([])
  })

  it("makes blank title cards with a glow and skips them for the output size", () => {
    const p = run(empty, [{
      op: "set_main",
      clips: [{ media: "blank", duration: 2, glow: "#9FB6CF" }, { media: "m_b", in: 0, out: 3 }]
    }])
    expect(p.timeline.main[0]).toMatchObject({ mediaId: "blank", in: 0, out: 2, glow: "#9FB6CF" })
    expect(p.timeline.output).toMatchObject({ width: 1920, height: 1080 })
    expect(() => run(p, [{ op: "add_overlay", media: "blank", start: 0 }])).toThrow(/main track/)
    expect(() => run(p, [{ op: "update", id: "c2", glow: "#FFFFFF" }])).toThrow(/blank/)
    const graded = run(p, [{ op: "set_output", look: "cinematic" }])
    expect(graded.timeline.output.look).toBe("cinematic")
    expect(run(graded, [{ op: "set_output", look: null }]).timeline.output.look).toBeUndefined()
  })

  it("holds a freeze frame that survives splits and ignores speed", () => {
    let p = run(empty, [{
      op: "set_main",
      clips: [
        { media: "m_a", shot: 1, moment: 2, freeze: 2 },
        { media: "m_b", out: 3, freeze: 1.5 },
        { media: "m_b", in: 4, freeze: 1 }
      ]
    }])
    expect(p.timeline.main.map((c) => [c.freeze, c.in, c.out, c.volume])).toEqual([[4.2, 4.2, 6.2, 0], [2.96, 2.96, 4.46, 0], [4, 4, 5, 0]])
    expect(mainDuration(p.timeline.main)).toBe(4.5)
    p = run(p, [{ op: "split_clip", at: 1 }])
    expect(p.timeline.main.slice(0, 2).map((c) => c.freeze)).toEqual([4.2, 4.2])
    expect(() => run(p, [{ op: "update", id: "c2", speed: 2 }])).toThrow(/freeze frame/)
    expect(() => run(p, [{ op: "trim_clip", clip: "c2", out: 5 }])).toThrow(/freeze frame/)
    p = run(p, [{ op: "update", id: "c2", freeze: 3 }])
    expect(mainDuration(p.timeline.main)).toBe(6)
    expect(() => run(empty, [{ op: "set_main", clips: [{ media: "m_i", freeze: 1 }] }])).toThrow(/needs a video/)
  })
})
