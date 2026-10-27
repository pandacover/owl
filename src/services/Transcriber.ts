import { Context, Effect, FileSystem, Layer, Schema } from "effect"
import { OwlConfig } from "../Config.ts"
import { AiError } from "../domain/Errors.ts"
import type { Transcript, TranscriptSegment, Word } from "../domain/Media.ts"
import { Ffmpeg } from "./Ffmpeg.ts"
import { WorkersAi } from "./WorkersAi.ts"

const WhisperOutput = Schema.Struct({
  transcription_info: Schema.optionalKey(Schema.Struct({ language: Schema.optionalKey(Schema.String) })),
  segments: Schema.optionalKey(Schema.Array(Schema.Struct({
    start: Schema.Number,
    end: Schema.Number,
    text: Schema.String,
    no_speech_prob: Schema.optionalKey(Schema.Number),
    avg_logprob: Schema.optionalKey(Schema.Number),
    words: Schema.optionalKey(Schema.Array(Schema.Struct({
      word: Schema.String,
      start: Schema.Number,
      end: Schema.Number
    })))
  })))
})
const decodeWhisper = Schema.decodeUnknownEffect(WhisperOutput)

export interface TranscriberShape {
  readonly available: boolean
  /**
   * Transcribes a 16 kHz mono MP3. Long audio is split at quiet points and
   * the chunks are transcribed in parallel.
   */
  readonly transcribe: (
    file: string,
    duration: number,
    silences: ReadonlyArray<readonly [number, number]>,
    workDir: string
  ) => Effect.Effect<Transcript, AiError>
}

const CHUNK_TARGET = 150
const round3 = (n: number) => Math.round(n * 1000) / 1000

/** Chunk boundaries near every CHUNK_TARGET seconds, moved into the nearest silence when one is close. */
export const planChunks = (
  duration: number,
  silences: ReadonlyArray<readonly [number, number]>
): Array<readonly [number, number]> => {
  const cuts: Array<number> = [0]
  let next = CHUNK_TARGET
  while (next < duration - 20) {
    const nearby = silences
      .map(([a, b]) => (a + b) / 2)
      .filter((mid) => Math.abs(mid - next) < 25 && mid > cuts[cuts.length - 1]! + 30)
      .sort((a, b) => Math.abs(a - next) - Math.abs(b - next))
    const cut = nearby[0] ?? next
    cuts.push(cut)
    next = cut + CHUNK_TARGET
  }
  cuts.push(duration)
  return cuts.slice(0, -1).map((start, i) => [start, cuts[i + 1]!] as const)
}

// Whisper sometimes emits these on music or silence.
const HALLUCINATION = /^[\s♪♫.,!?-]*$|^(thank you\.?|thanks for watching!?|subtitles by .*)$/i

export class Transcriber extends Context.Service<Transcriber, TranscriberShape>()("owl/Transcriber") {
  static readonly layer = Layer.effect(
    Transcriber,
    Effect.gen(function*() {
      const config = yield* OwlConfig
      const ai = yield* WorkersAi
      const ffmpeg = yield* Ffmpeg
      const fs = yield* FileSystem.FileSystem
      const available = config.transcriber === "workers-ai" && ai.available

      const transcribeChunk = (file: string, offset: number) =>
        Effect.gen(function*() {
          const bytes = yield* fs.readFile(file).pipe(
            Effect.mapError((e) => new AiError({ service: "transcribe", message: e.message }))
          )
          const raw = yield* ai.run(config.transcribeModel, {
            audio: Buffer.from(bytes).toString("base64"),
            condition_on_previous_text: false,
            vad_filter: true
          })
          const output = yield* decodeWhisper(raw).pipe(
            Effect.mapError((e) => new AiError({ service: "transcribe", message: `Unexpected response: ${e.message}` }))
          )
          const segments: Array<TranscriptSegment> = []
          for (const s of output.segments ?? []) {
            const text = s.text.trim()
            if (!text || HALLUCINATION.test(text)) continue
            if ((s.no_speech_prob ?? 0) > 0.6 && (s.avg_logprob ?? 0) < -1) continue
            const words: Array<Word> = (s.words ?? [])
              .map((w) => ({ w: w.word.trim(), s: round3(w.start + offset), e: round3(w.end + offset) }))
              .filter((w) => w.w.length > 0)
            segments.push({ start: round3(s.start + offset), end: round3(s.end + offset), text, words })
          }
          return { language: output.transcription_info?.language, segments }
        })

      const transcribe = (
        file: string,
        duration: number,
        silences: ReadonlyArray<readonly [number, number]>,
        workDir: string
      ) =>
        Effect.gen(function*() {
          if (!available) return yield* new AiError({ service: "transcribe", message: "Transcription is not configured." })
          const chunks = planChunks(duration, silences)
          const results = yield* Effect.forEach(chunks, ([start, end], i) =>
            Effect.gen(function*() {
              if (chunks.length === 1) return yield* transcribeChunk(file, 0)
              const part = `${workDir}/speech-${i}.mp3`
              yield* ffmpeg.run(["-ss", String(start), "-t", String(end - start), "-i", file, "-c", "copy", part]).pipe(
                Effect.mapError((e) => new AiError({ service: "transcribe", message: e.message }))
              )
              return yield* transcribeChunk(part, start)
            }), { concurrency: 4 })
          return {
            language: results.find((r) => r.language)?.language,
            segments: results.flatMap((r) => r.segments)
          } satisfies Transcript
        })

      return Transcriber.of({ available, transcribe })
    })
  )
}
