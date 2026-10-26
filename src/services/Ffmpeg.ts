import { Context, Effect, Layer, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { Probe } from "../domain/Media.ts"
import { FfmpegError } from "../domain/Errors.ts"

export interface RunOptions {
  /** Expected output duration, used to turn FFmpeg's clock into a 0..1 progress value. */
  readonly duration?: number | undefined
  readonly onProgress?: ((fraction: number) => Effect.Effect<void>) | undefined
  readonly cwd?: string | undefined
}

export interface FfmpegShape {
  readonly probe: (file: string) => Effect.Effect<Probe, FfmpegError>
  /** Runs ffmpeg with the given arguments (without the binary name). */
  readonly run: (args: ReadonlyArray<string>, options?: RunOptions) => Effect.Effect<void, FfmpegError>
  /** Runs ffmpeg and collects stdout, for raw PCM or metadata output. */
  readonly runCollect: (args: ReadonlyArray<string>) => Effect.Effect<Uint8Array, FfmpegError>
}

const ProbeJson = Schema.Struct({
  streams: Schema.Array(Schema.Struct({
    codec_type: Schema.optionalKey(Schema.String),
    codec_name: Schema.optionalKey(Schema.String),
    width: Schema.optionalKey(Schema.Number),
    height: Schema.optionalKey(Schema.Number),
    avg_frame_rate: Schema.optionalKey(Schema.String),
    r_frame_rate: Schema.optionalKey(Schema.String),
    sample_rate: Schema.optionalKey(Schema.String),
    channels: Schema.optionalKey(Schema.Number),
    duration: Schema.optionalKey(Schema.String),
    nb_frames: Schema.optionalKey(Schema.String),
    disposition: Schema.optionalKey(Schema.Struct({ attached_pic: Schema.optionalKey(Schema.Number) })),
    tags: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    side_data_list: Schema.optionalKey(Schema.Array(Schema.Struct({ rotation: Schema.optionalKey(Schema.Number) })))
  })),
  format: Schema.Struct({
    duration: Schema.optionalKey(Schema.String),
    size: Schema.optionalKey(Schema.String),
    bit_rate: Schema.optionalKey(Schema.String),
    format_name: Schema.optionalKey(Schema.String)
  })
})
const decodeProbe = Schema.decodeUnknownEffect(Schema.fromJsonString(ProbeJson))

const parseRate = (rate: string | undefined): number => {
  if (!rate) return 0
  const [n, d] = rate.split("/").map(Number)
  if (!n || !d) return 0
  return n / d
}

const IMAGE_FORMATS = new Set(["image2", "png_pipe", "jpeg_pipe", "webp_pipe", "gif", "bmp_pipe", "tiff_pipe"])

export const toProbe = (raw: typeof ProbeJson.Type): Probe => {
  const video = raw.streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1)
  const audio = raw.streams.find((s) => s.codec_type === "audio")
  const formatName = raw.format.format_name ?? ""
  const isImage = video !== undefined && (IMAGE_FORMATS.has(formatName) || (formatName.includes("image") && !audio))
  const rotationRaw = video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ??
    Number(video?.tags?.["rotate"] ?? 0)
  const rotation = ((Math.round(rotationRaw) % 360) + 360) % 360
  const swap = rotation === 90 || rotation === 270
  const width = video?.width ?? 0
  const height = video?.height ?? 0
  const duration = Number(raw.format.duration ?? video?.duration ?? audio?.duration ?? 0)
  let fps = parseRate(video?.avg_frame_rate)
  if (!(fps > 0 && fps < 240)) fps = parseRate(video?.r_frame_rate)
  if (!(fps > 0 && fps < 240)) fps = 30
  return {
    kind: isImage ? "image" : video ? "video" : "audio",
    duration: isImage ? 0 : duration,
    width: swap ? height : width,
    height: swap ? width : height,
    fps: isImage ? 30 : Math.round(fps * 1000) / 1000,
    hasVideo: video !== undefined,
    hasAudio: audio !== undefined,
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : undefined,
    channels: audio?.channels,
    rotation,
    bytes: Number(raw.format.size ?? 0),
    bitrate: raw.format.bit_rate ? Number(raw.format.bit_rate) : undefined
  }
}

const STDERR_TAIL = 4000

export class Ffmpeg extends Context.Service<Ffmpeg, FfmpegShape>()("owl/Ffmpeg") {
  static readonly layer = Layer.effect(
    Ffmpeg,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const probe = (file: string) =>
        spawner.string(ChildProcess.make("ffprobe", [
          "-v",
          "error",
          "-print_format",
          "json",
          "-show_format",
          "-show_streams",
          file
        ])).pipe(
          Effect.flatMap(decodeProbe),
          Effect.map(toProbe),
          Effect.mapError((cause) =>
            new FfmpegError({
              message: `Could not read this file as video, audio or an image (${file.split("/").pop()}).`,
              stderr: String(cause).slice(-STDERR_TAIL)
            })
          )
        )

      const run = (args: ReadonlyArray<string>, options: RunOptions = {}) =>
        Effect.gen(function*() {
          const handle = yield* spawner.spawn(
            ChildProcess.make("ffmpeg", [
              "-hide_banner",
              "-nostdin",
              "-loglevel",
              "error",
              "-nostats",
              "-progress",
              "pipe:1",
              "-y",
              ...args
            ], { cwd: options.cwd, forceKillAfter: "3 seconds" })
          )
          let stderr = ""
          const readStderr = handle.stderr.pipe(
            Stream.decodeText(),
            Stream.runForEach((chunk) =>
              Effect.sync(() => {
                stderr = (stderr + chunk).slice(-STDERR_TAIL)
              })
            )
          )
          let lastReported = -1
          const readProgress = handle.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) => {
              if (!options.onProgress || !options.duration || !line.startsWith("out_time_us=")) return Effect.void
              const us = Number(line.slice("out_time_us=".length))
              if (!Number.isFinite(us)) return Effect.void
              const fraction = Math.min(1, Math.max(0, us / 1e6 / options.duration))
              if (fraction - lastReported < 0.01) return Effect.void
              lastReported = fraction
              return options.onProgress(fraction)
            })
          )
          yield* Effect.all([readStderr, readProgress], { concurrency: 2, discard: true })
          const exitCode = yield* handle.exitCode
          if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
            return yield* new FfmpegError({ message: `ffmpeg exited with code ${exitCode}`, stderr })
          }
        }).pipe(
          Effect.scoped,
          Effect.catchTag("PlatformError", (error) => Effect.fail(new FfmpegError({ message: error.message, stderr: "" })))
        )

      const runCollect = (args: ReadonlyArray<string>) =>
        Effect.gen(function*() {
          const handle = yield* spawner.spawn(
            ChildProcess.make("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", ...args], {
              forceKillAfter: "3 seconds"
            })
          )
          const chunks: Array<Uint8Array> = []
          let stderr = ""
          yield* Effect.all([
            handle.stdout.pipe(Stream.runForEach((chunk) => Effect.sync(() => chunks.push(chunk)))),
            handle.stderr.pipe(
              Stream.decodeText(),
              Stream.runForEach((chunk) => Effect.sync(() => (stderr = (stderr + chunk).slice(-STDERR_TAIL))))
            )
          ], { concurrency: 2, discard: true })
          const exitCode = yield* handle.exitCode
          if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
            return yield* new FfmpegError({ message: `ffmpeg exited with code ${exitCode}`, stderr })
          }
          return Buffer.concat(chunks)
        }).pipe(
          Effect.scoped,
          Effect.catchTag("PlatformError", (error) => Effect.fail(new FfmpegError({ message: error.message, stderr: "" })))
        )

      return Ffmpeg.of({ probe, run, runCollect })
    })
  )
}
