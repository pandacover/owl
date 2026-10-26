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

export const FitSchema = d(
  Schema.Literals(["auto", "cover", "contain", "blur"]),
  "How media fills the frame. auto (default) crops when the aspect ratio matches and uses a blurred background when it does not."
)
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
  "zoom_in"
])
export const TransitionSchema = Schema.Struct({
  type: TransitionTypeSchema,
  duration: Schema.optionalKey(d(Seconds, "Seconds, default 0.5."))
}).annotate({ identifier: "Transition", description: "Transition from the previous main clip into this one." })
export const TextStyleSchema = Schema.Literals(["title", "subtitle", "lower_third", "caption", "cta", "label"])
export const TextPositionSchema = Schema.Literals(["center", "top", "bottom", "lower_left", "upper_left", "upper_right"])
export const TextAnimationSchema = Schema.Literals(["none", "fade", "pop", "slide_up"])

const SourceRange = {
  media: Id("Media id, e.g. m_7kq2xd."),
  shot: Schema.optionalKey(d(Schema.Int, "Use this shot's range (shot numbers come from media_get or media_search).")),
  in: Schema.optionalKey(d(TimeInput, "Start inside the source. Default: shot start, or 0.")),
  out: Schema.optionalKey(d(TimeInput, "End inside the source. Default: shot end, or the end of the media.")),
  duration: Schema.optionalKey(d(Seconds, "Length instead of `out`. For images, how long to show it (default 3s)."))
}

export const ClipInput = Schema.Struct({
  ...SourceRange,
  speed: Schema.optionalKey(Speed),
  volume: Schema.optionalKey(Volume),
  fit: Schema.optionalKey(FitSchema),
  transition: Schema.optionalKey(TransitionSchema)
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
  "Add music, a voiceover or a sound effect. Music past the end of the video is cut with a short fade."
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
    color: Schema.optionalKey(Color),
    animation: Schema.optionalKey(d(TextAnimationSchema, "Default fade."))
  }),
  "Add a title, lower third, call to action or label."
)

export const Update = d(
  Schema.Struct({
    op: Schema.Literal("update"),
    id: Id("Any item id: c (main clip), o (overlay), a (audio) or t (text)."),
    in: Schema.optionalKey(TimeInput),
    out: Schema.optionalKey(TimeInput),
    start: Schema.optionalKey(TimeInput),
    end: Schema.optionalKey(TimeInput),
    duration: Schema.optionalKey(Seconds),
    speed: Schema.optionalKey(Speed),
    volume: Schema.optionalKey(Volume),
    fit: Schema.optionalKey(FitSchema),
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
    animation: Schema.optionalKey(TextAnimationSchema)
  }),
  "Change fields of one item. Only fields that apply to that item type are accepted. transition: null removes it."
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
    background: Schema.optionalKey(Color)
  }),
  "Set the output frame size, frame rate or background color."
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
  Update,
  Delete,
  SetCaptions,
  SetOutput
])
export type EditOp = typeof EditOp.Type
