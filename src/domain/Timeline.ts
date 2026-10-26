/**
 * The edit is data. A timeline has one magnetic main track (clips play back to
 * back, so removing a clip closes the gap) plus items placed at absolute times:
 * overlays (B-roll, picture-in-picture), audio (music, sound effects) and text.
 * Items are anchored to the main clip under them, so ripple edits carry them
 * along, the way connected clips work in Final Cut Pro.
 *
 * All times are seconds. `in`/`out` are positions in the source media.
 */

/**
 * auto: cover when the aspect ratio matches the output, otherwise blur.
 * card: the media floats smaller than the frame with rounded corners and a
 * soft shadow, over the output background (good for screen recordings).
 */
export type Fit = "auto" | "cover" | "contain" | "blur" | "card"

/**
 * One point of a zoom animation. `at` is seconds from the start of the clip on
 * the timeline. `x`/`y` is the point of the source frame to center on, 0 to 1.
 * Between points the zoom eases smoothly; before the first and after the last
 * point it holds.
 */
/** Size and vertical offset of a card, as fractions of the frame. */
export interface CardSettings {
  readonly scale?: number | undefined
  readonly y?: number | undefined
}

export interface ZoomKey {
  readonly at: number
  readonly scale: number
  readonly x: number
  readonly y: number
}

export type TransitionType =
  | "crossfade"
  | "fade_black"
  | "fade_white"
  | "wipe_left"
  | "wipe_right"
  | "slide_left"
  | "slide_right"
  | "zoom_in"
  | "dissolve"
  | "smooth_left"
  | "smooth_right"
  | "smooth_up"
  | "smooth_down"
  | "circle_open"
  | "blur"

export interface Transition {
  readonly type: TransitionType
  readonly duration: number
}

export interface MainClip {
  readonly id: string
  readonly mediaId: string
  readonly in: number
  readonly out: number
  readonly speed: number
  readonly volume: number
  readonly fit: Fit
  /** Transition from the previous clip into this one. */
  readonly transition?: Transition | undefined
  readonly zoom?: ReadonlyArray<ZoomKey> | undefined
  readonly card?: CardSettings | undefined
  /** Blank clips only: a soft light drifting across the background, in this color. */
  readonly glow?: string | undefined
  /**
   * Freeze frame: the source time of the one frame this clip holds. in and out
   * then only set the length, and the clip is silent.
   */
  readonly freeze?: number | undefined
}

/** Media id for a blank title card: the output background, no media. */
export const BLANK = "blank"

export type Layout =
  | "full"
  | "pip_top_right"
  | "pip_top_left"
  | "pip_bottom_right"
  | "pip_bottom_left"
  | "left_half"
  | "right_half"
  | "top_half"
  | "bottom_half"

export interface Overlay {
  readonly id: string
  readonly mediaId: string
  readonly start: number
  readonly in: number
  readonly out: number
  readonly speed: number
  readonly layout: Layout
  readonly fit: Fit
  readonly volume: number
  readonly fadeIn: number
  readonly fadeOut: number
  readonly zoom?: ReadonlyArray<ZoomKey> | undefined
  readonly card?: CardSettings | undefined
}

export interface AudioItem {
  readonly id: string
  readonly mediaId: string
  readonly start: number
  readonly in: number
  readonly out: number
  readonly volume: number
  readonly fadeIn: number
  readonly fadeOut: number
  /** Lower this track automatically while the main track has speech. */
  readonly duck: boolean
  /** Repeat the source range until `duration` is filled, or until the end of the video when unset. */
  readonly loop: boolean
  /** Only used with loop: total length on the timeline. */
  readonly duration?: number | undefined
}

export type TextStyle =
  | "title"
  | "headline"
  | "kicker"
  | "subtitle"
  | "lower_third"
  | "caption"
  | "highlight"
  | "cta"
  | "label"
  | "statement"
export type TextPosition = "center" | "top" | "bottom" | "lower_left" | "upper_left" | "upper_right"
export type TextFont = "sans" | "display" | "serif" | "light"
export type TextAnimation = "none" | "fade" | "pop" | "slide_up" | "words" | "typewriter" | "rise" | "zoom"

export interface TextItem {
  readonly id: string
  readonly text: string
  readonly start: number
  readonly end: number
  readonly style: TextStyle
  readonly position: TextPosition
  readonly color?: string | undefined
  /** Box color, #RRGGBB or #RRGGBBAA. Gives any style a box. */
  readonly background?: string | undefined
  /** Font size relative to the style's default. */
  readonly size?: number | undefined
  /** Default depends on style. */
  readonly font?: TextFont | undefined
  /** Pins the top of the text at this height, 0 to 1. Overrides the vertical part of `position`. */
  readonly y?: number | undefined
  readonly animation: TextAnimation
}

/** A blurred rectangle, for hiding private details. Box values are fractions of the frame, 0 to 1. */
export interface BlurRegion {
  readonly id: string
  readonly start: number
  readonly end: number
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export type CaptionStyle = "clean" | "bold" | "karaoke" | "boxed"

export interface CaptionSettings {
  readonly style: CaptionStyle
  readonly position: "bottom" | "center" | "top"
  readonly maxWordsPerLine: number
  readonly uppercase: boolean
  readonly highlightColor: string
}

export interface OutputSettings {
  readonly width: number
  readonly height: number
  readonly fps: number
  readonly background: string
  /** A second color: the background becomes a diagonal gradient from `background` to this. */
  readonly gradient?: string | undefined
  /** A color grade over the whole picture, under text. */
  readonly look?: Look | undefined
}

export type Look = "cinematic" | "mono"

export interface Timeline {
  readonly output: OutputSettings
  readonly main: ReadonlyArray<MainClip>
  readonly overlays: ReadonlyArray<Overlay>
  readonly audio: ReadonlyArray<AudioItem>
  readonly texts: ReadonlyArray<TextItem>
  readonly blurs?: ReadonlyArray<BlurRegion> | undefined
  readonly captions?: CaptionSettings | undefined
}

export interface Project {
  readonly id: string
  readonly name: string
  readonly createdAt: string
  readonly updatedAt: string
  /** Increments on every change, including undo. */
  readonly version: number
  readonly timeline: Timeline
  /** Counters for readable ids: c1, c2, o1, a1, t1, b1. */
  readonly counters: {
    readonly c: number
    readonly o: number
    readonly a: number
    readonly t: number
    readonly b?: number | undefined
  }
  /** Whether output size was chosen explicitly. If not, the first clip decides it. */
  readonly outputLocked: boolean
  readonly undo: ReadonlyArray<HistoryEntry>
  readonly redo: ReadonlyArray<HistoryEntry>
}

export interface HistoryEntry {
  readonly label: string
  readonly timeline: Timeline
  readonly counters: Project["counters"]
  readonly outputLocked: boolean
}

export const emptyTimeline: Timeline = {
  output: { width: 1920, height: 1080, fps: 30, background: "#000000" },
  main: [],
  overlays: [],
  audio: [],
  texts: []
}

export const clipDuration = (clip: { readonly in: number; readonly out: number; readonly speed: number }): number =>
  (clip.out - clip.in) / clip.speed

export interface PlacedClip {
  readonly clip: MainClip
  readonly index: number
  /** Timeline start, after the overlap with the previous clip's transition. */
  readonly start: number
  readonly end: number
}

/** Positions of main clips on the timeline. A transition overlaps the clip with the one before it. */
export const placeMain = (main: ReadonlyArray<MainClip>): ReadonlyArray<PlacedClip> => {
  const placed: Array<PlacedClip> = []
  let cursor = 0
  main.forEach((clip, index) => {
    const overlap = index > 0 && clip.transition ? clip.transition.duration : 0
    const start = Math.max(0, cursor - overlap)
    const end = start + clipDuration(clip)
    placed.push({ clip, index, start, end })
    cursor = end
  })
  return placed
}

export const mainDuration = (main: ReadonlyArray<MainClip>): number => {
  const placed = placeMain(main)
  return placed.length === 0 ? 0 : placed[placed.length - 1]!.end
}

/** Length on the timeline. A loop without a duration runs to `videoEnd`. */
export const audioItemDuration = (item: AudioItem, videoEnd: number): number =>
  item.loop ? (item.duration ?? Math.max(0, videoEnd - item.start)) : item.out - item.in

export const timelineDuration = (timeline: Timeline): number => {
  let end = mainDuration(timeline.main)
  for (const o of timeline.overlays) end = Math.max(end, o.start + clipDuration(o))
  for (const t of timeline.texts) end = Math.max(end, t.end)
  // Audio does not extend the video: music longer than the edit is cut at the end.
  if (end === 0) for (const a of timeline.audio) end = Math.max(end, a.start + (a.duration ?? a.out - a.in))
  return end
}
