import { Context, Effect, FileSystem, Layer, Option, Schedule, Semaphore } from "effect"
import { OwlConfig } from "../Config.ts"
import { OwlError, type StorageError } from "../domain/Errors.ts"
import { newId, randomCode } from "../domain/Ids.ts"
import type { Word } from "../domain/Media.ts"
import { round3 } from "../domain/Time.ts"
import { type OutputSettings, type Project, type Timeline, timelineDuration } from "../domain/Timeline.ts"
import { buildAss, timelineWords } from "../render/ass.ts"
import { buildRender, type Canvas, type SourceInfo } from "../render/graph.ts"
import { sliceTimeline } from "../render/slice.ts"
import { Activity } from "./Activity.ts"
import { proxyKey } from "./Analyzer.ts"
import { Ffmpeg } from "./Ffmpeg.ts"
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

const scaledCanvas = (output: OutputSettings, maxSide: number): Canvas => {
  const scale = Math.min(1, maxSide / Math.max(output.width, output.height))
  const even = (x: number) => Math.max(2, Math.round((x * scale) / 2) * 2)
  return { width: even(output.width), height: even(output.height), fps: output.fps, background: output.background }
}

const mediaIds = (t: Timeline) => new Set([...t.main, ...t.overlays, ...t.audio].map((x) => x.mediaId))

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
              const info: SourceInfo = {
                path,
                kind: probe.kind,
                hasAudio: probe.hasAudio,
                width: probe.width,
                height: probe.height
              }
              return [id, info] as const
            }),
          { concurrency: 4 }
        ).pipe(Effect.map((entries) => new Map(entries)))

      const wordsFor = (timeline: Timeline) =>
        Effect.gen(function*() {
          const words = new Map<string, ReadonlyArray<Word>>()
          for (const c of timeline.main) {
            if (words.has(c.mediaId)) continue
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
          readonly onProgress?: (p: number) => Effect.Effect<void>
        }
      ) =>
        Effect.gen(function*() {
          const sourceMap = yield* sources(timeline, options.quality)
          const words = yield* wordsFor(timeline)
          const ass = buildAss(timeline, words)
          const assPath = ass ? `${options.workDir}/text.ass` : undefined
          if (ass && assPath) yield* fs.writeFileString(assPath, ass)
          const { args, duration } = buildRender({
            timeline,
            source: (id) => sourceMap.get(id)!,
            canvas: options.canvas,
            assPath,
            speech: words.map((w) => ({ start: w.s, end: w.e })),
            quality: options.quality,
            output: options.output,
            still: options.still
          })
          yield* ffmpeg.run(args, {
            duration,
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

      const run = (job: RenderJob, timeline: Timeline, canvas: Canvas) =>
        withWorkDir((workDir) =>
          Effect.gen(function*() {
            const started = Date.now()
            yield* setJob({ ...job, status: "running", progress: 0 })
            const key = `renders/${job.id}.mp4`
            const output = yield* storage.stagingPath(key)
            const duration = yield* renderFile(timeline, {
              quality: job.quality,
              canvas,
              output,
              workDir,
              onProgress: (p) =>
                setJob({ ...jobs.get(job.id)!, progress: Math.round(Math.min(0.99, p) * 100) / 100 }, false)
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
            const tail = e.stderr?.split("\n").filter(Boolean).slice(-4).join(" ")
            return setJob({
              ...jobs.get(job.id)!,
              status: "failed",
              error: tail ? `${e.message}: ${tail}` : e.message,
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
                  yield* renderFile(sliceTimeline(t, at, at + frame * 2), {
                    quality: "draft",
                    canvas,
                    output,
                    workDir: dir,
                    still: true
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
