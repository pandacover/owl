import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Context, Effect, FileSystem, Layer, Option, Schedule, Semaphore } from "effect"
import { OwlConfig } from "../Config.ts"
import { OwlError, type StorageError } from "../domain/Errors.ts"
import { newId, randomCode } from "../domain/Ids.ts"
import type { Word } from "../domain/Media.ts"
import { round1, round3 } from "../domain/Time.ts"
import { BLANK, type OutputSettings, type Project, type Timeline, timelineDuration } from "../domain/Timeline.ts"
import { buildAss, timelineWords } from "../render/ass.ts"
import { buildRender, type Canvas, ENCODER_THREADS, joinPieces, type SourceInfo } from "../render/graph.ts"
import { inputCostMb, PIECE_BASE_MB, pieceBounds, sliceTimeline, splitPoint, stillRange, timelineCost } from "../render/slice.ts"
import { Activity } from "./Activity.ts"
import { proxyKey } from "./Analyzer.ts"
import { errorSummary, Ffmpeg, reapOrphans, STALLED } from "./Ffmpeg.ts"
import { MediaLibrary } from "./MediaLibrary.ts"
import { Storage } from "./Storage.ts"

export type Quality = "draft" | "final"

export interface RenderJob {
  readonly id: string
  readonly projectId: string
  readonly projectVersion: number
  readonly quality: Quality
  readonly start?: number | undefined
  readonly end?: number | undefined
  readonly status: "queued" | "running" | "done" | "failed"
  readonly progress: number
  readonly createdAt: string
  readonly finishedAt?: string | undefined
  readonly key?: string | undefined
  readonly error?: string | undefined
  /** Length of the rendered video in seconds. */
  readonly duration?: number | undefined
  readonly bytes?: number | undefined
  /** How long the render took, in seconds. */
  readonly took?: number | undefined
  readonly width?: number | undefined
  readonly height?: number | undefined
  /** What happened along the way, such as pieces that stalled and were retried. */
  readonly notes?: ReadonlyArray<string> | undefined
}

export interface RendererShape {
  readonly start: (
    project: Project,
    options: { readonly quality: Quality; readonly start?: number | undefined; readonly end?: number | undefined }
  ) => Effect.Effect<RenderJob, OwlError | StorageError>
  readonly get: (id: string) => Effect.Effect<RenderJob, OwlError>
  readonly wait: (id: string, seconds: number) => Effect.Effect<RenderJob, OwlError>
  readonly list: (projectId?: string) => Effect.Effect<ReadonlyArray<RenderJob>>
  /** JPEG frames of the edited timeline at the given times. */
  readonly stills: (
    project: Project,
    times: ReadonlyArray<number>,
    maxSide: number
  ) => Effect.Effect<ReadonlyArray<Uint8Array>, OwlError | StorageError>
}

const INDEX_KEY = "db/renders.json"
const DRAFT_SIDE = 960
/** A render whose output has not moved for this long is stuck, not slow. */
const STALL_SECONDS = 240
/** Pieces are short, so one that stops moving for this long is retried in two halves. */
const PIECE_STALL_SECONDS = 75

/** Fonts shipped with owl (assets/fonts), so text looks the same on every machine. */
const FONTS_DIR = fileURLToPath(new URL("../../assets/fonts", import.meta.url))

const scaledCanvas = (output: OutputSettings, maxSide: number): Canvas => {
  const scale = Math.min(1, maxSide / Math.max(output.width, output.height))
  const even = (x: number) => Math.max(2, Math.round((x * scale) / 2) * 2)
  return {
    width: even(output.width),
    height: even(output.height),
    fps: output.fps,
    background: output.background,
    gradient: output.gradient,
    look: output.look
  }
}

/** A source used by this many clips in a final gets a fast-decoding copy of its picture. */
const EDIT_COPY_USES = 8
const PROXY_SIDE = 960
const editCopyKey = (id: string) => `media/${id}/edit.mp4`

type Source = SourceInfo & { readonly cost: number }

const mediaIds = (t: Timeline) =>
  new Set([...t.main, ...t.overlays, ...t.audio].map((x) => x.mediaId).filter((id) => id !== BLANK))

export class Renderer extends Context.Service<Renderer, RendererShape>()("owl/Renderer") {
  static readonly layer = Layer.effect(
    Renderer,
    Effect.gen(function*() {
      const config = yield* OwlConfig
      const storage = yield* Storage
      const library = yield* MediaLibrary
      const ffmpeg = yield* Ffmpeg
      const activity = yield* Activity
      const fs = yield* FileSystem.FileSystem
      const slots = yield* Semaphore.make(config.renderConcurrency)
      const indexLock = yield* Semaphore.make(1)
      const scope = yield* Effect.scope

      const reaped = yield* reapOrphans([resolve(config.cacheDir), resolve(config.dataDir)])
      if (reaped > 0) yield* Effect.logWarning(`Stopped ${reaped} ffmpeg processes left by an earlier run`)

      const jobs = new Map<string, RenderJob>()
      const stored = yield* storage.readJson<ReadonlyArray<RenderJob>>(INDEX_KEY).pipe(Effect.orElseSucceed(() => Option.none()))
      for (const job of Option.getOrElse(stored, () => [])) {
        jobs.set(
          job.id,
          job.status === "queued" || job.status === "running"
            ? { ...job, status: "failed", error: "Interrupted by a server restart. Start the render again." }
            : job
        )
      }

      const persist = indexLock.withPermits(1)(Effect.suspend(() =>
        storage.writeJson(INDEX_KEY, [...jobs.values()].slice(-100)).pipe(Effect.ignore)
      ))

      const setJob = (job: RenderJob, save = true) =>
        Effect.suspend(() => {
          jobs.set(job.id, job)
          return save ? persist : Effect.void
        })

      const editLock = yield* Semaphore.make(1)

      /**
       * A copy of a source's picture that seeks and decodes fast: H.264 with
       * no B-frames, one reference frame and a keyframe every 15 frames, at
       * the source's size and timing and near-lossless quality. Phone HEVC
       * holds many frames per decoder and decodes slowly; an edit that cuts
       * one recording 200 times opens it 200 times. Made once and kept.
       */
      const editCopy = (id: string, sourceKey: string, duration: number) =>
        editLock.withPermits(1)(Effect.gen(function*() {
          const key = editCopyKey(id)
          if (yield* storage.exists(key)) return yield* storage.localPath(key)
          const target = yield* storage.stagingPath(key)
          const source = yield* storage.localPath(sourceKey)
          yield* ffmpeg.run([
            "-threads",
            "2",
            "-i",
            source,
            "-map",
            "0:v:0",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-tune",
            "fastdecode",
            "-bf",
            "0",
            "-refs",
            "1",
            "-g",
            "15",
            "-crf",
            "14",
            "-pix_fmt",
            "yuv420p",
            "-fps_mode",
            "passthrough",
            "-threads",
            String(ENCODER_THREADS),
            "-movflags",
            "+faststart",
            target
          ], { duration, stallSeconds: STALL_SECONDS })
          yield* storage.commitFile(key, "video/mp4")
          return yield* storage.localPath(key)
        }))

      const sources = (timeline: Timeline, quality: Quality) =>
        Effect.forEach(
          mediaIds(timeline),
          (id) =>
            Effect.gen(function*() {
              const record = yield* library.get(id)
              const probe = record.probe
              if (!probe) return yield* OwlError.notReady(`${id} is still importing. Wait for it with media_get.`)
              const useProxy = quality === "draft" && probe.hasVideo && probe.kind === "video" &&
                record.stages.proxy?.status === "done"
              const path = yield* storage.localPath(useProxy ? proxyKey(id) : record.sourceKey)
              const uses = [...timeline.main, ...timeline.overlays].filter((c) => c.mediaId === id).length
              const videoPath = quality === "final" && probe.kind === "video" && probe.videoCodec !== "h264" &&
                  uses >= EDIT_COPY_USES
                ? yield* editCopy(id, record.sourceKey, probe.duration).pipe(
                  // The original still works, only slower.
                  Effect.orElseSucceed(() => undefined)
                )
                : undefined
              const scale = useProxy ? Math.min(1, PROXY_SIDE / Math.max(probe.width, probe.height, 1)) : 1
              const info: Source = {
                path,
                videoPath,
                kind: probe.kind,
                hasAudio: probe.hasAudio,
                width: probe.width,
                height: probe.height,
                cost: inputCostMb(
                  probe.width * scale,
                  probe.height * scale,
                  useProxy || videoPath ? "h264" : probe.videoCodec,
                  probe.kind === "image"
                )
              }
              return [id, info] as const
            }),
          { concurrency: 1 }
        ).pipe(Effect.map((entries) => new Map(entries)))

      const wordsFor = (timeline: Timeline) =>
        Effect.gen(function*() {
          const words = new Map<string, ReadonlyArray<Word>>()
          for (const c of timeline.main) {
            if (words.has(c.mediaId)) continue
            if (c.mediaId === BLANK) {
              words.set(c.mediaId, [])
              continue
            }
            const analysis = yield* library.analysis(c.mediaId).pipe(Effect.orElseSucceed(() => Option.none()))
            words.set(
              c.mediaId,
              Option.match(analysis, {
                onNone: () => [],
                onSome: (a) => a.transcript?.segments.flatMap((s) => s.words) ?? []
              })
            )
          }
          return timelineWords(timeline, (id) => words.get(id) ?? [])
        })

      /** Renders a timeline to a local file. */
      const renderFile = (
        timeline: Timeline,
        options: {
          readonly quality: Quality
          readonly canvas: Canvas
          readonly output: string
          readonly workDir: string
          readonly still?: boolean
          readonly stillAt?: number
          /** A piece of a longer edit: its subtitle file and where the piece starts in it. */
          readonly piece?: { readonly assPath: string | undefined; readonly offset: number; readonly last: boolean }
          readonly onProgress?: (p: number) => Effect.Effect<void>
          readonly stallSeconds?: number
          readonly onMemory?: (peakMb: number, lowestFreeMb: number) => Effect.Effect<void>
          /** Sources already looked up for the whole edit. */
          readonly sources?: ReadonlyMap<string, Source>
        }
      ) =>
        Effect.gen(function*() {
          const sourceMap = options.sources ?? (yield* sources(timeline, options.quality))
          const words = yield* wordsFor(timeline)
          let assPath = options.piece?.assPath
          if (!options.piece) {
            const ass = buildAss(timeline, words)
            assPath = ass ? `${options.workDir}/text.ass` : undefined
            if (ass && assPath) yield* fs.writeFileString(assPath, ass)
          }
          const { args, duration } = buildRender({
            timeline,
            source: (id) => sourceMap.get(id)!,
            canvas: options.canvas,
            assPath,
            fontsDir: FONTS_DIR,
            speech: words.map((w) => ({ start: w.s, end: w.e })),
            quality: options.quality,
            output: options.output,
            still: options.still,
            stillAt: options.stillAt,
            textOffset: options.piece?.offset,
            piece: options.piece && { last: options.piece.last }
          })
          yield* ffmpeg.run(args, {
            duration,
            stallSeconds: options.stallSeconds ?? STALL_SECONDS,
            finishOnStall: options.piece !== undefined,
            onMemory: options.onMemory,
            ...(options.onProgress ? { onProgress: options.onProgress } : {})
          })
          return duration
        })

      const withWorkDir = <A, E, R>(f: (dir: string) => Effect.Effect<A, E, R>) =>
        Effect.acquireUseRelease(
          Effect.gen(function*() {
            const dir = `${config.cacheDir}/tmp/${randomCode(10)}`
            yield* fs.makeDirectory(dir, { recursive: true })
            return dir
          }).pipe(Effect.orDie),
          f,
          (dir) => fs.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore)
        )

      /**
       * Renders a long edit piece by piece, so only a few sources are open at a
       * time, then joins the pieces without encoding the video again. Text is
       * laid out once for the whole edit, so animations cross the joins intact.
       */
      /**
       * How much more memory sources really take than inputCostMb estimates,
       * learned from each piece's measured peak. FFmpeg builds and hosts
       * differ (FFmpeg 7 keeps about twice as many frames in flight as 6).
       */
      let costScale = 1.5

      /**
       * Renders a long edit piece by piece, so only a few sources are open at a
       * time, then joins the pieces without encoding the video again. Text is
       * laid out once for the whole edit, so animations cross the joins intact.
       * Each piece is planned from what is left, with the cost scale learned
       * from the pieces before it.
       */
      const renderPieces = (
        timeline: Timeline,
        options: {
          readonly quality: Quality
          readonly canvas: Canvas
          readonly output: string
          readonly workDir: string
          readonly onProgress: (p: number) => Effect.Effect<void>
          readonly sources: ReadonlyMap<string, Source>
          readonly note: (text: string) => Effect.Effect<void>
        }
      ) =>
        Effect.gen(function*() {
          const total = timelineDuration(timeline)
          const fps = options.canvas.fps
          const cost = (id: string) => options.sources.get(id)?.cost ?? 50
          const ass = buildAss(timeline, yield* wordsFor(timeline))
          const assPath = ass ? `${options.workDir}/text.ass` : undefined
          if (ass && assPath) yield* fs.writeFileString(assPath, ass)
          const files: Array<string> = []
          let seconds = 0
          let count = 0
          // FFmpeg 7 now and then stops moving on a graph with many inputs. A
          // stuck piece is rendered again as two smaller pieces, down to 3 levels.
          const piece = (from: number, to: number, last: boolean, depth: number): Effect.Effect<void, unknown> =>
            Effect.gen(function*() {
              const i = count++
              const dir = `${options.workDir}/p${i}`
              yield* fs.makeDirectory(dir).pipe(Effect.orDie)
              const file = `${options.workDir}/piece${i}.mkv`
              const done = from / total
              const began = Date.now()
              const slice = sliceTimeline(timeline, from, to)
              const estimate = timelineCost(slice, cost)
              const result = yield* renderFile(slice, {
                quality: options.quality,
                canvas: options.canvas,
                output: file,
                workDir: dir,
                piece: { assPath, offset: from, last },
                sources: options.sources,
                stallSeconds: PIECE_STALL_SECONDS,
                onMemory: (peak, free) =>
                  Effect.suspend(() => {
                    // Learn quickly when sources cost more than thought, slowly when less.
                    const seen = Math.max(0.5, Math.min(8, (peak - PIECE_BASE_MB) / Math.max(1, estimate)))
                    costScale = seen > costScale ? seen : costScale * 0.8 + seen * 0.2
                    return options.note(
                      `piece ${round3(from)}s to ${round3(to)}s: ${round1((Date.now() - began) / 1000)}s, ffmpeg peak ${peak} MB, lowest free ${free} MB`
                    )
                  }),
                // Most of the time goes to the pieces; the join is a copy.
                onProgress: (p) => options.onProgress(0.95 * (done + p * (to - from) / total))
              }).pipe(Effect.result)
              if (result._tag === "Success") {
                seconds += result.success
                files.push(file)
                return
              }
              const error = result.failure as { readonly message?: string }
              // FFmpeg 7 sometimes holds back the end of a piece it has fully drawn. Told to
              // finish, it writes the rest, and a piece with every frame and all its sound is kept.
              if (error.message?.startsWith(STALLED)) {
                const frames = Math.round((to - from) * fps)
                const got = yield* ffmpeg.lengths(file).pipe(Effect.orElseSucceed(() => ({ videoFrames: 0, audioSeconds: 0 })))
                if (got.videoFrames === frames && got.audioSeconds >= frames / fps - 1 / fps) {
                  yield* options.note(`piece ${round3(from)}s to ${round3(to)}s ${error.message.slice(STALLED.length).trim()}, finished cleanly`)
                  seconds += frames / fps
                  files.push(file)
                  return
                }
              }
              const middle = depth < 3 ? splitPoint(timeline, from, to, fps) : undefined
              if (!error.message?.startsWith(STALLED) || middle === undefined) {
                return yield* Effect.fail(
                  error.message?.startsWith(STALLED)
                    ? { ...error, message: `${error.message}, piece ${round3(from)}s to ${round3(to)}s` }
                    : result.failure
                )
              }
              yield* options.note(`piece ${round3(from)}s to ${round3(to)}s ${error.message.slice(STALLED.length).trim()}, retried in two halves`)
              yield* piece(from, middle, false, depth + 1)
              yield* piece(middle, to, last, depth + 1)
            })
          let from = 0
          while (from < total - 0.5 / fps) {
            const rest = sliceTimeline(timeline, from, total)
            const bounds = pieceBounds(rest, fps, (id) => cost(id) * costScale, config.renderMemoryMb)
            const to = bounds.length > 2 ? Math.round((from + bounds[1]!) * fps) / fps : total
            yield* piece(from, to, to >= total - 0.5 / fps, 0)
            from = to
          }
          const list = `${options.workDir}/pieces.txt`
          yield* fs.writeFileString(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n")
          yield* ffmpeg.run(joinPieces({ list, quality: options.quality, seconds, output: options.output }), {
            duration: seconds,
            stallSeconds: STALL_SECONDS,
            onProgress: (p) => options.onProgress(0.95 + 0.05 * p)
          })
          return seconds
        })

      const run = (job: RenderJob, timeline: Timeline, canvas: Canvas) =>
        withWorkDir((workDir) =>
          Effect.gen(function*() {
            const started = Date.now()
            yield* setJob({ ...job, status: "running", progress: 0 })
            const key = `renders/${job.id}.mp4`
            const output = yield* storage.stagingPath(key)
            const progress = (p: number) =>
              setJob({ ...jobs.get(job.id)!, progress: Math.round(Math.min(0.99, p) * 100) / 100 }, false)
            const sourceMap = yield* sources(timeline, job.quality)
            const whole = pieceBounds(timeline, canvas.fps, (id) => (sourceMap.get(id)?.cost ?? 50) * costScale, config.renderMemoryMb)
            const duration = whole.length <= 2
              ? yield* renderFile(timeline, { quality: job.quality, canvas, output, workDir, onProgress: progress, sources: sourceMap })
              : yield* renderPieces(timeline, {
                quality: job.quality,
                canvas,
                output,
                workDir,
                onProgress: progress,
                sources: sourceMap,
                note: (text) => setJob({ ...jobs.get(job.id)!, notes: [...(jobs.get(job.id)!.notes ?? []), text].slice(-30) })
              })
            const stat = yield* fs.stat(output)
            yield* storage.commitFile(key, "video/mp4")
            yield* setJob({
              ...jobs.get(job.id)!,
              status: "done",
              progress: 1,
              key,
              duration: round3(duration),
              bytes: Number(stat.size),
              took: round3((Date.now() - started) / 1000),
              width: canvas.width,
              height: canvas.height,
              finishedAt: new Date().toISOString()
            })
          })
        ).pipe(
          Effect.catch((error) => {
            const e = error as { readonly message: string; readonly stderr?: string }
            const detail = errorSummary(e.stderr)
            return setJob({
              ...jobs.get(job.id)!,
              status: "failed",
              error: (detail ? `${e.message}: ${detail}` : e.message).slice(0, 800),
              finishedAt: new Date().toISOString()
            })
          })
        )

      const get = (id: string) =>
        Effect.suspend(() => {
          const job = jobs.get(id)
          return job ? Effect.succeed(job) : Effect.fail(OwlError.notFound(`No render "${id}". Use render_status without an id to list renders.`))
        })

      return Renderer.of({
        start: (project, options) =>
          Effect.gen(function*() {
            const t = project.timeline
            const total = timelineDuration(t)
            if (total <= 0) return yield* OwlError.invalid("The timeline is empty. Add clips with timeline_edit first.")
            const start = Math.max(0, options.start ?? 0)
            const end = Math.min(total, options.end ?? total)
            if (end - start < 0.1) return yield* OwlError.invalid(`The range is empty. The timeline is ${round3(total)}s long.`)
            const partial = start > 0.001 || end < total - 0.001
            // The same version, quality and range was already rendered: reuse it.
            for (const job of jobs.values()) {
              if (
                job.projectId === project.id && job.projectVersion === project.version && job.quality === options.quality &&
                (job.start ?? 0) === start && (job.end ?? total) === end && (job.status !== "failed")
              ) return job
            }
            const job: RenderJob = {
              id: newId("r"),
              projectId: project.id,
              projectVersion: project.version,
              quality: options.quality,
              ...(partial ? { start: round3(start), end: round3(end) } : {}),
              status: "queued",
              progress: 0,
              createdAt: new Date().toISOString()
            }
            yield* setJob(job)
            const timeline = partial ? sliceTimeline(t, start, end) : t
            const canvas = options.quality === "draft" ? scaledCanvas(t.output, DRAFT_SIDE) : scaledCanvas(t.output, 3840)
            yield* slots.withPermits(1)(activity.track(run(job, timeline, canvas))).pipe(Effect.forkIn(scope))
            return job
          }),
        get,
        wait: (id, seconds) =>
          get(id).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("500 millis"),
              until: (job) => job.status === "done" || job.status === "failed"
            }),
            Effect.timeoutOption(`${Math.max(0, seconds)} seconds`),
            Effect.flatMap(() => get(id))
          ),
        list: (projectId) =>
          Effect.sync(() => [...jobs.values()].filter((j) => projectId === undefined || j.projectId === projectId).reverse()),
        stills: (project, times, maxSide) =>
          activity.track(withWorkDir((workDir) =>
            Effect.gen(function*() {
              const t = project.timeline
              const total = timelineDuration(t)
              if (total <= 0) return yield* OwlError.invalid("The timeline is empty.")
              const canvas = scaledCanvas(t.output, maxSide)
              const frame = 1 / t.output.fps
              return yield* Effect.forEach(times, (time, i) =>
                Effect.gen(function*() {
                  const at = Math.min(Math.max(0, time), total - frame)
                  const output = `${workDir}/still${i}.jpg`
                  const dir = `${workDir}/s${i}`
                  yield* fs.makeDirectory(dir).pipe(Effect.orDie)
                  // A frame inside a transition needs the transition's start in the slice to show the blend.
                  const { from, to } = stillRange(t, at, frame)
                  yield* renderFile(sliceTimeline(t, from, to), {
                    quality: "draft",
                    canvas,
                    output,
                    workDir: dir,
                    still: true,
                    stillAt: at - from
                  })
                  return yield* fs.readFile(output).pipe(Effect.orDie)
                }), { concurrency: 3 })
            })
          )).pipe(
            Effect.mapError((error) =>
              error._tag === "OwlError" || error._tag === "StorageError"
                ? error
                : OwlError.internal(`Could not render the frame: ${error.message}`)
            )
          )
      })
    })
  )
}
