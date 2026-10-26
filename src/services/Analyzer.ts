import { Context, Effect, FileSystem, Layer, Option, Semaphore, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { OwlConfig } from "../Config.ts"
import { extractFrames, fitLongSide } from "../analysis/frames.ts"
import { runAudioAnalysis } from "../analysis/runAudio.ts"
import { buildShots, parseSceneMetadata } from "../analysis/shots.ts"
import type { Analysis, AudioAnalysis, MediaRecord, Probe, Shot, Transcript } from "../domain/Media.ts"
import { OwlError } from "../domain/Errors.ts"
import { formatDuration, round1 } from "../domain/Time.ts"
import { Activity } from "./Activity.ts"
import { Ffmpeg } from "./Ffmpeg.ts"
import { MediaLibrary } from "./MediaLibrary.ts"
import { Search } from "./Search.ts"
import { Storage } from "./Storage.ts"
import { Transcriber } from "./Transcriber.ts"
import { Vision } from "./Vision.ts"

export const proxyKey = (id: string) => `media/${id}/proxy.mp4`
export const frameKey = (id: string, time: number) => `media/${id}/frames/${Math.round(time * 1000)}.jpg`

/** Long side of saved keyframes. Large enough for captions, small enough to send to an agent. */
export const FRAME_SIZE = 512
const PROXY_SIZE = 960
const CAPTION_BATCH = 6
const MAX_DOWNLOAD_BYTES = 8 * 1024 ** 3

export interface AnalyzerShape {
  /** Starts (or restarts) import and analysis in the background. */
  readonly start: (id: string) => Effect.Effect<void>
  /** Restarts any analysis that was interrupted, for example by a container restart. */
  readonly resumePending: Effect.Effect<void>
}

/** Turns share links from common hosts into direct download links. */
export const directDownloadUrl = (raw: string): string => {
  const url = new URL(raw)
  const host = url.hostname.replace(/^www\./, "")
  if (host === "drive.google.com") {
    const id = /\/file\/d\/([^/]+)/.exec(url.pathname)?.[1] ?? url.searchParams.get("id")
    if (id) return `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`
  }
  if (host === "dropbox.com" || host.endsWith(".dropbox.com")) {
    url.searchParams.set("dl", "1")
    return url.toString()
  }
  return raw
}

const audioKind = (audio: AudioAnalysis | undefined, transcript: Transcript | undefined): AudioAnalysis["kind"] => {
  if (!audio) return "none"
  const words = transcript?.segments.reduce((n, s) => n + s.words.length, 0) ?? 0
  if (words === 0) return audio.kind
  return audio.kind === "music" ? "speech_and_music" : "speech"
}

export const summarize = (probe: Probe, analysis: Analysis): string => {
  const parts: Array<string> = []
  if (probe.kind === "image") parts.push(`image ${probe.width}x${probe.height}`)
  else if (probe.kind === "audio") parts.push(`audio ${formatDuration(probe.duration)}`)
  else parts.push(`video ${formatDuration(probe.duration)}, ${probe.width}x${probe.height} @ ${round1(probe.fps)}fps`)
  if (probe.kind === "video") parts.push(`${analysis.shots.length} shot${analysis.shots.length === 1 ? "" : "s"}`)
  const audio = analysis.audio
  if (probe.kind !== "image") {
    if (!probe.hasAudio) parts.push("no audio track")
    else if (audio) {
      const kind = audioKind(audio, analysis.transcript)
      const words = analysis.transcript?.segments.reduce((n, s) => n + s.words.length, 0) ?? 0
      if (kind === "silent") parts.push("silent audio")
      if (kind === "music" || kind === "speech_and_music") parts.push(`music${audio.tempo ? ` ~${Math.round(audio.tempo)} BPM` : ""}`)
      if (words > 0) parts.push(`speech (${words} words${analysis.transcript?.language ? `, ${analysis.transcript.language}` : ""})`)
      else if (kind !== "silent") parts.push(analysis.transcript ? "no speech detected" : "speech not checked")
    }
  }
  return parts.join(", ")
}

export class Analyzer extends Context.Service<Analyzer, AnalyzerShape>()("owl/Analyzer") {
  static readonly layer = Layer.effect(
    Analyzer,
    Effect.gen(function*() {
      const config = yield* OwlConfig
      const library = yield* MediaLibrary
      const storage = yield* Storage
      const ffmpeg = yield* Ffmpeg
      const transcriber = yield* Transcriber
      const vision = yield* Vision
      const search = yield* Search
      const activity = yield* Activity
      const fs = yield* FileSystem.FileSystem
      const http = yield* HttpClient.HttpClient
      const slots = yield* Semaphore.make(config.analysisConcurrency)
      const scope = yield* Effect.scope
      const running = new Set<string>()

      const download = (record: MediaRecord) =>
        Effect.gen(function*() {
          const url = record.origin.url
          if (!url) return yield* OwlError.invalid("This media has no source file and no URL to download it from.")
          yield* library.setStage(record.id, "probe", { status: "running", note: "downloading" })
          const target = yield* storage.stagingPath(record.sourceKey)
          const response = yield* http.execute(
            HttpClientRequest.get(directDownloadUrl(url)).pipe(HttpClientRequest.setHeader("user-agent", "owl/0.1"))
          )
          if (response.status >= 400) {
            return yield* OwlError.external(`Download failed with HTTP ${response.status}. Check that the link is public.`)
          }
          const type = response.headers["content-type"] ?? ""
          if (type.startsWith("text/html")) {
            return yield* OwlError.external(
              "The link returned a web page, not a media file. Use a direct download link or a public share link."
            )
          }
          const total = Number(response.headers["content-length"] ?? 0)
          let received = 0
          yield* response.stream.pipe(
            Stream.tap((chunk) =>
              Effect.gen(function*() {
                received += chunk.length
                if (received > MAX_DOWNLOAD_BYTES) return yield* OwlError.invalid("File is larger than 8 GB.")
                if (total > 0 && received % (8 * 1024 * 1024) < chunk.length) {
                  yield* library.setStage(record.id, "probe", {
                    status: "running",
                    note: "downloading",
                    progress: Math.min(0.99, received / total)
                  })
                }
              })
            ),
            Stream.run(fs.sink(target))
          )
          yield* storage.commitFile(record.sourceKey, type || "application/octet-stream")
        })

      const pass1 = (record: MediaRecord, source: string, probe: Probe, work: string) =>
        Effect.gen(function*() {
          const graph: Array<string> = []
          const outputs: Array<string> = []
          const proxyPath = probe.hasVideo ? yield* storage.stagingPath(proxyKey(record.id)) : undefined
          if (probe.hasVideo) {
            graph.push(
              "[0:v]split=2[vp][va]",
              `[vp]${fitLongSide(PROXY_SIZE)}:flags=bilinear,format=yuv420p[vproxy]`,
              "[va]scale=128:-2:flags=fast_bilinear,format=yuv420p,scdet=threshold=10," +
                `metadata=mode=print:key=lavfi.scd.mafd:file=${work}/mafd.txt,` +
                `metadata=mode=print:key=lavfi.scd.score:file=${work}/score.txt,nullsink`
            )
          }
          if (probe.hasAudio) {
            graph.push(
              probe.hasVideo ? "[0:a]asplit=3[ap][aa][at]" : "[0:a]asplit=2[aa][at]",
              "[aa]aresample=22050,aformat=sample_fmts=s16:channel_layouts=mono[apcm]",
              "[at]aresample=16000,aformat=channel_layouts=mono[aspeech]"
            )
          }
          if (proxyPath) {
            outputs.push("-map", "[vproxy]")
            if (probe.hasAudio) outputs.push("-map", "[ap]", "-c:a", "aac", "-b:a", "96k")
            outputs.push(
              "-c:v",
              "libx264",
              "-preset",
              "veryfast",
              "-crf",
              "26",
              "-force_key_frames",
              "expr:gte(t,n_forced*1)",
              "-movflags",
              "+faststart",
              proxyPath
            )
          }
          if (probe.hasAudio) {
            outputs.push("-map", "[apcm]", "-f", "s16le", `${work}/pcm.raw`)
            outputs.push("-map", "[aspeech]", "-c:a", "libmp3lame", "-b:a", "32k", `${work}/speech.mp3`)
          }
          yield* library.setStage(record.id, "proxy", { status: "running", progress: 0 })
          yield* ffmpeg.run(["-i", source, "-filter_complex", graph.join(";"), ...outputs], {
            duration: probe.duration,
            onProgress: (p) =>
              library.setStage(record.id, "proxy", { status: "running", progress: Math.round(p * 100) / 100 }).pipe(
                Effect.ignore
              )
          })
          if (proxyPath) yield* storage.commitFile(proxyKey(record.id), "video/mp4")
          yield* library.setStage(record.id, "proxy", { status: probe.hasVideo ? "done" : "skipped" })
        })

      const saveFrames = (record: MediaRecord, input: string, times: ReadonlyArray<number>) =>
        Effect.gen(function*() {
          const requests = yield* Effect.forEach(times, (time) =>
            storage.stagingPath(frameKey(record.id, time)).pipe(Effect.map((output) => ({ time, output }))))
          yield* extractFrames(ffmpeg, input, requests, { maxSide: FRAME_SIZE, concurrency: 2 })
          yield* Effect.forEach(times, (time) => storage.commitFile(frameKey(record.id, time), "image/jpeg"), {
            concurrency: 8,
            discard: true
          })
        })

      const captionAll = (
        record: MediaRecord,
        shots: ReadonlyArray<Shot>,
        transcript: Transcript | undefined
      ) =>
        Effect.gen(function*() {
          const batches: Array<Array<Shot>> = []
          for (let i = 0; i < shots.length; i += CAPTION_BATCH) batches.push(shots.slice(i, i + CAPTION_BATCH))
          let done = 0
          const results = yield* Effect.forEach(batches, (batch) =>
            Effect.gen(function*() {
              const input = yield* Effect.forEach(batch, (shot) =>
                Effect.gen(function*() {
                  const frames = yield* Effect.forEach(shot.keyframes, (t) =>
                    storage.localPath(frameKey(record.id, t)).pipe(Effect.flatMap((p) => fs.readFile(p))))
                  const speech = transcript?.segments
                    .filter((s) => s.end > shot.start && s.start < shot.end)
                    .map((s) => s.text)
                    .join(" ")
                  return { index: shot.index, start: shot.start, end: shot.end, motionLabel: shot.motionLabel, frames, speech }
                }))
              const captions = yield* vision.captionShots(record.name, input)
              done += batch.length
              yield* library.setStage(record.id, "captions", {
                status: "running",
                progress: Math.round((done / shots.length) * 100) / 100
              })
              return captions
            }), { concurrency: 3 })
          const merged = new Map<number, Shot["caption"]>()
          for (const map of results) for (const [k, v] of map) merged.set(k, v)
          return shots.map((s) => merged.has(s.index) ? { ...s, caption: merged.get(s.index) } : s)
        })

      const analyze = (id: string) =>
        Effect.gen(function*() {
          let record = yield* library.get(id)
          yield* library.update(id, (r) => ({ ...r, status: "importing", error: undefined }))
          if (!(yield* storage.exists(record.sourceKey))) yield* download(record)
          const source = yield* storage.localPath(record.sourceKey)
          const probe = yield* ffmpeg.probe(source)
          if (!probe.hasVideo && !probe.hasAudio) {
            return yield* OwlError.invalid("The file has no video or audio stream.")
          }
          record = yield* library.update(id, (r) => ({
            ...r,
            probe,
            status: "analyzing",
            stages: { probe: { status: "done" } }
          }))
          const work = `${config.cacheDir}/work/${id}`
          yield* fs.makeDirectory(work, { recursive: true })

          let analysis: Analysis = { version: 1, shots: [] }
          const save = (next: Analysis) =>
            Effect.suspend(() => {
              analysis = next
              return library.saveAnalysis(id, next)
            })

          if (probe.kind === "image") {
            yield* saveFrames(record, source, [0])
            yield* save({
              version: 1,
              shots: [{ index: 1, start: 0, end: 0, motion: 0, motionLabel: "static", keyframes: [0] }]
            })
            for (const stage of ["proxy", "shots", "audio", "transcript"] as const) {
              yield* library.setStage(id, stage, { status: "skipped" })
            }
            yield* library.setStage(id, "frames", { status: "done" })
          } else {
            yield* pass1(record, source, probe, work)

            const audioStage = probe.hasAudio
              ? Effect.gen(function*() {
                yield* library.setStage(id, "audio", { status: "running" })
                const audio = yield* runAudioAnalysis(`${work}/pcm.raw`)
                yield* save({ ...analysis, audio })
                yield* library.setStage(id, "audio", { status: "done" })
                return audio
              })
              : library.setStage(id, "audio", { status: "skipped" }).pipe(Effect.as(undefined))

            const shotStage = probe.hasVideo
              ? Effect.gen(function*() {
                yield* library.setStage(id, "shots", { status: "running" })
                const frames = parseSceneMetadata(
                  yield* fs.readFileString(`${work}/mafd.txt`),
                  yield* fs.readFileString(`${work}/score.txt`)
                )
                const shots = buildShots(frames, probe.duration)
                yield* save({ ...analysis, shots })
                yield* library.setStage(id, "shots", { status: "done", note: `${shots.length} shot${shots.length === 1 ? "" : "s"}` })
                yield* library.setStage(id, "frames", { status: "running" })
                const proxy = yield* storage.localPath(proxyKey(id))
                yield* saveFrames(record, proxy, shots.flatMap((s) => s.keyframes))
                yield* library.setStage(id, "frames", { status: "done" })
                return shots
              })
              : Effect.gen(function*() {
                yield* library.setStage(id, "shots", { status: "skipped" })
                yield* library.setStage(id, "frames", { status: "skipped" })
                return [] as ReadonlyArray<Shot>
              })

            const transcriptStage = (audio: AudioAnalysis | undefined) =>
              Effect.gen(function*() {
                if (!audio || audio.kind === "silent") {
                  yield* library.setStage(id, "transcript", { status: "skipped", note: "no audible audio" })
                  return undefined
                }
                if (!transcriber.available) {
                  yield* library.setStage(id, "transcript", { status: "skipped", note: "transcription not configured" })
                  return undefined
                }
                yield* library.setStage(id, "transcript", { status: "running" })
                const transcript = yield* transcriber.transcribe(`${work}/speech.mp3`, probe.duration, audio.silences, work)
                yield* save({ ...analysis, transcript })
                yield* library.setStage(id, "transcript", {
                  status: "done",
                  note: `${transcript.segments.reduce((n, s) => n + s.words.length, 0)} words`
                })
                return transcript
              }).pipe(
                Effect.catch((error) =>
                  library.setStage(id, "transcript", { status: "failed", note: error.message }).pipe(
                    Effect.as(undefined)
                  )
                )
              )

            const [shots, transcript] = yield* Effect.all([
              shotStage,
              audioStage.pipe(Effect.flatMap(transcriptStage))
            ], { concurrency: 2 })

            if (shots.length > 0 && vision.available) {
              yield* library.setStage(id, "captions", { status: "running", progress: 0 })
              const captioned = yield* captionAll(record, shots, transcript).pipe(
                Effect.tapError((error) => library.setStage(id, "captions", { status: "failed", note: error.message })),
                Effect.option
              )
              if (Option.isSome(captioned)) {
                yield* save({ ...analysis, shots: captioned.value })
                yield* library.setStage(id, "captions", { status: "done" })
              }
            } else {
              yield* library.setStage(id, "captions", {
                status: "skipped",
                note: shots.length === 0 ? "no shots" : "ANTHROPIC_API_KEY not set"
              })
            }
          }

          if (probe.kind === "image" && vision.available) {
            const captioned = yield* captionAll(record, analysis.shots, undefined).pipe(Effect.option)
            if (Option.isSome(captioned)) yield* save({ ...analysis, shots: captioned.value })
            yield* library.setStage(id, "captions", { status: Option.isSome(captioned) ? "done" : "failed" })
          }

          yield* library.setStage(id, "index", { status: "running" })
          const indexed = yield* search.indexMedia(id)
          yield* library.setStage(id, "index", {
            status: "done",
            note: indexed.embedded ? "keyword + semantic" : "keyword only"
          })
          yield* library.update(id, (r) => ({ ...r, status: "ready", summary: summarize(probe, analysis) }))
          yield* fs.remove(work, { recursive: true, force: true }).pipe(Effect.ignore)
        }).pipe(
          Effect.catch((error) => {
            const e = error as { readonly message: string; readonly stderr?: string }
            const tail = e.stderr?.split("\n").filter(Boolean).slice(-3).join(" ")
            const message = tail ? `${e.message}. ${tail}` : e.message
            return library.update(id, (r) => ({ ...r, status: "failed", error: message })).pipe(Effect.ignore)
          })
        )

      const start = (id: string) =>
        Effect.suspend(() => {
          if (running.has(id)) return Effect.void
          running.add(id)
          return slots.withPermits(1)(activity.track(analyze(id))).pipe(
            Effect.ensuring(Effect.sync(() => running.delete(id))),
            Effect.forkIn(scope),
            Effect.asVoid
          )
        })

      const resumePending = Effect.gen(function*() {
        for (const record of yield* library.list) {
          if (record.status === "importing" || record.status === "analyzing") yield* start(record.id)
        }
      })

      return Analyzer.of({ start, resumePending })
    })
  )
}
