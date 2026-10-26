import { round3 } from "../domain/Time.ts"
import {
  type AudioItem,
  BLANK,
  type BlurRegion,
  clipDuration,
  type Fit,
  type Layout,
  type Look,
  type MainClip,
  type Overlay,
  placeMain,
  type Timeline,
  timelineDuration,
  type ZoomKey
} from "../domain/Timeline.ts"

/**
 * Builds one FFmpeg command that renders a timeline. Every main clip,
 * overlay and audio item is a seeked input, so FFmpeg only decodes the parts
 * of each file that are used, and the whole edit is encoded once.
 */

export interface SourceInfo {
  readonly path: string
  readonly kind: "video" | "audio" | "image"
  readonly hasAudio: boolean
  readonly width: number
  readonly height: number
}

export interface Canvas {
  readonly width: number
  readonly height: number
  readonly fps: number
  readonly background: string
  readonly gradient?: string | undefined
  readonly look?: Look | undefined
}

export interface Range {
  readonly start: number
  readonly end: number
}

export interface GraphInput {
  readonly timeline: Timeline
  readonly source: (mediaId: string) => SourceInfo
  /** Frame size to render at. Drafts render smaller than the project output. */
  readonly canvas: Canvas
  readonly assPath?: string | undefined
  /** Folder with the fonts the text styles use. */
  readonly fontsDir?: string | undefined
  /** Timeline ranges with speech, used to duck music. */
  readonly speech: ReadonlyArray<Range>
  readonly quality: "draft" | "final"
  readonly output: string
  /** Render a single frame as a JPEG instead of a video. */
  readonly still?: boolean | undefined
}

const SAMPLE_RATE = 48000
const AUDIO_FORMAT = `aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`

class Graph {
  readonly inputs: Array<string> = []
  readonly filters: Array<string> = []
  private inputCount = 0
  private labelCount = 0

  input(args: ReadonlyArray<string>): number {
    this.inputs.push(...args)
    return this.inputCount++
  }
  label(prefix: string) {
    return `${prefix}${this.labelCount++}`
  }
  add(filter: string) {
    this.filters.push(filter)
  }
}

const n = (x: number) => String(round3(x))
const hex = (color: string) => `0x${color.replace("#", "")}`

/** Chain of atempo filters for any speed (one atempo accepts 0.5 to 2). */
const atempo = (speed: number) => {
  const parts: Array<string> = []
  let s = speed
  while (s > 2) {
    parts.push("atempo=2")
    s /= 2
  }
  while (s < 0.5) {
    parts.push("atempo=0.5")
    s /= 0.5
  }
  if (Math.abs(s - 1) > 1e-6) parts.push(`atempo=${n(s)}`)
  return parts
}

const effectiveFit = (fit: Fit, src: SourceInfo, w: number, h: number): Exclude<Fit, "auto"> => {
  if (fit !== "auto") return fit
  if (src.width <= 0 || src.height <= 0) return "cover"
  const a = src.width / src.height
  const b = w / h
  return Math.abs(a / b - 1) < 0.08 ? "cover" : "blur"
}

/** Default size of a card relative to the frame. */
export const CARD_SCALE = 0.8

export interface FitOptions {
  /** How many frames the result needs. Still layers repeat exactly this often, so the graph stays finite. */
  readonly frames: number
  readonly zoom?: ReadonlyArray<ZoomKey> | undefined
  readonly card?: { readonly scale?: number | undefined; readonly y?: number | undefined } | undefined
}

/** Smoothly eased value of one zoom property at time T, as an FFmpeg expression. */
const keyExpression = (keys: ReadonlyArray<ZoomKey>, pick: (k: ZoomKey) => number): string => {
  let expr = n(pick(keys[keys.length - 1]!))
  for (let i = keys.length - 2; i >= 0; i--) {
    const a = keys[i]!
    const b = keys[i + 1]!
    const va = pick(a)
    const vb = pick(b)
    const span = Math.max(1e-3, b.at - a.at)
    const u = `clip((T-${n(a.at)})/${n(span)},0,1)`
    const segment = Math.abs(vb - va) < 1e-6 ? n(va) : `${n(va)}+${n(vb - va)}*${u}*${u}*(3-2*${u})`
    expr = `if(lt(T,${n(b.at)}),${segment},${expr})`
  }
  return expr
}

/**
 * Zoom and pan inside a frame, with sub-pixel precision so slow moves do not
 * jitter. perspective maps a moving window of the source onto the frame.
 */
const zoomFilter = (keys: ReadonlyArray<ZoomKey>, fps: number): string | undefined => {
  if (keys.length === 0 || keys.every((k) => Math.abs(k.scale - 1) < 1e-3)) return undefined
  const sorted = [...keys].sort((a, b) => a.at - b.at)
  const sub = (e: string) => e.replace(/T/g, `(in/${fps})`)
  const s = sub(keyExpression(sorted, (k) => Math.max(1, k.scale)))
  const x = sub(keyExpression(sorted, (k) => k.x))
  const y = sub(keyExpression(sorted, (k) => k.y))
  const left = `clip((${x})*W-W/(${s})/2,0,W-W/(${s}))`
  const top = `clip((${y})*H-H/(${s})/2,0,H-H/(${s}))`
  const right = `${left}+W/(${s})`
  const bottom = `${top}+H/(${s})`
  return `perspective=x0='${left}':y0='${top}':x1='${right}':y1='${top}':x2='${left}':y2='${bottom}':x3='${right}':y3='${bottom}':interpolation=cubic:eval=frame`
}

/** Repeats a single frame `frames` times at the canvas rate. */
const repeatFrame = (frames: number, fps: number) => `loop=loop=${Math.max(1, Math.ceil(frames) + 2)}:size=1,setpts=N/(${fps}*TB)`

/** A still background frame, repeated: the canvas color or gradient. */
const background = (g: Graph, canvas: Canvas, w: number, h: number, frames: number): string => {
  const out = g.label("bgf")
  const source = canvas.gradient
    ? `gradients=s=${w}x${h}:r=${canvas.fps}:c0=${hex(canvas.background)}:c1=${hex(canvas.gradient)}:nb_colors=2:x0=0:y0=0:x1=${w}:y1=${h}:speed=0.00001`
    : `color=c=${hex(canvas.background)}:s=${w}x${h}:r=${canvas.fps}`
  g.add(`${source},trim=end_frame=1,format=yuv420p,${repeatFrame(frames, canvas.fps)}[${out}]`)
  return out
}

/**
 * A blank title card: the background, with an optional soft light that
 * drifts slowly. The light is drawn once at low size and scaled up, so it
 * costs one overlay per frame.
 */
const blankCard = (g: Graph, canvas: Canvas, glow: string | undefined, frames: number): string => {
  const { width: w, height: h, fps } = canvas
  const bg = background(g, canvas, w, h, frames)
  if (!glow) return bg
  const c = glow.replace("#", "")
  const [r, gg, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16))
  const light = g.label("glow")
  g.add(
    `color=c=black:s=160x90:r=${fps},trim=end_frame=1,format=rgba,` +
      `geq=r=${r}:g=${gg}:b=${b}:a='235*exp(-(pow((X-70)/60,2)+pow((Y-96)/30,2)))',` +
      `scale=${Math.round(w * 1.4 / 2) * 2}:${h}:flags=bicubic,${repeatFrame(frames, fps)}[${light}]`
  )
  const out = g.label("card")
  g.add(`[${bg}][${light}]overlay=x='-W*0.2+W*0.1*sin(2*PI*t/10)':y=0:shortest=1,format=yuv420p[${out}]`)
  return out
}

/** Color grades for set_output look. Grain is temporal so it reads as film, not a dirty lens. */
const LOOKS: Record<Look, string> = {
  cinematic:
    "eq=contrast=1.08:saturation=0.88:gamma=0.97,colorbalance=rs=-0.05:gs=-0.01:bs=0.06:rh=0.05:gh=0.01:bh=-0.05,vignette=angle=0.55,noise=alls=4:allf=t",
  mono: "hue=s=0,eq=contrast=1.15:gamma=0.95,vignette=angle=0.5,noise=alls=4:allf=t"
}

/** Media floating on the background with rounded corners and a soft shadow. */
const cardInto = (g: Graph, input: string, src: SourceInfo, w: number, h: number, canvas: Canvas, options: FitOptions): string => {
  const scale = Math.min(1, Math.max(0.2, options.card?.scale ?? CARD_SCALE))
  const aspect = src.width > 0 && src.height > 0 ? src.width / src.height : w / h
  let cw = w * scale
  let ch = cw / aspect
  if (ch > h * scale) {
    ch = h * scale
    cw = ch * aspect
  }
  cw = Math.max(2, Math.round(cw / 2) * 2)
  ch = Math.max(2, Math.round(ch / 2) * 2)
  const radius = Math.max(2, Math.round(Math.min(cw, ch) * 0.06))
  const x = Math.round((w - cw) / 2)
  const y = Math.round((h - ch) / 2 + (options.card?.y ?? 0) * h)
  const blur = Math.max(4, Math.round(Math.min(w, h) * 0.025))
  const pad = blur * 3
  const roundness = `255*clip(${radius}+0.5-hypot(max(max(${radius}-X,X-(W-1-${radius})),0),max(max(${radius}-Y,Y-(H-1-${radius})),0)),0,1)`
  const [shape, shapeB, mask, shadowAlpha, shadowColor, shadow, content, card, withShadow, out] = [
    g.label("shape"),
    g.label("shape"),
    g.label("mask"),
    g.label("sa"),
    g.label("sc"),
    g.label("shd"),
    g.label("cc"),
    g.label("card"),
    g.label("ws"),
    g.label("fit")
  ]
  const back = background(g, canvas, w, h, options.frames)
  const repeat = repeatFrame(options.frames, canvas.fps)
  // The mask and the shadow are drawn once and repeated, so they cost nothing per frame.
  g.add(`color=c=white:s=${cw}x${ch}:r=${canvas.fps},trim=end_frame=1,format=gray,geq=lum='${roundness}',split[${shape}][${shapeB}]`)
  g.add(`[${shape}]${repeat}[${mask}]`)
  g.add(
    `[${shapeB}]pad=${cw + pad * 2}:${ch + pad * 2}:${pad}:${pad}:color=black,gblur=sigma=${blur},geq=lum='lum(X,Y)*0.4'[${shadowAlpha}]`
  )
  g.add(`color=c=black:s=${cw + pad * 2}x${ch + pad * 2}:r=${canvas.fps},trim=end_frame=1,format=yuv420p[${shadowColor}]`)
  g.add(`[${shadowColor}][${shadowAlpha}]alphamerge,format=yuva420p,${repeat}[${shadow}]`)
  const zoom = options.zoom ? zoomFilter(options.zoom, canvas.fps) : undefined
  g.add(`[${input}]scale=${cw}:${ch}:force_divisible_by=2,setsar=1${zoom ? `,${zoom}` : ""},format=yuva420p[${content}]`)
  g.add(`[${content}][${mask}]alphamerge[${card}]`)
  g.add(`[${back}][${shadow}]overlay=${x - pad}:${y - pad + Math.round(blur * 0.6)}:shortest=0[${withShadow}]`)
  g.add(`[${withShadow}][${card}]overlay=${x}:${y}:shortest=1,setsar=1[${out}]`)
  return out
}

/** Scales `input` into a w x h box. Returns the output label. */
const fitInto = (
  g: Graph,
  input: string,
  fit: Exclude<Fit, "auto">,
  src: SourceInfo,
  w: number,
  h: number,
  canvas: Canvas,
  options: FitOptions
): string => {
  if (fit === "card") return cardInto(g, input, src, w, h, canvas, options)
  const out = g.label("fit")
  const zoom = options.zoom ? zoomFilter(options.zoom, canvas.fps) : undefined
  const z = zoom ? `,${zoom}` : ""
  const cover = `scale=${w}:${h}:force_original_aspect_ratio=increase:force_divisible_by=2${z},crop=${w}:${h},setsar=1`
  const contain = `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1${z}`
  if (fit === "cover") g.add(`[${input}]${cover}[${out}]`)
  else if (fit === "contain") {
    const front = g.label("cf")
    const back = background(g, canvas, w, h, options.frames)
    g.add(`[${input}]${contain}[${front}]`)
    g.add(`[${back}][${front}]overlay=(W-w)/2:(H-h)/2:shortest=1,setsar=1[${out}]`)
  } else {
    const [a, b, back, front] = [g.label("b"), g.label("b"), g.label("b"), g.label("b")]
    const sw = Math.max(16, Math.round(w / 8 / 2) * 2)
    const sh = Math.max(16, Math.round(h / 8 / 2) * 2)
    g.add(`[${input}]split[${a}][${b}]`)
    g.add(
      `[${a}]scale=${sw}:${sh}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${sw}:${sh},boxblur=6:2,eq=brightness=-0.08,scale=${w}:${h},setsar=1[${back}]`
    )
    g.add(`[${b}]${contain}[${front}]`)
    g.add(`[${back}][${front}]overlay=(W-w)/2:(H-h)/2[${out}]`)
  }
  return out
}

interface Segment {
  readonly v: string
  readonly a: string
  /** Exact length in frames. */
  readonly frames: number
}

const imageInput = (src: SourceInfo, fps: number, seconds: number) => [
  "-loop",
  "1",
  "-framerate",
  String(fps),
  "-t",
  n(seconds + 2 / fps),
  "-i",
  src.path
]

const seekInput = (path: string, start: number, length: number, threads: boolean) => [
  ...(threads ? ["-threads", "2"] : []),
  "-ss",
  n(start),
  "-t",
  n(length),
  "-i",
  path
]

const silence = (g: Graph, seconds: number) => {
  const a = g.label("sil")
  g.add(`anullsrc=r=${SAMPLE_RATE}:cl=stereo,atrim=end=${n(seconds)}[${a}]`)
  return a
}

/** One main clip, normalized to the canvas, exactly `frames` long, with matching audio. */
const mainSegment = (
  g: Graph,
  clip: MainClip,
  src: SourceInfo,
  frames: number,
  canvas: Canvas,
  manyInputs: boolean,
  still: boolean
): Segment => {
  const { width: w, height: h, fps } = canvas
  const seconds = frames / fps
  if (clip.mediaId === BLANK) {
    const card = blankCard(g, canvas, clip.glow, frames)
    const v = g.label("v")
    g.add(`[${card}]trim=end_frame=${frames},setpts=PTS-STARTPTS,settb=1/${fps}[${v}]`)
    return { v, a: still ? "" : silence(g, seconds), frames }
  }
  const span = clip.out - clip.in
  const index = src.kind === "image"
    ? g.input(imageInput(src, fps, seconds))
    : g.input(seekInput(src.path, clip.in, span + 2 / fps, manyInputs))
  const raw = g.label("raw")
  g.add(`[${index}:v]setpts=(PTS-STARTPTS)/${n(clip.speed)},fps=${fps}[${raw}]`)
  const fitted = fitInto(g, raw, effectiveFit(clip.fit, src, w, h), src, w, h, canvas, {
    frames,
    zoom: clip.zoom,
    card: clip.card
  })
  const v = g.label("v")
  g.add(
    `[${fitted}]format=yuv420p,tpad=stop_mode=clone:stop=${frames},trim=end_frame=${frames},setpts=PTS-STARTPTS,settb=1/${fps}[${v}]`
  )
  if (still) return { v, a: "", frames }
  let a: string
  if (src.kind !== "image" && src.hasAudio && clip.volume > 0) {
    a = g.label("a")
    const fade = Math.min(0.012, seconds / 4)
    g.add(
      [
        `[${index}:a]asetpts=PTS-STARTPTS`,
        ...atempo(clip.speed),
        AUDIO_FORMAT,
        `volume=${n(clip.volume)}`,
        "apad",
        `atrim=end=${n(seconds)}`,
        // Short fades remove clicks at hard cuts.
        `afade=t=in:d=${n(fade)}`,
        `afade=t=out:st=${n(seconds - fade)}:d=${n(fade)}`,
        "asetpts=PTS-STARTPTS"
      ].join(",") + `[${a}]`
    )
  } else {
    a = silence(g, seconds)
  }
  return { v, a, frames }
}

const XFADE: Record<string, string> = {
  crossfade: "fade",
  dissolve: "dissolve",
  fade_black: "fadeblack",
  fade_white: "fadewhite",
  wipe_left: "wipeleft",
  wipe_right: "wiperight",
  slide_left: "slideleft",
  slide_right: "slideright",
  zoom_in: "zoomin",
  smooth_left: "smoothleft",
  smooth_right: "smoothright",
  smooth_up: "smoothup",
  smooth_down: "smoothdown",
  circle_open: "circleopen",
  blur: "hblur"
}

const BLANK_SOURCE: SourceInfo = { path: "", kind: "image", hasAudio: false, width: 0, height: 0 }

/** Joins main clips: hard cuts use concat, transitions use xfade and acrossfade. */
const mainTrack = (g: Graph, input: GraphInput): { v: string; a: string; frames: number } | undefined => {
  const { timeline, canvas } = input
  const placed = placeMain(timeline.main)
  if (placed.length === 0) return undefined
  const fps = canvas.fps
  const toFrame = (t: number) => Math.round(t * fps)
  const manyInputs = placed.length + timeline.overlays.length + timeline.audio.length > 8
  const segments = placed.map((p) =>
    mainSegment(
      g,
      p.clip,
      p.clip.mediaId === BLANK ? BLANK_SOURCE : input.source(p.clip.mediaId),
      Math.max(1, toFrame(p.end) - toFrame(p.start)),
      canvas,
      manyInputs,
      input.still === true
    )
  )

  const still = input.still === true
  let pending: Array<Segment> = []
  let acc: Segment | undefined
  const flush = (): Segment => {
    if (pending.length === 1) return pending[0]!
    const v = g.label("cv")
    const a = still ? "" : g.label("ca")
    const pads = pending.map((s) => still ? `[${s.v}]` : `[${s.v}][${s.a}]`).join("")
    g.add(`${pads}concat=n=${pending.length}:v=1:a=${still ? 0 : 1}[${v}]${still ? "" : `[${a}]`}`)
    return { v, a, frames: pending.reduce((sum, s) => sum + s.frames, 0) }
  }
  placed.forEach((p, i) => {
    const seg = segments[i]!
    const transition = p.clip.transition
    if (i === 0 || !transition) {
      pending.push(seg)
      return
    }
    acc = flush()
    const overlap = Math.max(1, toFrame(placed[i - 1]!.end) - toFrame(p.start))
    const v = g.label("xv")
    const a = still ? "" : g.label("xa")
    g.add(
      `[${acc.v}][${seg.v}]xfade=transition=${XFADE[transition.type] ?? "fade"}:duration=${n(overlap / fps)}:offset=${
        n((acc.frames - overlap) / fps)
      }[${v}]`
    )
    if (!still) g.add(`[${acc.a}][${seg.a}]acrossfade=d=${n(overlap / fps)}:c1=tri:c2=tri[${a}]`)
    pending = [{ v, a, frames: acc.frames + seg.frames - overlap }]
  })
  return flush()
}

const LAYOUT_SCALE = 0.32

/** Box and position of an overlay on the canvas. */
const layoutBox = (layout: Layout, src: SourceInfo, w: number, h: number) => {
  const margin = Math.round(Math.min(w, h) * 0.04)
  switch (layout) {
    case "full":
      return { w, h, x: 0, y: 0, fitted: true }
    case "left_half":
      return { w: Math.round(w / 4) * 2, h, x: 0, y: 0, fitted: true }
    case "right_half":
      return { w: Math.round(w / 4) * 2, h, x: w - Math.round(w / 4) * 2, y: 0, fitted: true }
    case "top_half":
      return { w, h: Math.round(h / 4) * 2, x: 0, y: 0, fitted: true }
    case "bottom_half":
      return { w, h: Math.round(h / 4) * 2, x: 0, y: h - Math.round(h / 4) * 2, fitted: true }
    default: {
      const aspect = src.width > 0 && src.height > 0 ? src.width / src.height : 16 / 9
      let bw = Math.round(w * LAYOUT_SCALE)
      let bh = Math.round(bw / aspect)
      if (bh > h * 0.45) {
        bh = Math.round(h * 0.45)
        bw = Math.round(bh * aspect)
      }
      bw = Math.max(2, Math.round(bw / 2) * 2)
      bh = Math.max(2, Math.round(bh / 2) * 2)
      const right = layout === "pip_top_right" || layout === "pip_bottom_right"
      const bottom = layout === "pip_bottom_left" || layout === "pip_bottom_right"
      return { w: bw, h: bh, x: right ? w - bw - margin : margin, y: bottom ? h - bh - margin : margin, fitted: false }
    }
  }
}

const overlayLayer = (
  g: Graph,
  base: string,
  o: Overlay,
  input: GraphInput,
  manyInputs: boolean,
  audio: Array<string>
): string => {
  const { canvas } = input
  const src = input.source(o.mediaId)
  const seconds = clipDuration(o)
  const index = src.kind === "image"
    ? g.input(imageInput(src, canvas.fps, seconds))
    : g.input(seekInput(src.path, o.in, o.out - o.in + 2 / canvas.fps, manyInputs))
  const box = layoutBox(o.layout, src, canvas.width, canvas.height)
  const raw = g.label("or")
  g.add(`[${index}:v]setpts=(PTS-STARTPTS)/${n(o.speed)},fps=${canvas.fps},trim=end=${n(seconds)}[${raw}]`)
  const fit = box.fitted || o.fit === "card" ? effectiveFit(o.fit, src, box.w, box.h) : "cover"
  const fitted = fitInto(g, raw, fit, src, box.w, box.h, canvas, {
    frames: seconds * canvas.fps,
    zoom: o.zoom,
    card: o.card
  })
  const fades: Array<string> = []
  if (o.fadeIn > 0) fades.push(`fade=t=in:d=${n(o.fadeIn)}:alpha=1`)
  if (o.fadeOut > 0) fades.push(`fade=t=out:st=${n(Math.max(0, seconds - o.fadeOut))}:d=${n(o.fadeOut)}:alpha=1`)
  const layer = g.label("ol")
  g.add(`[${fitted}]format=yuva420p,${fades.length ? `${fades.join(",")},` : ""}setpts=PTS-STARTPTS+${n(o.start)}/TB[${layer}]`)
  const out = g.label("ov")
  g.add(`[${base}][${layer}]overlay=x=${box.x}:y=${box.y}:eof_action=pass:format=auto[${out}]`)
  if (!input.still && src.kind !== "image" && src.hasAudio && o.volume > 0) {
    const a = g.label("oa")
    const delay = Math.round(o.start * 1000)
    g.add(
      [`[${index}:a]asetpts=PTS-STARTPTS`, ...atempo(o.speed), AUDIO_FORMAT, `atrim=end=${n(seconds)}`, `volume=${n(o.volume)}`]
        .concat(o.fadeIn > 0 ? [`afade=t=in:d=${n(o.fadeIn)}`] : [])
        .concat(o.fadeOut > 0 ? [`afade=t=out:st=${n(Math.max(0, seconds - o.fadeOut))}:d=${n(o.fadeOut)}`] : [])
        .concat([`adelay=${delay}:all=1`])
        .join(",") + `[${a}]`
    )
    audio.push(a)
  }
  return out
}

/** Blurs a rectangle of the frame between the region's start and end. */
const blurLayer = (g: Graph, base: string, b: BlurRegion, canvas: Canvas): string => {
  const even = (x: number) => Math.round(x / 2) * 2
  const x = even(Math.min(Math.max(0, b.x), 0.98) * canvas.width)
  const y = even(Math.min(Math.max(0, b.y), 0.98) * canvas.height)
  const w = Math.max(4, Math.min(canvas.width - x, even(b.w * canvas.width)))
  const h = Math.max(4, Math.min(canvas.height - y, even(b.h * canvas.height)))
  const sigma = Math.max(4, Math.min(30, Math.round(Math.min(w, h) / 10)))
  const [keep, patch, blurred, out] = [g.label("bk"), g.label("bp"), g.label("bb"), g.label("bl")]
  g.add(`[${base}]split[${keep}][${patch}]`)
  g.add(`[${patch}]crop=${w}:${h}:${x}:${y},gblur=sigma=${sigma}:steps=3[${blurred}]`)
  g.add(`[${keep}][${blurred}]overlay=${x}:${y}:enable='between(t,${n(b.start)},${n(b.end)})'[${out}]`)
  return out
}

/** Volume expression that lowers audio during speech, with short ramps. */
export const duckExpression = (speech: ReadonlyArray<Range>, depth = 0.75, ramp = 0.2): string | undefined => {
  const merged: Array<Range> = []
  for (const r of [...speech].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1]
    if (last && r.start - last.end < 2 * ramp + 0.3) merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, r.end) }
    else merged.push(r)
  }
  if (merged.length === 0) return undefined
  const terms = merged.map((r) =>
    `clip(min((t-${n(r.start - ramp - 0.05)})/${ramp}\\,(${n(r.end + ramp + 0.05)}-t)/${ramp})\\,0\\,1)`
  )
  return `1-${depth}*min(1\\,${terms.join("+")})`
}

const audioLayer = (g: Graph, a: AudioItem, input: GraphInput, total: number, manyInputs: boolean): string | undefined => {
  if (a.start >= total) return undefined
  const src = input.source(a.mediaId)
  const sourceLength = a.out - a.in
  const wanted = a.loop ? (a.duration ?? total - a.start) : sourceLength
  const length = Math.min(wanted, total - a.start)
  if (length <= 0.01) return undefined
  const index = g.input(seekInput(src.path, a.in, sourceLength, manyInputs))
  const chain = [`[${index}:a]asetpts=PTS-STARTPTS`, AUDIO_FORMAT]
  if (a.loop && wanted > sourceLength) {
    chain.push(`aloop=loop=-1:size=${Math.round(sourceLength * SAMPLE_RATE)}`)
  }
  chain.push(`atrim=end=${n(length)}`, "asetpts=PTS-STARTPTS", `volume=${n(a.volume)}`)
  if (a.fadeIn > 0) chain.push(`afade=t=in:d=${n(a.fadeIn)}`)
  // Music that runs past the end of the video gets a short fade instead of a hard stop.
  const cutShort = wanted > length + 0.05
  const fadeOut = cutShort ? Math.max(a.fadeOut, Math.min(1.5, length / 3)) : a.fadeOut
  if (fadeOut > 0) chain.push(`afade=t=out:st=${n(Math.max(0, length - fadeOut))}:d=${n(fadeOut)}`)
  chain.push(`adelay=${Math.round(a.start * 1000)}:all=1`)
  if (a.duck) {
    const expr = duckExpression(input.speech)
    if (expr) chain.push(`volume='${expr}':eval=frame`)
  }
  const out = g.label("mu")
  g.add(chain.join(",") + `[${out}]`)
  return out
}

/** The full FFmpeg argument list for a render. */
export const buildRender = (input: GraphInput): { readonly args: Array<string>; readonly duration: number } => {
  const { timeline, canvas } = input
  const g = new Graph()
  const fps = canvas.fps
  const total = Math.max(1 / fps, timelineDuration(timeline))
  const totalFrames = Math.max(1, Math.round(total * fps))
  const still = input.still === true
  const manyInputs = timeline.main.length + timeline.overlays.length + timeline.audio.length > 8

  const main = mainTrack(g, input)
  let v: string
  let a: string
  if (main) {
    v = g.label("mv")
    const pad = totalFrames - main.frames
    g.add(
      `[${main.v}]${
        pad > 0 ? `tpad=stop_mode=add:stop=${pad}:color=${hex(canvas.background)},` : ""
      }trim=end_frame=${totalFrames}[${v}]`
    )
    a = main.a
    if (!still) {
      const padded = g.label("ma")
      g.add(`[${main.a}]apad,atrim=end=${n(totalFrames / fps)}[${padded}]`)
      a = padded
    }
  } else {
    v = g.label("bg")
    g.add(`color=c=${hex(canvas.background)}:s=${canvas.width}x${canvas.height}:r=${fps}:d=${n(totalFrames / fps)},format=yuv420p[${v}]`)
    a = still ? "" : silence(g, totalFrames / fps)
  }

  const extraAudio: Array<string> = []
  for (const o of timeline.overlays) {
    if (o.start >= total) continue
    v = overlayLayer(g, v, o, input, manyInputs, extraAudio)
  }
  if (canvas.look) {
    const graded = g.label("look")
    g.add(`[${v}]${LOOKS[canvas.look]}[${graded}]`)
    v = graded
  }
  for (const b of timeline.blurs ?? []) {
    if (b.start >= total) continue
    v = blurLayer(g, v, b, canvas)
  }
  if (input.assPath) {
    const out = g.label("txt")
    const escape = (p: string) => p.replace(/[\\:']/g, "\\$&")
    const fonts = input.fontsDir ? `:fontsdir=${escape(input.fontsDir)}` : ""
    g.add(`[${v}]ass=filename=${escape(input.assPath)}${fonts}[${out}]`)
    v = out
  }
  const vout = g.label("vout")
  g.add(`[${v}]format=yuv420p[${vout}]`)

  if (still) {
    return {
      args: [...g.inputs, "-filter_complex", g.filters.join(";"), "-map", `[${vout}]`, "-frames:v", "1", "-q:v", "3", input.output],
      duration: total
    }
  }

  for (const item of timeline.audio) {
    const label = audioLayer(g, item, input, totalFrames / fps, manyInputs)
    if (label) extraAudio.push(label)
  }
  let aout = a
  if (extraAudio.length > 0) {
    aout = g.label("mix")
    g.add(
      `[${a}]${extraAudio.map((x) => `[${x}]`).join("")}amix=inputs=${
        extraAudio.length + 1
      }:normalize=0:dropout_transition=0:duration=first[${aout}]`
    )
  }
  const afinal = g.label("aout")
  g.add(
    input.quality === "final"
      ? `[${aout}]loudnorm=I=-14:TP=-1.5:LRA=11,${AUDIO_FORMAT}[${afinal}]`
      : `[${aout}]apad=pad_dur=0.3,alimiter=limit=0.95:level=disabled:latency=1,atrim=end=${n(totalFrames / fps)}[${afinal}]`
  )

  const video = input.quality === "final"
    ? ["-c:v", "libx264", "-preset", "faster", "-crf", "19", "-profile:v", "high"]
    : ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "27", "-tune", "fastdecode"]
  return {
    args: [
      ...g.inputs,
      "-filter_complex",
      g.filters.join(";"),
      "-map",
      `[${vout}]`,
      "-map",
      `[${afinal}]`,
      ...video,
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(fps),
      "-c:a",
      "aac",
      "-b:a",
      input.quality === "final" ? "192k" : "128k",
      "-movflags",
      "+faststart",
      "-t",
      n(totalFrames / fps),
      input.output
    ],
    duration: totalFrames / fps
  }
}
