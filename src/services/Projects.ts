import { Context, Effect, Layer, Option, Semaphore } from "effect"
import { OwlError, type StorageError } from "../domain/Errors.ts"
import { newId } from "../domain/Ids.ts"
import type { Analysis, MediaRecord } from "../domain/Media.ts"
import { BLANK, emptyTimeline, type HistoryEntry, type Project, timelineDuration } from "../domain/Timeline.ts"
import { applyEdits, EditFailure, type MediaInfo } from "../timeline/apply.ts"
import { describeProject, type DescribeSources } from "../timeline/describe.ts"
import type { EditOp } from "../timeline/Ops.ts"
import { MediaLibrary } from "./MediaLibrary.ts"
import { Storage } from "./Storage.ts"

const INDEX_KEY = "db/projects.json"
const projectKey = (id: string) => `projects/${id}.json`
const HISTORY_LIMIT = 50

export interface ProjectSummary {
  readonly id: string
  readonly name: string
  readonly updatedAt: string
  readonly version: number
  readonly duration: number
  readonly clips: number
}

export interface EditOutcome {
  readonly project: Project
  readonly changes: ReadonlyArray<string>
  readonly notes: ReadonlyArray<string>
}

export interface ProjectsShape {
  readonly create: (name: string) => Effect.Effect<Project, StorageError>
  readonly list: Effect.Effect<ReadonlyArray<ProjectSummary>, StorageError>
  readonly get: (id: string) => Effect.Effect<Project, OwlError | StorageError>
  readonly edit: (
    id: string,
    ops: ReadonlyArray<EditOp>,
    expectedVersion?: number
  ) => Effect.Effect<EditOutcome, OwlError | StorageError>
  readonly undo: (id: string, steps: number) => Effect.Effect<EditOutcome, OwlError | StorageError>
  readonly redo: (id: string, steps: number) => Effect.Effect<EditOutcome, OwlError | StorageError>
  readonly describe: (project: Project, detailed: boolean) => Effect.Effect<string, StorageError>
  /** Name, speech and visual lookups for the media a project uses. */
  readonly sources: (mediaIds: Iterable<string>) => Effect.Effect<DescribeSources, StorageError>
}

const mediaIdsOf = (project: Project, ops: ReadonlyArray<EditOp>) => {
  const ids = new Set<string>()
  const t = project.timeline
  for (const x of [...t.main, ...t.overlays, ...t.audio]) ids.add(x.mediaId)
  for (const op of ops) {
    if ("media" in op) ids.add(op.media)
    if ("clips" in op && typeof op.clips[0] === "object") for (const c of op.clips as ReadonlyArray<{ media: string }>) ids.add(c.media)
  }
  // Blank title cards are not media.
  ids.delete(BLANK)
  return ids
}

const toInfo = (record: MediaRecord, analysis: Option.Option<Analysis>): MediaInfo | string => {
  if (!record.probe) {
    return record.status === "failed"
      ? `${record.id} failed to import: ${record.error ?? "unknown error"}.`
      : `${record.id} is still importing. Call media_get with wait_seconds to wait for it.`
  }
  const p = record.probe
  const a = Option.getOrUndefined(analysis)
  return {
    id: record.id,
    name: record.name,
    kind: p.kind,
    duration: p.duration,
    width: p.width,
    height: p.height,
    fps: p.fps,
    hasAudio: p.hasAudio,
    hasTranscript: (a?.transcript?.segments.length ?? 0) > 0,
    shots: a?.shots ?? []
  }
}

export class Projects extends Context.Service<Projects, ProjectsShape>()("owl/Projects") {
  static readonly layer = Layer.effect(
    Projects,
    Effect.gen(function*() {
      const storage = yield* Storage
      const library = yield* MediaLibrary
      const cache = new Map<string, Project>()
      const locks = new Map<string, Semaphore.Semaphore>()
      const indexLock = yield* Semaphore.make(1)

      const lockFor = (id: string) => {
        let lock = locks.get(id)
        if (!lock) {
          lock = Semaphore.makeUnsafe(1)
          locks.set(id, lock)
        }
        return lock
      }

      const readIndex = storage.readJson<ReadonlyArray<ProjectSummary>>(INDEX_KEY).pipe(
        Effect.map(Option.getOrElse((): ReadonlyArray<ProjectSummary> => []))
      )

      const summaryOf = (p: Project): ProjectSummary => ({
        id: p.id,
        name: p.name,
        updatedAt: p.updatedAt,
        version: p.version,
        duration: timelineDuration(p.timeline),
        clips: p.timeline.main.length
      })

      const save = (project: Project) =>
        Effect.gen(function*() {
          cache.set(project.id, project)
          yield* storage.writeJson(projectKey(project.id), project)
          yield* indexLock.withPermits(1)(Effect.gen(function*() {
            const index = yield* readIndex
            yield* storage.writeJson(INDEX_KEY, [summaryOf(project), ...index.filter((s) => s.id !== project.id)])
          }))
        })

      const get = (id: string) =>
        Effect.gen(function*() {
          const cached = cache.get(id)
          if (cached) return cached
          const stored = yield* storage.readJson<Project>(projectKey(id))
          if (Option.isNone(stored)) {
            const known = (yield* readIndex).slice(0, 10).map((s) => `${s.id} (${s.name})`).join(", ")
            return yield* OwlError.notFound(
              `No project "${id}".${known ? ` Recent projects: ${known}.` : " Create one with project_create."}`
            )
          }
          cache.set(id, stored.value)
          return stored.value
        })

      const mediaInfos = (ids: Iterable<string>) =>
        Effect.gen(function*() {
          const infos = new Map<string, MediaInfo | string>()
          for (const id of ids) {
            const record = yield* library.get(id).pipe(Effect.option)
            if (Option.isNone(record)) {
              infos.set(id, `No media "${id}". Use media_list or media_search to find media ids.`)
              continue
            }
            infos.set(id, toInfo(record.value, yield* library.analysis(id)))
          }
          return infos
        })

      const edit = (id: string, ops: ReadonlyArray<EditOp>, expectedVersion?: number) =>
        lockFor(id).withPermits(1)(Effect.gen(function*() {
          const project = yield* get(id)
          if (expectedVersion !== undefined && expectedVersion !== project.version) {
            return yield* OwlError.conflict(
              `The project is at version ${project.version}, not ${expectedVersion}. Call timeline_get to see the latest edit.`
            )
          }
          const infos = yield* mediaInfos(mediaIdsOf(project, ops))
          const result = yield* Effect.try({
            try: () =>
              applyEdits(project, ops, {
                media: (mediaId) => {
                  const info = infos.get(mediaId)
                  if (info === undefined) throw new EditFailure(`No media "${mediaId}".`)
                  if (typeof info === "string") throw new EditFailure(info)
                  return info
                }
              }),
            catch: (error) =>
              error instanceof EditFailure ? OwlError.invalid(error.message) : OwlError.internal(String(error))
          })
          const entry: HistoryEntry = {
            label: result.changes.join(" "),
            timeline: project.timeline,
            counters: project.counters,
            outputLocked: project.outputLocked
          }
          const next: Project = {
            ...project,
            version: project.version + 1,
            updatedAt: new Date().toISOString(),
            timeline: result.timeline,
            counters: result.counters,
            outputLocked: result.outputLocked,
            undo: [...project.undo, entry].slice(-HISTORY_LIMIT),
            redo: []
          }
          yield* save(next)
          return { project: next, changes: result.changes, notes: result.notes }
        }))

      const travel = (id: string, steps: number, direction: "undo" | "redo") =>
        lockFor(id).withPermits(1)(Effect.gen(function*() {
          let project = yield* get(id)
          const from = direction === "undo" ? "undo" : "redo"
          const to = direction === "undo" ? "redo" : "undo"
          if (project[from].length === 0) {
            return yield* OwlError.invalid(`Nothing to ${direction}.`)
          }
          const labels: Array<string> = []
          for (let i = 0; i < steps && project[from].length > 0; i++) {
            const entry = project[from][project[from].length - 1]!
            const current: HistoryEntry = {
              label: entry.label,
              timeline: project.timeline,
              counters: project.counters,
              outputLocked: project.outputLocked
            }
            labels.push(entry.label)
            project = {
              ...project,
              timeline: entry.timeline,
              counters: entry.counters,
              outputLocked: entry.outputLocked,
              [from]: project[from].slice(0, -1),
              [to]: [...project[to], current]
            }
          }
          project = { ...project, version: project.version + 1, updatedAt: new Date().toISOString() }
          yield* save(project)
          const verb = direction === "undo" ? "Undid" : "Redid"
          return { project, changes: labels.map((l) => `${verb}: ${l}`), notes: [] }
        }))

      const sources = (mediaIds: Iterable<string>) =>
        Effect.gen(function*() {
          const names = new Map<string, string>()
          const analyses = new Map<string, Analysis>()
          for (const id of mediaIds) {
            const record = yield* library.get(id).pipe(Effect.option)
            names.set(id, Option.isSome(record) ? record.value.name : "(deleted media)")
            const analysis = yield* library.analysis(id).pipe(Effect.orElseSucceed(() => Option.none()))
            if (Option.isSome(analysis)) analyses.set(id, analysis.value)
          }
          return {
            name: (id) => id === BLANK ? "title card" : names.get(id) ?? id,
            speech: (id, start, end) => {
              const words = analyses.get(id)?.transcript?.segments.flatMap((s) => s.words)
                .filter((w) => w.s >= start - 0.15 && w.e <= end + 0.15)
                .map((w) => w.w)
              return words && words.length > 0 ? words.join(" ").replace(/\s+/g, " ").trim() : undefined
            },
            visual: (id, start, end) => {
              const shots = analyses.get(id)?.shots.filter((s) => s.caption && s.end > start + 0.05 && s.start < end - 0.05)
              if (!shots || shots.length === 0) return undefined
              // For screen recordings and other still shots, the notes of the moments in range say more than the whole-shot summary.
              const parts = shots.flatMap((s) => {
                const notes = (s.moments ?? []).flatMap((m, i) =>
                  m.end > start + 0.05 && m.start < end - 0.05 && s.caption!.notes?.[i] ? [s.caption!.notes[i]!] : []
                )
                return notes.length > 0 ? notes : [s.caption!.description]
              })
              return parts.slice(0, 4).join(" | ") + (parts.length > 4 ? ` | +${parts.length - 4} more` : "")
            }
          } satisfies DescribeSources
        })

      return Projects.of({
        create: (name) =>
          Effect.gen(function*() {
            const now = new Date().toISOString()
            const project: Project = {
              id: newId("p"),
              name,
              createdAt: now,
              updatedAt: now,
              version: 0,
              timeline: emptyTimeline,
              counters: { c: 0, o: 0, a: 0, t: 0 },
              outputLocked: false,
              undo: [],
              redo: []
            }
            yield* save(project)
            return project
          }),
        list: readIndex,
        get,
        edit,
        undo: (id, steps) => travel(id, steps, "undo"),
        redo: (id, steps) => travel(id, steps, "redo"),
        describe: (project, detailed) =>
          sources(mediaIdsOf(project, [])).pipe(Effect.map((s) => describeProject(project, s, detailed))),
        sources
      })
    })
  )
}
