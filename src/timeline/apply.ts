import { formatTime, parseTime, round3, type TimeInput } from "../domain/Time.ts"
import {
  type AudioItem,
  BLANK,
  type BlurRegion,
  type CardSettings,
  clipDuration,
  type MainClip,
  mainDuration,
  type Overlay,
  type PlacedClip,
  placeMain,
  type Project,
  type TextItem,
  type TextPosition,
  type TextStyle,
  type Timeline,
  type Transition,
  type ZoomKey
} from "../domain/Timeline.ts"
import type { ClipInput, EditOp } from "./Ops.ts"

/** What the edit engine needs to know about each media item it references. */
export interface MediaInfo {
  readonly id: string
  readonly name: string
  readonly kind: "video" | "audio" | "image"
  readonly duration: number
  readonly width: number
  readonly height: number
  readonly fps: number
  readonly hasAudio: boolean
  readonly hasTranscript: boolean
  readonly shots: ReadonlyArray<{
    readonly index: number
    readonly start: number
    readonly end: number
    readonly moments?: ReadonlyArray<{ readonly start: number; readonly end: number; readonly keyframe?: number }> | undefined
  }>
}

export interface EditContext {
  readonly media: (id: string) => MediaInfo
}

/** Thrown inside the pure engine and turned into an agent-facing error by the caller. */
export class EditFailure extends Error {}

export interface EditResult {
  readonly timeline: Timeline
  readonly counters: Project["counters"]
  readonly outputLocked: boolean
  /** One line per operation. */
  readonly changes: ReadonlyArray<string>
  /** Adjustments the engine made on its own, such as clamping or removed items. */
  readonly notes: ReadonlyArray<string>
}

const EPS = 0.02
const MIN_CLIP = 0.04
const DEFAULT_IMAGE_SECONDS = 3
const DEFAULT_TRANSITION = 0.5

const fail = (message: string): never => {
  throw new EditFailure(message)
}

const time = (input: TimeInput, field: string): number => {
  const t = parseTime(input)
  if (t === undefined) fail(`${field} "${input}" is not a time. Use seconds (12.5) or a timecode ("0:12.5").`)
  if (t! < 0) fail(`${field} cannot be negative.`)
  return round3(t!)
}
const optTime = (input: TimeInput | undefined, field: string) => input === undefined ? undefined : time(input, field)

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

interface Draft {
  output: Timeline["output"]
  main: Array<MainClip>
  overlays: Array<Overlay>
  audio: Array<AudioItem>
  texts: Array<TextItem>
  blurs: Array<BlurRegion>
  captions: Timeline["captions"]
  counters: Mutable<Required<Project["counters"]>>
  outputLocked: boolean
  notes: Array<string>
  /** New clip id to the id it was split from, for the current operation. */
  lineage: Map<string, string>
}

const nextId = (draft: Draft, kind: keyof Draft["counters"]) => {
  draft.counters[kind] += 1
  return `${kind}${draft.counters[kind]}`
}

const evenDown = (n: number) => Math.max(2, Math.floor(n / 2) * 2)

/** The source range a clip, overlay or audio input refers to. */
const resolveRange = (
  input: {
    readonly media: string
    readonly shot?: number
    readonly moment?: number
    readonly in?: TimeInput
    readonly out?: TimeInput
    readonly duration?: number
  },
  media: MediaInfo,
  speed: number
): { in: number; out: number } => {
  if (media.kind === "image") {
    const out = input.duration ?? optTime(input.out, "out") ?? DEFAULT_IMAGE_SECONDS
    if (out < MIN_CLIP) fail(`Image duration must be at least ${MIN_CLIP}s.`)
    return { in: 0, out: round3(out) }
  }
  let start = 0
  let end = media.duration
  if (input.shot !== undefined) {
    const shot = media.shots.find((s) => s.index === input.shot)
    if (!shot) {
      fail(
        media.shots.length === 0
          ? `${media.id} has no shots.`
          : `${media.id} has shots 1 to ${media.shots.length}, not ${input.shot}.`
      )
    }
    start = shot!.start
    end = shot!.end
    if (input.moment !== undefined) {
      const moments = shot!.moments ?? []
      const moment = moments[input.moment - 1]
      if (!moment) {
        fail(
          moments.length === 0
            ? `Shot ${input.shot} of ${media.id} has no moments. Use in and out instead.`
            : `Shot ${input.shot} of ${media.id} has moments 1 to ${moments.length}, not ${input.moment}.`
        )
      }
      start = moment!.start
      end = moment!.end
    }
  } else if (input.moment !== undefined) {
    fail("moment needs shot as well.")
  }
  const inT = optTime(input.in, "in") ?? start
  let outT = optTime(input.out, "out") ?? (input.duration !== undefined ? inT + input.duration * speed : end)
  if (inT >= media.duration) {
    fail(`in ${formatTime(inT)} is past the end of ${media.id} (${formatTime(media.duration)} long).`)
  }
  if (outT > media.duration + 0.1) {
    fail(`out ${formatTime(outT)} is past the end of ${media.id} (${formatTime(media.duration)} long).`)
  }
  outT = Math.min(outT, media.duration)
  if (outT - inT < MIN_CLIP) fail(`The range ${formatTime(inT)} to ${formatTime(outT)} is empty. out must be after in.`)
  return { in: round3(inT), out: round3(outT) }
}

const transitionOf = (input: ClipInput["transition"]): Transition | undefined =>
  input ? { type: input.type, duration: round3(input.duration ?? DEFAULT_TRANSITION) } : undefined

const zoomOf = (input: ClipInput["zoom"] | null, length: number): ReadonlyArray<ZoomKey> | undefined => {
  if (!input || input.length === 0) return undefined
  const keys = [...input]
    .map((k) => ({ at: round3(k.at), scale: round3(k.scale), x: round3(k.x ?? 0.5), y: round3(k.y ?? 0.5) }))
    .sort((a, b) => a.at - b.at)
  if (keys[0]!.at > length + EPS) fail(`zoom starts at ${keys[0]!.at}s, after the clip ends (${round3(length)}s long). at is seconds from the clip start.`)
  return keys
}

const cardOf = (input: ClipInput["card"]): CardSettings | undefined =>
  input ? { ...(input.scale !== undefined ? { scale: input.scale } : {}), ...(input.y !== undefined ? { y: input.y } : {}) } : undefined

const DEFAULT_POSITION: Record<TextStyle, TextPosition> = {
  title: "center",
  headline: "center",
  kicker: "top",
  highlight: "center",
  subtitle: "bottom",
  lower_third: "lower_left",
  caption: "bottom",
  cta: "center",
  label: "upper_left",
  statement: "center"
}

const ASPECTS = {
  "16:9": [1920, 1080],
  "9:16": [1080, 1920],
  "1:1": [1080, 1080],
  "4:5": [1080, 1350]
} as const

const describeClip = (clip: MainClip) => `${clip.id} (${clip.mediaId} ${formatTime(clip.in)}–${formatTime(clip.out)})`

/** Applies operations in order. Throws EditFailure, in which case nothing is changed. */
/** A blank title card behaves like an image with no size of its own. */
const BLANK_INFO: MediaInfo = {
  id: BLANK, name: "title card", kind: "image", duration: 0, width: 0, height: 0, fps: 0,
  hasAudio: false, hasTranscript: false, shots: []
}

export const applyEdits = (project: Project, ops: ReadonlyArray<EditOp>, given: EditContext): EditResult => {
  const ctx: EditContext = { ...given, media: (id) => id === BLANK ? BLANK_INFO : given.media(id) }
  const t = project.timeline
  const draft: Draft = {
    output: t.output,
    main: [...t.main],
    overlays: [...t.overlays],
    audio: [...t.audio],
    texts: [...t.texts],
    blurs: [...(t.blurs ?? [])],
    captions: t.captions,
    counters: { ...project.counters, b: project.counters.b ?? 0 },
    outputLocked: project.outputLocked,
    notes: [],
    lineage: new Map()
  }
  const changes: Array<string> = []

  ops.forEach((op, index) => {
    try {
      draft.lineage = new Map()
      changes.push(applyOne(draft, op, ctx))
      validateTransitions(draft)
    } catch (error) {
      if (error instanceof EditFailure) {
        throw new EditFailure(
          `Operation ${index + 1} (${op.op}) failed: ${error.message}${ops.length > 1 ? " No operations were applied." : ""}`
        )
      }
      throw error
    }
  })

  return {
    timeline: {
      output: draft.output,
      main: draft.main,
      overlays: draft.overlays,
      audio: draft.audio,
      texts: draft.texts,
      ...(draft.blurs.length > 0 ? { blurs: draft.blurs } : {}),
      captions: draft.captions
    },
    counters: draft.counters,
    outputLocked: draft.outputLocked,
    changes,
    notes: draft.notes
  }
}

const clipIndex = (draft: Draft, id: string): number => {
  const i = draft.main.findIndex((c) => c.id === id)
  if (i < 0) {
    const ids = draft.main.map((c) => c.id)
    fail(`No main clip "${id}".${ids.length ? ` Main clips are: ${ids.slice(0, 40).join(", ")}.` : " The main track is empty."}`)
  }
  return i
}

/** Runs a change to the main track and moves overlays, audio and text so they stay with their content. */
const rippleMain = (draft: Draft, change: () => void) => {
  const before = placeMain(draft.main)
  const oldEnd = mainDuration(draft.main)
  change()
  const after = placeMain(draft.main)
  const newEnd = mainDuration(draft.main)
  remapItems(draft, before, after, oldEnd, newEnd)
}

const rootOf = (draft: Draft, id: string) => {
  let current = id
  for (let i = 0; i < 100 && draft.lineage.has(current); i++) current = draft.lineage.get(current)!
  return current
}

type Mapped = { readonly time: number; readonly removed: boolean }

const remapTime = (
  draft: Draft,
  t: number,
  before: ReadonlyArray<PlacedClip>,
  after: ReadonlyArray<PlacedClip>,
  oldEnd: number,
  newEnd: number
): Mapped => {
  if (before.length === 0) return { time: t, removed: false }
  if (t >= oldEnd - 1e-6) return { time: round3(Math.max(0, t + newEnd - oldEnd)), removed: false }
  let placed = before[0]!
  for (const p of before) if (p.start <= t + 1e-6) placed = p
  const clip = placed.clip
  const source = clip.in + (t - placed.start) * clip.speed
  const pieces = after.filter((p) => rootOf(draft, p.clip.id) === clip.id)
  for (const p of pieces) {
    if (source >= p.clip.in - 1e-6 && source <= p.clip.out + 1e-6) {
      return { time: round3(p.start + (source - p.clip.in) / p.clip.speed), removed: false }
    }
  }
  // The content under t was removed. Snap to where the following content now starts.
  const later = pieces.filter((p) => p.clip.in > source).sort((a, b) => a.clip.in - b.clip.in)[0]
  if (later) return { time: round3(later.start), removed: true }
  for (let i = placed.index + 1; i < before.length; i++) {
    const id = before[i]!.clip.id
    const survivor = after.find((p) => rootOf(draft, p.clip.id) === id)
    if (survivor) return { time: round3(survivor.start), removed: true }
  }
  return { time: round3(newEnd), removed: true }
}

const remapItems = (
  draft: Draft,
  before: ReadonlyArray<PlacedClip>,
  after: ReadonlyArray<PlacedClip>,
  oldEnd: number,
  newEnd: number
) => {
  const map = (t: number) => remapTime(draft, t, before, after, oldEnd, newEnd)
  const removed: Array<string> = []

  draft.overlays = draft.overlays.flatMap((o) => {
    const s = map(o.start)
    const e = map(o.start + clipDuration(o) - EPS)
    if (s.removed && e.removed && Math.abs(s.time - e.time) < EPS) {
      removed.push(o.id)
      return []
    }
    return [{ ...o, start: s.time }]
  })
  draft.texts = draft.texts.flatMap((x) => {
    const s = map(x.start)
    const e = map(x.end - EPS)
    const end = e.removed ? e.time : round3(e.time + EPS)
    if (end - s.time < 0.1) {
      removed.push(x.id)
      return []
    }
    return [{ ...x, start: s.time, end }]
  })
  draft.blurs = draft.blurs.flatMap((x) => {
    const s = map(x.start)
    const e = map(x.end - EPS)
    const end = e.removed ? e.time : round3(e.time + EPS)
    if (end - s.time < 0.05) {
      removed.push(x.id)
      return []
    }
    return [{ ...x, start: s.time, end }]
  })
  draft.audio = draft.audio.map((a) => ({ ...a, start: map(a.start).time }))
  if (removed.length > 0) draft.notes.push(`Removed ${removed.join(", ")} because the content under them was cut.`)
}

/** Clamps transitions so each one fits inside both clips it joins. */
const validateTransitions = (draft: Draft) => {
  draft.main = draft.main.map((clip, i) => {
    if (!clip.transition) return clip
    if (i === 0) {
      draft.notes.push(`Removed the transition on ${clip.id} because it is now the first clip.`)
      return { ...clip, transition: undefined }
    }
    const max = round3(Math.min(clipDuration(clip), clipDuration(draft.main[i - 1]!)) / 2)
    if (clip.transition.duration <= max) return clip
    if (max < 0.1) {
      draft.notes.push(`Removed the transition on ${clip.id} because the clips around it are too short.`)
      return { ...clip, transition: undefined }
    }
    draft.notes.push(`Shortened the transition on ${clip.id} to ${max}s so it fits the clips around it.`)
    return { ...clip, transition: { ...clip.transition, duration: max } }
  })
}

const makeClip = (draft: Draft, input: ClipInput, ctx: EditContext): MainClip => {
  const media = ctx.media(input.media)
  if (media.kind === "audio") fail(`${media.id} is audio only. Add it with add_audio instead.`)
  const speed = media.kind === "image" ? 1 : input.speed ?? 1
  if (input.card && (input.fit ?? "auto") !== "card") fail("card settings only apply with fit: card.")
  if (input.glow && media.id !== BLANK) fail(`glow only applies to blank clips, not ${media.id}.`)
  if (input.freeze !== undefined) return makeFreeze(draft, input, media)
  const range = resolveRange(input, media, speed)
  return {
    id: nextId(draft, "c"),
    mediaId: media.id,
    in: range.in,
    out: range.out,
    speed,
    volume: input.volume ?? 1,
    fit: input.fit ?? "auto",
    transition: transitionOf(input.transition),
    zoom: zoomOf(input.zoom, (range.out - range.in) / speed),
    card: cardOf(input.card),
    glow: input.glow
  }
}

/** A clip that holds one source frame. in and out span the hold so timeline maths stay linear. */
const makeFreeze = (draft: Draft, input: ClipInput, media: MediaInfo): MainClip => {
  const hold = input.freeze!
  if (media.kind !== "video") fail(`freeze needs a video; ${media.id} is ${media.id === BLANK ? "a blank card" : `an ${media.kind}`}. Use duration instead.`)
  if (hold < MIN_CLIP) fail(`freeze must be at least ${MIN_CLIP}s.`)
  const frame = 1 / Math.max(1, media.fps)
  const given = optTime(input.in, "in")
  let at: number
  if (given !== undefined) {
    if (given < 0 || given >= media.duration) fail(`in ${formatTime(given)} is outside ${media.id} (${formatTime(media.duration)} long).`)
    at = given
  } else {
    const { duration: _, ...source } = input
    const range = resolveRange(source, media, 1)
    const shot = input.shot !== undefined ? media.shots.find((s) => s.index === input.shot) : undefined
    const keyframe = input.moment !== undefined ? shot?.moments?.[input.moment - 1]?.keyframe : undefined
    at = keyframe ?? Math.max(range.in, range.out - frame)
  }
  at = round3(Math.min(at, media.duration - frame))
  return {
    id: nextId(draft, "c"),
    mediaId: media.id,
    in: at,
    out: round3(at + hold),
    speed: 1,
    volume: 0,
    fit: input.fit ?? "auto",
    transition: transitionOf(input.transition),
    zoom: zoomOf(input.zoom, hold),
    card: cardOf(input.card),
    freeze: at
  }
}

/** The first visual clip decides the output size, unless the agent set it. */
const autoOutput = (draft: Draft, ctx: EditContext) => {
  const first = draft.main.find((c) => c.mediaId !== BLANK)
  if (draft.outputLocked || !first) return
  const media = ctx.media(first.mediaId)
  if (media.width <= 0 || media.height <= 0) return
  const scale = Math.min(1, 1920 / Math.max(media.width, media.height))
  const fps = media.kind === "image" || media.fps <= 0 ? 30 : Math.min(60, Math.max(24, Math.round(media.fps)))
  draft.output = { ...draft.output, width: evenDown(media.width * scale), height: evenDown(media.height * scale), fps }
  draft.outputLocked = true
  draft.notes.push(
    `Output set to ${draft.output.width}x${draft.output.height} at ${fps}fps from the first clip. Use set_output to change it.`
  )
}

/** Splits the main clip under timeline time `at`. Returns the index where new material can be inserted. */
const splitAt = (draft: Draft, at: number): number => {
  const placed = placeMain(draft.main)
  for (const p of placed) {
    if (at <= p.start + EPS) return p.index
    if (at < p.end - EPS) {
      const source = round3(p.clip.in + (at - p.start) * p.clip.speed)
      const right: MainClip = { ...p.clip, id: nextId(draft, "c"), in: source, transition: undefined }
      draft.lineage.set(right.id, p.clip.id)
      draft.main.splice(p.index, 1, { ...p.clip, out: source }, right)
      return p.index + 1
    }
  }
  return draft.main.length
}

const insertIndex = (
  draft: Draft,
  position: { readonly after?: string; readonly before?: string; readonly at?: TimeInput }
): number => {
  const given = [position.after, position.before, position.at].filter((x) => x !== undefined).length
  if (given > 1) fail("Give only one of after, before or at.")
  if (position.after !== undefined) return clipIndex(draft, position.after) + 1
  if (position.before !== undefined) return clipIndex(draft, position.before)
  if (position.at !== undefined) return splitAt(draft, time(position.at, "at"))
  return draft.main.length
}

const findItem = (draft: Draft, id: string) => {
  const kind = id[0]
  const list = kind === "c"
    ? draft.main
    : kind === "o"
    ? draft.overlays
    : kind === "a"
    ? draft.audio
    : kind === "t"
    ? draft.texts
    : kind === "b"
    ? draft.blurs
    : undefined
  const index = (list as ReadonlyArray<{ readonly id: string }> | undefined)?.findIndex((x) => x.id === id) ?? -1
  if (!list || index < 0) fail(`No item "${id}". Use timeline_get to see current ids.`)
  return { kind: kind as "c" | "o" | "a" | "t" | "b", index }
}

const ALLOWED: Record<"c" | "o" | "a" | "t" | "b", ReadonlyArray<string>> = {
  c: ["in", "out", "speed", "volume", "fit", "card", "zoom", "glow", "freeze", "transition"],
  o: ["in", "out", "start", "duration", "speed", "volume", "fit", "card", "zoom", "layout", "fade_in", "fade_out"],
  a: ["in", "out", "start", "duration", "volume", "fade_in", "fade_out", "duck", "fill"],
  t: ["start", "end", "duration", "text", "style", "position", "color", "background", "size", "font", "y", "animation"],
  b: ["start", "end", "duration", "x", "y", "w", "h"]
}

/** Default end of a blur: the end of the main clip under `start`, or 3 seconds. */
const blurEnd = (draft: Draft, start: number) => {
  const under = placeMain(draft.main).find((p) => p.start <= start + EPS && p.end > start + EPS)
  return round3(under ? under.end : start + 3)
}

const checkBox = (b: { x: number; y: number; w: number; h: number }) => {
  if (b.w < 0.005 || b.h < 0.005) fail("w and h must be larger than 0.")
  if (b.x + b.w > 1.001 || b.y + b.h > 1.001) fail("The box must fit inside the frame: x + w and y + h must be at most 1.")
}

const applyOne = (draft: Draft, op: EditOp, ctx: EditContext): string => {
  switch (op.op) {
    case "add_clips": {
      const wasEmpty = draft.main.length === 0
      let ids: Array<string> = []
      rippleMain(draft, () => {
        const at = insertIndex(draft, op)
        const clips = op.clips.map((c) => makeClip(draft, c, ctx))
        ids = clips.map((c) => c.id)
        draft.main.splice(at, 0, ...clips)
      })
      if (wasEmpty) autoOutput(draft, ctx)
      return `Added ${ids.join(", ")}.`
    }
    case "set_main": {
      draft.main = op.clips.map((c) => makeClip(draft, c, ctx))
      autoOutput(draft, ctx)
      return draft.main.length === 0
        ? "Cleared the main track."
        : `Main track is now ${draft.main.map((c) => c.id).join(", ")} (${formatTime(mainDuration(draft.main))}).`
    }
    case "trim_clip": {
      const i = clipIndex(draft, op.clip)
      const clip = draft.main[i]!
      const media = ctx.media(clip.mediaId)
      if (op.in === undefined && op.out === undefined) fail("Give in, out or both.")
      if (clip.freeze !== undefined) fail(`${clip.id} is a freeze frame. Change its length with update freeze.`)
      const range = media.kind === "image"
        ? { in: 0, out: optTime(op.out, "out") ?? clip.out }
        : resolveRange(
          { media: clip.mediaId, in: op.in ?? clip.in, out: op.out ?? clip.out },
          media,
          clip.speed
        )
      rippleMain(draft, () => {
        draft.main[i] = { ...clip, in: range.in, out: range.out }
      })
      return `Trimmed ${describeClip(draft.main[i]!)}.`
    }
    case "split_clip": {
      const at = time(op.at, "at")
      const total = mainDuration(draft.main)
      if (at <= EPS || at >= total - EPS) fail(`at must be inside the main track (0 to ${formatTime(total)}).`)
      const before = draft.main.length
      const index = splitAt(draft, at)
      if (draft.main.length === before) fail(`${formatTime(at)} is already a cut between two clips.`)
      return `Split at ${formatTime(at)} into ${draft.main[index - 1]!.id} and ${draft.main[index]!.id}.`
    }
    case "delete_range": {
      const start = time(op.start, "start")
      const end = time(op.end, "end")
      const total = mainDuration(draft.main)
      if (end <= start) fail("end must be after start.")
      if (start >= total) fail(`start is past the end of the main track (${formatTime(total)}).`)
      rippleMain(draft, () => {
        const cutEnd = Math.min(end, total)
        splitAt(draft, cutEnd)
        splitAt(draft, start)
        // Both edges are now cuts, so the range is made of whole clips.
        const placed = placeMain(draft.main)
        draft.main = placed
          .filter((p) => !(p.start >= start - EPS && p.end <= cutEnd + EPS))
          .map((p) => p.clip)
      })
      return `Removed ${formatTime(start)}–${formatTime(Math.min(end, total))} from the main track. New length ${
        formatTime(mainDuration(draft.main))
      }.`
    }
    case "move_clip": {
      const i = clipIndex(draft, op.clip)
      const given = [op.after, op.before, op.to].filter((x) => x !== undefined).length
      if (given !== 1) fail("Give exactly one of after, before or to.")
      if (op.after === op.clip || op.before === op.clip) fail("A clip cannot move relative to itself.")
      rippleMain(draft, () => {
        const [clip] = draft.main.splice(i, 1)
        const at = op.to === "start"
          ? 0
          : op.to === "end"
          ? draft.main.length
          : op.after !== undefined
          ? clipIndex(draft, op.after) + 1
          : clipIndex(draft, op.before!)
        draft.main.splice(at, 0, clip!)
      })
      return `Moved ${op.clip} to position ${draft.main.findIndex((c) => c.id === op.clip) + 1} of ${draft.main.length}.`
    }
    case "add_overlay": {
      const media = ctx.media(op.media)
      if (media.kind === "audio") fail(`${media.id} is audio only. Use add_audio.`)
      if (media.id === BLANK) fail("blank only works on the main track. For a colored layer, use a blank clip there.")
      const speed = op.speed ?? 1
      const range = resolveRange(op, media, speed)
      if (op.card && op.fit !== "card") fail("card settings only apply with fit: card.")
      const overlay: Overlay = {
        id: nextId(draft, "o"),
        mediaId: media.id,
        start: time(op.start, "start"),
        in: range.in,
        out: range.out,
        speed: media.kind === "image" ? 1 : speed,
        layout: op.layout ?? "full",
        fit: op.fit ?? "auto",
        volume: op.volume ?? 0,
        fadeIn: op.fade_in ?? 0,
        fadeOut: op.fade_out ?? 0,
        zoom: zoomOf(op.zoom, (range.out - range.in) / (media.kind === "image" ? 1 : speed)),
        card: cardOf(op.card)
      }
      draft.overlays.push(overlay)
      const end = overlay.start + clipDuration(overlay)
      const total = mainDuration(draft.main)
      if (total > 0 && end > total + EPS) {
        draft.notes.push(`${overlay.id} ends at ${formatTime(end)}, after the main track ends at ${formatTime(total)}.`)
      }
      return `Added ${overlay.id} (${overlay.layout}) at ${formatTime(overlay.start)}–${formatTime(end)}.`
    }
    case "add_audio": {
      const media = ctx.media(op.media)
      if (!media.hasAudio) fail(`${media.id} has no audio track.`)
      const range = resolveRange({ media: op.media, ...pick(op, "in", "out") }, { ...media, kind: "audio" }, 1)
      const loop = op.fill === true || op.duration !== undefined
      const item: AudioItem = {
        id: nextId(draft, "a"),
        mediaId: media.id,
        start: optTime(op.start, "start") ?? 0,
        in: range.in,
        out: range.out,
        volume: op.volume ?? 1,
        fadeIn: op.fade_in ?? 0,
        fadeOut: op.fade_out ?? 0,
        duck: op.duck ?? true,
        loop,
        duration: op.duration
      }
      draft.audio.push(item)
      const length = loop ? item.duration === undefined ? "to the end" : `${item.duration}s` : `${round3(item.out - item.in)}s`
      return `Added ${item.id} at ${formatTime(item.start)} (${length}${loop ? ", looped" : ""}).`
    }
    case "add_text": {
      const start = time(op.start, "start")
      const end = op.end !== undefined ? time(op.end, "end") : start + (op.duration ?? 3)
      if (end - start < 0.1) fail("end must be after start.")
      const style = op.style ?? "title"
      const item: TextItem = {
        id: nextId(draft, "t"),
        text: op.text,
        start,
        end: round3(end),
        style,
        position: op.position ?? DEFAULT_POSITION[style],
        color: op.color,
        background: op.background,
        size: op.size,
        font: op.font,
        y: op.y,
        animation: op.animation ?? "fade"
      }
      draft.texts.push(item)
      return `Added ${item.id} "${truncate(item.text, 40)}" at ${formatTime(item.start)}–${formatTime(item.end)}.`
    }
    case "add_blur": {
      const start = time(op.start, "start")
      const end = op.end !== undefined
        ? time(op.end, "end")
        : op.duration !== undefined
        ? round3(start + op.duration)
        : blurEnd(draft, start)
      if (end - start < 0.05) fail("end must be after start.")
      const box = { x: round3(op.x), y: round3(op.y), w: round3(op.w), h: round3(op.h) }
      checkBox(box)
      const item: BlurRegion = { id: nextId(draft, "b"), start, end, ...box }
      draft.blurs.push(item)
      return `Added blur ${item.id} at ${formatTime(start)}–${formatTime(end)}.`
    }
    case "update":
      return applyUpdate(draft, op, ctx)
    case "delete": {
      const clipIds = op.ids.filter((id) => id.startsWith("c"))
      for (const id of op.ids) findItem(draft, id)
      if (clipIds.length > 0) {
        rippleMain(draft, () => {
          draft.main = draft.main.filter((c) => !clipIds.includes(c.id))
        })
      }
      draft.overlays = draft.overlays.filter((x) => !op.ids.includes(x.id))
      draft.audio = draft.audio.filter((x) => !op.ids.includes(x.id))
      draft.texts = draft.texts.filter((x) => !op.ids.includes(x.id))
      draft.blurs = draft.blurs.filter((x) => !op.ids.includes(x.id))
      return `Deleted ${op.ids.join(", ")}.`
    }
    case "set_captions": {
      if (!op.enabled) {
        draft.captions = undefined
        return "Captions off."
      }
      const prev = draft.captions
      draft.captions = {
        style: op.style ?? prev?.style ?? "bold",
        position: op.position ?? prev?.position ?? "bottom",
        maxWordsPerLine: op.max_words_per_line ?? prev?.maxWordsPerLine ??
          (draft.output.height > draft.output.width ? 3 : 6),
        uppercase: op.uppercase ?? prev?.uppercase ?? false,
        highlightColor: op.highlight_color ?? prev?.highlightColor ?? "#FFD400"
      }
      const withSpeech = new Set(draft.main.map((c) => c.mediaId).filter((id) => ctx.media(id).hasTranscript))
      if (draft.main.length > 0 && withSpeech.size === 0) {
        draft.notes.push("None of the main clips has a transcript, so captions will be empty.")
      }
      return `Captions on (${draft.captions.style}, ${draft.captions.position}).`
    }
    case "set_output": {
      let { width, height } = draft.output
      if (op.aspect) [width, height] = ASPECTS[op.aspect]
      if (op.width !== undefined) width = evenDown(op.width)
      if (op.height !== undefined) height = evenDown(op.height)
      draft.output = {
        width,
        height,
        fps: op.fps ?? draft.output.fps,
        background: op.background ?? draft.output.background,
        gradient: op.gradient === undefined ? draft.output.gradient : op.gradient ?? undefined,
        look: op.look === undefined ? draft.output.look : op.look ?? undefined
      }
      draft.outputLocked = true
      return `Output is ${width}x${height} at ${draft.output.fps}fps.`
    }
  }
}

const pick = <T extends object, K extends keyof T>(obj: T, ...keys: Array<K>): Pick<T, K> => {
  const out = {} as Pick<T, K>
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k]
  return out
}

const truncate = (s: string, n: number) => s.length > n ? `${s.slice(0, n - 1)}…` : s

const applyUpdate = (draft: Draft, op: Extract<EditOp, { op: "update" }>, ctx: EditContext): string => {
  const { kind, index } = findItem(draft, op.id)
  const given = Object.keys(op).filter((k) => k !== "op" && k !== "id" && (op as Record<string, unknown>)[k] !== undefined)
  if (given.length === 0) fail("Give at least one field to change.")
  const wrong = given.filter((k) => !ALLOWED[kind].includes(k))
  if (wrong.length > 0) {
    fail(`${op.id} does not have ${wrong.join(", ")}. Fields you can change: ${ALLOWED[kind].join(", ")}.`)
  }

  switch (kind) {
    case "c": {
      const clip = draft.main[index]!
      const media = ctx.media(clip.mediaId)
      if (clip.freeze !== undefined) {
        const bad = given.filter((k) => k === "in" || k === "out" || k === "speed" || k === "volume")
        if (bad.length > 0) fail(`${clip.id} is a freeze frame, so it has no ${bad.join(", ")}. Change its length with freeze, or replace it.`)
      } else if (op.freeze !== undefined) {
        fail(`${clip.id} plays its source. To hold a frame, add a clip with freeze.`)
      }
      const speed = op.speed ?? clip.speed
      const range = op.freeze !== undefined
        ? { in: clip.in, out: round3(clip.in + Math.max(MIN_CLIP, op.freeze)) }
        : op.in !== undefined || op.out !== undefined
        ? media.kind === "image"
          ? { in: 0, out: optTime(op.out, "out") ?? clip.out }
          : resolveRange({ media: clip.mediaId, in: op.in ?? clip.in, out: op.out ?? clip.out }, media, speed)
        : { in: clip.in, out: clip.out }
      const next: MainClip = {
        ...clip,
        ...range,
        speed: media.kind === "image" ? 1 : speed,
        volume: op.volume ?? clip.volume,
        fit: op.fit ?? clip.fit,
        transition: op.transition === undefined ? clip.transition : transitionOf(op.transition ?? undefined),
        zoom: op.zoom === undefined ? clip.zoom : zoomOf(op.zoom, (range.out - range.in) / speed),
        card: op.card === undefined ? clip.card : cardOf(op.card),
        glow: op.glow === undefined ? clip.glow : op.glow ?? undefined
      }
      if (op.card && next.fit !== "card") fail("card settings only apply with fit: card.")
      if (op.glow && clip.mediaId !== BLANK) fail(`glow only applies to blank clips.`)
      if (next.in !== clip.in || next.out !== clip.out || next.speed !== clip.speed || op.transition !== undefined) {
        rippleMain(draft, () => {
          draft.main[index] = next
        })
      } else {
        draft.main[index] = next
      }
      break
    }
    case "o": {
      const item = draft.overlays[index]!
      const media = ctx.media(item.mediaId)
      const speed = op.speed ?? item.speed
      const range = op.in !== undefined || op.out !== undefined || op.duration !== undefined
        ? resolveRange(
          {
            media: item.mediaId,
            in: op.in ?? item.in,
            ...(op.duration !== undefined ? { duration: op.duration } : { out: op.out ?? item.out })
          },
          media,
          speed
        )
        : { in: item.in, out: item.out }
      draft.overlays[index] = {
        ...item,
        ...range,
        start: optTime(op.start, "start") ?? item.start,
        speed: media.kind === "image" ? 1 : speed,
        volume: op.volume ?? item.volume,
        fit: op.fit ?? item.fit,
        layout: op.layout ?? item.layout,
        fadeIn: op.fade_in ?? item.fadeIn,
        fadeOut: op.fade_out ?? item.fadeOut,
        zoom: op.zoom === undefined ? item.zoom : zoomOf(op.zoom, (range.out - range.in) / speed),
        card: op.card === undefined ? item.card : cardOf(op.card)
      }
      if (op.card && draft.overlays[index]!.fit !== "card") fail("card settings only apply with fit: card.")
      break
    }
    case "a": {
      const item = draft.audio[index]!
      const media = ctx.media(item.mediaId)
      const range = op.in !== undefined || op.out !== undefined
        ? resolveRange({ media: item.mediaId, in: op.in ?? item.in, out: op.out ?? item.out }, { ...media, kind: "audio" }, 1)
        : { in: item.in, out: item.out }
      const loop = op.fill !== undefined ? op.fill : op.duration !== undefined ? true : item.loop
      draft.audio[index] = {
        ...item,
        ...range,
        start: optTime(op.start, "start") ?? item.start,
        volume: op.volume ?? item.volume,
        fadeIn: op.fade_in ?? item.fadeIn,
        fadeOut: op.fade_out ?? item.fadeOut,
        duck: op.duck ?? item.duck,
        loop,
        duration: op.fill === true ? undefined : op.duration ?? (loop ? item.duration : undefined)
      }
      break
    }
    case "t": {
      const item = draft.texts[index]!
      const start = optTime(op.start, "start") ?? item.start
      const end = op.end !== undefined
        ? time(op.end, "end")
        : op.duration !== undefined
        ? round3(start + op.duration)
        : round3(item.end + (start - item.start))
      if (end - start < 0.1) fail("end must be after start.")
      draft.texts[index] = {
        ...item,
        start,
        end,
        text: op.text ?? item.text,
        style: op.style ?? item.style,
        position: op.position ?? (op.style ? DEFAULT_POSITION[op.style] : item.position),
        color: op.color === undefined ? item.color : op.color ?? undefined,
        background: op.background === undefined ? item.background : op.background ?? undefined,
        size: op.size ?? item.size,
        font: op.font ?? item.font,
        y: op.y === undefined ? item.y : op.y ?? undefined,
        animation: op.animation ?? item.animation
      }
      break
    }
    case "b": {
      const item = draft.blurs[index]!
      const start = optTime(op.start, "start") ?? item.start
      const end = op.end !== undefined
        ? time(op.end, "end")
        : op.duration !== undefined
        ? round3(start + op.duration)
        : round3(item.end + (start - item.start))
      if (end - start < 0.05) fail("end must be after start.")
      const box = { x: op.x ?? item.x, y: op.y ?? item.y, w: op.w ?? item.w, h: op.h ?? item.h }
      if (op.y === null) fail("A blur needs a top edge; give y as a number.")
      checkBox(box)
      draft.blurs[index] = { ...item, start, end, ...box }
      break
    }
  }
  return `Updated ${op.id} (${given.join(", ")}).`
}
