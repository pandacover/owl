import { Schema } from "effect"
import { TimeInput } from "../domain/Time.ts"

/**
 * The edit operations an agent can send in one timeline_edit call. Field names
 * are snake_case because they are part of the agent-facing tool schema.
 *
 * Times named `in`/`out` are positions inside the source media. All other
 * times (`start`, `end`, `at`) are positions on the edited timeline.
 */

const d = <S extends Schema.Top>(schema: S, description: string) => schema.annotate({ description }) as S

const Id = (what: string) => d(Schema.String, what)
const Volume = d(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 4 })), "1 is original volume, 0 is muted.")
const Speed = d(Schema.Finite.check(Schema.isBetween({ minimum: 0.1, maximum: 10 })), "Playback speed. 1 is normal, 2 is twice as fast.")
const Seconds = d(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)), "Seconds.")
const Color = d(Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)), "Hex color like #FFD400.")
const BoxColor = d(
  Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/)),
  "Box behind the text, in this color. Works on every style; highlight, cta, label and lower_third always have a box and this sets its color (color only sets the letters). Add 2 hex digits for opacity, e.g. #0B0B0FB3 for a 70% dark box. Use a box whenever text sits on a light or busy picture."
)
const TextSize = d(Schema.Number.check(Schema.isBetween({ minimum: 0.4, maximum: 2.5 })), "Font size relative to the style's default (1). 0.8 is smaller, 1.3 bigger.")

export const FitSchema = d(
  Schema.Literals(["auto", "cover", "contain", "blur", "card"]),
  "How media fills the frame. auto (default) crops when the aspect ratio matches and uses a blurred background when it does not. card floats the media smaller with rounded corners and a soft shadow over the output background (set a color or gradient with set_output): the premium look for screen recordings and product shots."
)
const Fraction = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
export const ZoomKeySchema = Schema.Struct({
  at: d(Seconds, "Seconds from the start of the clip (on the timeline)."),
  scale: d(Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 5 })), "1 shows the whole frame, 2 is a 2x zoom."),
  x: Schema.optionalKey(d(Fraction, "Point to center on, across the source frame: 0 left, 1 right. Default 0.5.")),
  y: Schema.optionalKey(d(Fraction, "Point to center on, down the source frame: 0 top, 1 bottom. Default 0.5."))
}).annotate({ identifier: "ZoomKey" })
export const ZoomSchema = d(
  Schema.Array(ZoomKeySchema).check(Schema.isMaxLength(24)),
  "Zoom and pan keyframes. Moves ease smoothly between keys and hold before the first and after the last. Example punch-in on a tap at the lower right: [{at:0,scale:1},{at:0.6,scale:1.8,x:0.7,y:0.8},{at:2,scale:1.8,x:0.7,y:0.8},{at:2.5,scale:1}]."
)
export const CardSchema = Schema.Struct({
  scale: Schema.optionalKey(d(Schema.Finite.check(Schema.isBetween({ minimum: 0.2, maximum: 1 })), "Card size relative to the frame. Default 0.8.")),
  y: Schema.optionalKey(d(Schema.Finite.check(Schema.isBetween({ minimum: -0.5, maximum: 0.5 })), "Move the card down (positive) or up, as a fraction of frame height. Leave room for a headline. Default 0."))
}).annotate({ identifier: "Card", description: "Only with fit card." })
export const LayoutSchema = Schema.Literals([
  "full",
  "pip_top_right",
  "pip_top_left",
  "pip_bottom_right",
  "pip_bottom_left",
  "left_half",
  "right_half",
  "top_half",
  "bottom_half"
])
export const TransitionTypeSchema = Schema.Literals([
  "crossfade",
  "dissolve",
  "fade_black",
  "fade_white",
  "wipe_left",
  "wipe_right",
  "slide_left",
  "slide_right",
  "zoom_in",
  "smooth_left",
  "smooth_right",
  "smooth_up",
  "smooth_down",
  "circle_open",
  "blur"
])
export const TransitionSchema = Schema.Struct({
  type: TransitionTypeSchema,
  duration: Schema.optionalKey(d(Seconds, "Seconds, default 0.5."))
}).annotate({ identifier: "Transition", description: "Transition from the previous main clip into this one." })
export const TextStyleSchema = d(
  Schema.Literals(["title", "headline", "kicker", "subtitle", "lower_third", "caption", "highlight", "cta", "label", "statement"]),
  "statement: medium thin text with no box, for calm cinematic lines and quotes (default font light). headline: very large heavy display type for hooks. title: large display type. kicker: small spaced uppercase line above a headline. subtitle and caption: supporting lines. highlight: text on a solid box (default white box, dark text). cta: call to action on a colored box. lower_third: name strip. label: small tag."
)
export const TextPositionSchema = Schema.Literals(["center", "top", "bottom", "lower_left", "upper_left", "upper_right"])
export const TextAnimationSchema = d(
  Schema.Literals(["none", "fade", "pop", "slide_up", "rise", "zoom", "words", "typewriter"]),
  "words: words appear one by one (great for headlines). typewriter: letters appear one by one. rise: soft slide up. zoom: settles in from slightly larger. pop: bouncy scale."
)
export const TextFontSchema = d(
  Schema.Literals(["sans", "display", "serif", "light"]),
  "sans: Inter. display: Inter Display, heavy and tight (default for title, headline, highlight, cta). serif: Instrument Serif, elegant editorial look. light: Inter Display Light, thin and calm (cinematic, premium tech)."
)

const SourceRange = {
  media: Id("Media id, e.g. m_7kq2xd. On the main track, \"blank\" is a title card: the output background (or gradient) for `duration` seconds, for text on a clean frame."),
  shot: Schema.optionalKey(d(Schema.Int, "Use this shot's range (shot numbers come from media_get or media_search).")),
  moment: Schema.optionalKey(d(Schema.Int, "With shot: use only this moment of the shot (one step of a screen recording, listed under the shot in media_get).")),
  in: Schema.optionalKey(d(TimeInput, "Start inside the source. Default: shot start, or 0.")),
  out: Schema.optionalKey(d(TimeInput, "End inside the source. Default: shot end, or the end of the media.")),
  duration: Schema.optionalKey(d(Seconds, "Length instead of `out`. For images, how long to show it (default 3s)."))
}

export const ClipInput = Schema.Struct({
  ...SourceRange,
  speed: Schema.optionalKey(Speed),
  volume: Schema.optionalKey(Volume),
  fit: Schema.optionalKey(FitSchema),
  card: Schema.optionalKey(CardSchema),
  zoom: Schema.optionalKey(ZoomSchema),
  transition: Schema.optionalKey(TransitionSchema),
  glow: Schema.optionalKey(d(Color, "Blank clips only: a soft light in this color drifting across the card, e.g. #9FB6CF on a near-black background.")),
  freeze: Schema.optionalKey(d(Seconds, "Freeze frame: hold one frame for this many seconds instead of playing, silent. The frame is `in` if given, else the settled frame of `moment` (the one preview_frames shows), else the last frame of the shot or range. Zoom works on it. Typical: play a step, then freeze on its result for 1 to 2s."))
}).annotate({ identifier: "Clip", description: "A piece of a media file for the main track." })
export type ClipInput = typeof ClipInput.Type

const Position = {
  after: Schema.optionalKey(Id("Insert after this main clip id.")),
  before: Schema.optionalKey(Id("Insert before this main clip id.")),
  at: Schema.optionalKey(d(TimeInput, "Insert at this timeline time, splitting the clip there if needed."))
}

export const AddClips = d(
  Schema.Struct({
    op: Schema.Literal("add_clips"),
    clips: Schema.Array(ClipInput).check(Schema.isMinLength(1)),
    ...Position
  }),
  "Insert clips into the main track. Appends to the end unless after/before/at is given. Later clips ripple."
)

export const SetMain = d(
  Schema.Struct({ op: Schema.Literal("set_main"), clips: Schema.Array(ClipInput) }),
  "Replace the whole main track with these clips in order. Fastest way to lay out a first cut."
)

export const TrimClip = d(
  Schema.Struct({
    op: Schema.Literal("trim_clip"),
    clip: Id("Main clip id."),
    in: Schema.optionalKey(d(TimeInput, "New start inside the source.")),
    out: Schema.optionalKey(d(TimeInput, "New end inside the source."))
  }),
  "Change which part of the source a main clip uses. Later clips ripple."
)

export const SplitClip = d(
  Schema.Struct({ op: Schema.Literal("split_clip"), at: d(TimeInput, "Timeline time to cut at.") }),
  "Cut the main clip under this time into two clips. The right part gets a new id."
)

export const DeleteRange = d(
  Schema.Struct({ op: Schema.Literal("delete_range"), start: TimeInput, end: TimeInput }),
  "Remove a timeline range from the main track and close the gap. Overlays and text inside the range are removed."
)

export const MoveClip = d(
  Schema.Struct({
    op: Schema.Literal("move_clip"),
    clip: Id("Main clip id."),
    after: Schema.optionalKey(Id("Move after this main clip id.")),
    before: Schema.optionalKey(Id("Move before this main clip id.")),
    to: Schema.optionalKey(Schema.Literals(["start", "end"]))
  }),
  "Reorder a main clip. Overlays and text over it move with it."
)

export const AddOverlay = d(
  Schema.Struct({
    op: Schema.Literal("add_overlay"),
    ...SourceRange,
    start: d(TimeInput, "Timeline time where the overlay appears."),
    layout: Schema.optionalKey(d(LayoutSchema, "Default full (B-roll over the main track).")),
    fit: Schema.optionalKey(FitSchema),
    card: Schema.optionalKey(CardSchema),
    zoom: Schema.optionalKey(ZoomSchema),
    volume: Schema.optionalKey(d(Volume, "Default 0: B-roll is muted so the main audio continues.")),
    speed: Schema.optionalKey(Speed),
    fade_in: Schema.optionalKey(Seconds),
    fade_out: Schema.optionalKey(Seconds)
  }),
  "Place video or an image above the main track: B-roll cutaways, picture-in-picture, split screen, logos."
)

export const AddAudio = d(
  Schema.Struct({
    op: Schema.Literal("add_audio"),
    media: Id("Media id of music or a sound effect (any media with audio)."),
    start: Schema.optionalKey(d(TimeInput, "Timeline time. Default 0.")),
    in: Schema.optionalKey(d(TimeInput, "Start inside the source. Default 0.")),
    out: Schema.optionalKey(d(TimeInput, "End inside the source. Default end of media.")),
    volume: Schema.optionalKey(d(Volume, "Default 1. Background music usually sits around 0.3.")),
    fade_in: Schema.optionalKey(Seconds),
    fade_out: Schema.optionalKey(Seconds),
    duck: Schema.optionalKey(d(Schema.Boolean, "Lower this audio while someone speaks in the main track. Default true.")),
    fill: Schema.optionalKey(d(Schema.Boolean, "Loop to fill until the end of the video. Default false.")),
    duration: Schema.optionalKey(d(Seconds, "Loop to exactly this length."))
  }),
  "Add music, a voiceover or a sound effect. Music past the end of the video is cut with a short fade. For a long track, add 2 or 3 pieces (in/out) that follow the edit's energy; media_get lists the track's parts and rises (edit_guide music)."
)

export const AddText = d(
  Schema.Struct({
    op: Schema.Literal("add_text"),
    text: d(Schema.String.check(Schema.isMinLength(1)), "Use \\n for a line break."),
    start: TimeInput,
    end: Schema.optionalKey(TimeInput),
    duration: Schema.optionalKey(d(Seconds, "Instead of end. Default 3s.")),
    style: Schema.optionalKey(d(TextStyleSchema, "Default title.")),
    position: Schema.optionalKey(d(TextPositionSchema, "Default depends on style.")),
    color: Schema.optionalKey(d(Color, "Color of the letters.")),
    background: Schema.optionalKey(BoxColor),
    size: Schema.optionalKey(TextSize),
    font: Schema.optionalKey(TextFontSchema),
    y: Schema.optionalKey(d(Fraction, "Pin the top of the text at this height (0 top, 1 bottom) instead of the position's default. Use it to stack a kicker above a headline.")),
    animation: Schema.optionalKey(d(TextAnimationSchema, "Default fade."))
  }),
  "Add a headline, title, kicker, caption, highlight, call to action, lower third or label."
)

export const AddBlur = d(
  Schema.Struct({
    op: Schema.Literal("add_blur"),
    start: TimeInput,
    end: Schema.optionalKey(TimeInput),
    duration: Schema.optionalKey(d(Seconds, "Instead of end. Default: to the end of the main clip under start.")),
    x: d(Fraction, "Left edge, as a fraction of the output frame width."),
    y: d(Fraction, "Top edge, as a fraction of the output frame height."),
    w: d(Fraction, "Width, as a fraction of the frame."),
    h: d(Fraction, "Height, as a fraction of the frame.")
  }),
  "Blur a rectangle of the output frame, to hide private details (names, phone numbers, notifications, faces). Check placement with preview_frames."
)

export const Update = d(
  Schema.Struct({
    op: Schema.Literal("update"),
    id: Id("Any item id: c (main clip), o (overlay), a (audio), t (text) or b (blur)."),
    in: Schema.optionalKey(TimeInput),
    out: Schema.optionalKey(TimeInput),
    start: Schema.optionalKey(TimeInput),
    end: Schema.optionalKey(TimeInput),
    duration: Schema.optionalKey(Seconds),
    speed: Schema.optionalKey(Speed),
    volume: Schema.optionalKey(Volume),
    fit: Schema.optionalKey(FitSchema),
    card: Schema.optionalKey(CardSchema),
    zoom: Schema.optionalKey(Schema.NullOr(ZoomSchema)),
    glow: Schema.optionalKey(Schema.NullOr(Color)),
    freeze: Schema.optionalKey(d(Seconds, "Freeze frame clips: new hold length.")),
    transition: Schema.optionalKey(Schema.NullOr(TransitionSchema)),
    layout: Schema.optionalKey(LayoutSchema),
    fade_in: Schema.optionalKey(Seconds),
    fade_out: Schema.optionalKey(Seconds),
    duck: Schema.optionalKey(Schema.Boolean),
    fill: Schema.optionalKey(Schema.Boolean),
    text: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
    style: Schema.optionalKey(TextStyleSchema),
    position: Schema.optionalKey(TextPositionSchema),
    color: Schema.optionalKey(Schema.NullOr(Color)),
    background: Schema.optionalKey(Schema.NullOr(BoxColor)),
    size: Schema.optionalKey(TextSize),
    font: Schema.optionalKey(TextFontSchema),
    animation: Schema.optionalKey(TextAnimationSchema),
    x: Schema.optionalKey(Fraction),
    y: Schema.optionalKey(d(Schema.NullOr(Fraction), "Text: pinned height, null to unpin. Blur: top edge.")),
    w: Schema.optionalKey(Fraction),
    h: Schema.optionalKey(Fraction)
  }),
  "Change fields of one item. Only fields that apply to that item type are accepted. transition: null and zoom: null remove them."
)

export const Delete = d(
  Schema.Struct({ op: Schema.Literal("delete"), ids: Schema.Array(Schema.String).check(Schema.isMinLength(1)) }),
  "Delete items by id. Deleting main clips closes the gap."
)

export const SetCaptions = d(
  Schema.Struct({
    op: Schema.Literal("set_captions"),
    enabled: Schema.Boolean,
    style: Schema.optionalKey(d(
      Schema.Literals(["clean", "bold", "karaoke", "boxed"]),
      "clean: white text with outline. bold: large uppercase-friendly. karaoke: highlights the spoken word. boxed: text on a dark box. Default bold."
    )),
    position: Schema.optionalKey(Schema.Literals(["bottom", "center", "top"])),
    max_words_per_line: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12 }))),
    uppercase: Schema.optionalKey(Schema.Boolean),
    highlight_color: Schema.optionalKey(Color)
  }),
  "Burn in captions generated from the speech in the main track."
)

export const SetOutput = d(
  Schema.Struct({
    op: Schema.Literal("set_output"),
    aspect: Schema.optionalKey(d(
      Schema.Literals(["16:9", "9:16", "1:1", "4:5"]),
      "Preset size: 16:9 is 1920x1080, 9:16 is 1080x1920 (Reels, TikTok, Shorts), 1:1 is 1080x1080, 4:5 is 1080x1350."
    )),
    width: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 128, maximum: 3840 }))),
    height: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 128, maximum: 3840 }))),
    fps: Schema.optionalKey(Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 60 }))),
    background: Schema.optionalKey(d(Color, "Background color, seen around contain and card media.")),
    gradient: Schema.optionalKey(d(Schema.NullOr(Color), "Second color: the background becomes a diagonal gradient from background to this. null for a flat color.")),
    look: Schema.optionalKey(d(
      Schema.NullOr(Schema.Literals(["cinematic", "warm", "clean", "mono"])),
      "Color grade over the whole picture (text stays clean). cinematic: film contrast, cool shadows, warm highlights, vignette and fine grain; best on dark footage, it tints white and cream app screens. warm: gentle warmth, soft vignette and grain; keeps light UIs true. clean: a little contrast and color, soft vignette, no tint. mono: rich black and white. null for none."
    ))
  }),
  "Set the output frame size, frame rate or background."
)

export const EditOp = Schema.Union([
  AddClips,
  SetMain,
  TrimClip,
  SplitClip,
  DeleteRange,
  MoveClip,
  AddOverlay,
  AddAudio,
  AddText,
  AddBlur,
  Update,
  Delete,
  SetCaptions,
  SetOutput
])
export type EditOp = typeof EditOp.Type
