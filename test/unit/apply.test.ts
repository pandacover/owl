import { describe, expect, it } from "vitest"
import { emptyTimeline, mainDuration, type Project } from "../../src/domain/Timeline.ts"
import { applyEdits, EditFailure, type MediaInfo } from "../../src/timeline/apply.ts"
import type { EditOp } from "../../src/timeline/Ops.ts"

const media: Record<string, MediaInfo> = {
  m_a: { id: "m_a", name: "a.mp4", kind: "video", duration: 20, width: 1080, height: 1920, fps: 29.97, hasAudio: true, hasTranscript: true, shots: [{ index: 1, start: 0, end: 8 }, { index: 2, start: 8, end: 20 }] },
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
})
