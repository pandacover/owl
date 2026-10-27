import Anthropic from "@anthropic-ai/sdk"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { OwlConfig } from "../Config.ts"
import { AiError } from "../domain/Errors.ts"
import type { ShotCaption } from "../domain/Media.ts"
import { formatRange, formatTime, round1 } from "../domain/Time.ts"

export interface ShotForCaption {
  readonly index: number
  readonly start: number
  readonly end: number
  readonly motionLabel: string
  readonly frames: ReadonlyArray<Uint8Array>
  /** Source time of each frame. */
  readonly frameTimes: ReadonlyArray<number>
  /** The frames are one per moment (a step of a screen recording or a still shot). */
  readonly moments: boolean
  /** Words spoken during the shot, when there is a transcript. */
  readonly speech?: string | undefined
}

export interface VisionShape {
  readonly available: boolean
  readonly model: string
  /** Captions a batch of shots from one video in a single request. */
  readonly captionShots: (
    mediaName: string,
    shots: ReadonlyArray<ShotForCaption>
  ) => Effect.Effect<ReadonlyMap<number, ShotCaption>, AiError>
}

const SHOT_TYPES = ["extreme_wide", "wide", "medium", "close_up", "extreme_close_up", "macro", "aerial", "screen", "graphic", "other"] as const
const CAMERA_MOTIONS = ["static", "pan", "tilt", "zoom_in", "zoom_out", "push_in", "pull_out", "tracking", "handheld", "orbit", "other"] as const

const CaptionJson = Schema.Struct({
  shots: Schema.Array(Schema.Struct({
    shot: Schema.Int,
    description: Schema.String,
    subjects: Schema.Array(Schema.String),
    setting: Schema.String,
    shot_type: Schema.String,
    camera_motion: Schema.String,
    on_screen_text: Schema.String,
    tags: Schema.Array(Schema.String),
    appeal: Schema.Int,
    issues: Schema.String,
    frame_notes: Schema.Array(Schema.String)
  }))
})
const decodeCaptions = Schema.decodeUnknownEffect(Schema.fromJsonString(CaptionJson))

const stringArray = { type: "array", items: { type: "string" } }
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["shots"],
  properties: {
    shots: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["shot", "description", "subjects", "setting", "shot_type", "camera_motion", "on_screen_text", "tags", "appeal", "issues", "frame_notes"],
        properties: {
          shot: { type: "integer" },
          description: { type: "string" },
          subjects: stringArray,
          setting: { type: "string" },
          shot_type: { type: "string", enum: SHOT_TYPES },
          camera_motion: { type: "string", enum: CAMERA_MOTIONS },
          on_screen_text: { type: "string" },
          tags: stringArray,
          appeal: { type: "integer", enum: [1, 2, 3, 4, 5] },
          issues: { type: "string" },
          frame_notes: stringArray
        }
      }
    }
  }
}

const SYSTEM = `You log footage for a video editor. An editing agent will search your notes to find shots, so be concrete and literal.

For each shot you get its time range and frames sampled from it, in order. Describe what is visible:
- description: one plain sentence, what is shown and what happens across the frames (e.g. "Hand pours iced coffee into a glass on a marble counter, slow push-in.").
- subjects: the main people, products, objects or animals, as short nouns. Name a brand or product only when it is clearly readable.
- setting: where it takes place, a few words.
- shot_type and camera_motion: judge from the frames; when motion between frames is unclear, use "static" or "other".
- on_screen_text: any readable text or logos, verbatim. Empty string if none.
- tags: 3 to 8 lowercase search words (mood, colors, action, product category, b-roll type).
- appeal: 1 to 5, how usable and attractive the shot is for a polished edit (5 = hero shot, 1 = unusable).
- issues: problems like blur, shaky camera, bad exposure, a black or transition frame, and private details an ad should hide (phone numbers, contact names, emails, notification badges, personal messages). Empty string if none.
- frame_notes: one short note per frame, in order (same count as frames). Say what is on screen at that frame and what changed since the previous frame. For screen recordings name the screen and the action, e.g. "Notes tab open: library with two notes" or "Share sheet open, Add to Home Screen highlighted". These notes let the editor cut to the exact step.

Do not guess names of people. Return one entry per shot, using the shot numbers given.`

export class Vision extends Context.Service<Vision, VisionShape>()("owl/Vision") {
  static readonly layer = Layer.effect(
    Vision,
    Effect.gen(function*() {
      const config = yield* OwlConfig
      const client = Option.map(config.anthropicApiKey, (key) => new Anthropic({ apiKey: Redacted.value(key) }))

      const captionShots = (mediaName: string, shots: ReadonlyArray<ShotForCaption>) =>
        Effect.gen(function*() {
          if (Option.isNone(client)) {
            return yield* new AiError({ service: "vision", message: "ANTHROPIC_API_KEY is not set." })
          }
          const content: Array<Anthropic.Beta.BetaContentBlockParam> = [
            { type: "text", text: `Source file: ${mediaName}. ${shots.length} shot(s) follow.` }
          ]
          for (const shot of shots) {
            const header = `Shot ${shot.index} (${formatRange(shot.start, shot.end)}, ${round1(shot.end - shot.start)}s, ` +
              `measured motion: ${shot.motionLabel}, ${shot.frames.length} frame(s)` +
              `${shot.moments ? ", one frame per step where the picture changed" : ""})` +
              (shot.speech ? `. Speech during the shot: "${shot.speech.slice(0, 300)}"` : "")
            content.push({ type: "text", text: header })
            shot.frames.forEach((frame, i) => {
              content.push({ type: "text", text: `Frame ${i + 1} at ${formatTime(shot.frameTimes[i] ?? shot.start)}` })
              content.push({
                type: "image",
                source: { type: "base64", media_type: "image/jpeg", data: Buffer.from(frame).toString("base64") }
              })
            })
          }
          const response = yield* Effect.tryPromise({
            try: (signal) =>
              client.value.beta.messages.create({
                model: config.visionModel,
                max_tokens: 8000,
                betas: ["server-side-fallback-2026-07-01"],
                fallbacks: "default",
                output_config: { effort: "low", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
                system: SYSTEM,
                messages: [{ role: "user", content }]
              }, { signal }),
            catch: (error) =>
              new AiError({
                service: "vision",
                message: error instanceof Anthropic.APIError ? `Claude API ${error.status}: ${error.message}` : String(error)
              })
          })
          if (response.stop_reason === "refusal") {
            return yield* new AiError({ service: "vision", message: "Claude declined to describe these frames." })
          }
          const text = response.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("")
          const parsed = yield* decodeCaptions(text).pipe(
            Effect.mapError((e) => new AiError({ service: "vision", message: `Could not parse captions: ${e.message}` }))
          )
          const result = new Map<number, ShotCaption>()
          for (const s of parsed.shots) {
            result.set(s.shot, {
              description: s.description,
              subjects: s.subjects,
              setting: s.setting,
              shotType: s.shot_type,
              cameraMotion: s.camera_motion,
              onScreenText: s.on_screen_text,
              tags: s.tags,
              appeal: Math.min(5, Math.max(1, s.appeal)),
              issues: s.issues,
              notes: s.frame_notes
            })
          }
          return result as ReadonlyMap<number, ShotCaption>
        })

      return Vision.of({ available: Option.isSome(client), model: config.visionModel, captionShots })
    })
  )
}
