import { Context, Duration, Effect, Layer, Option, Schedule, Semaphore } from "effect"
import type { Analysis, MediaRecord, StageName, StageState } from "../domain/Media.ts"
import { OwlError, type StorageError } from "../domain/Errors.ts"
import { newId } from "../domain/Ids.ts"
import { Storage } from "./Storage.ts"

const CATALOG_KEY = "db/media.json"
export const analysisKey = (id: string) => `media/${id}/analysis.json`

export interface MediaLibraryShape {
  readonly list: Effect.Effect<ReadonlyArray<MediaRecord>>
  readonly get: (id: string) => Effect.Effect<MediaRecord, OwlError>
  readonly create: (input: {
    readonly id?: string | undefined
    readonly name: string
    readonly sourceKey: string
    readonly origin: MediaRecord["origin"]
  }) => Effect.Effect<MediaRecord, StorageError>
  readonly update: (id: string, f: (record: MediaRecord) => MediaRecord) => Effect.Effect<MediaRecord, OwlError | StorageError>
  readonly setStage: (id: string, stage: StageName, state: StageState) => Effect.Effect<void, OwlError | StorageError>
  readonly analysis: (id: string) => Effect.Effect<Option.Option<Analysis>, StorageError>
  readonly saveAnalysis: (id: string, analysis: Analysis) => Effect.Effect<void, StorageError>
  readonly remove: (id: string) => Effect.Effect<void, OwlError | StorageError>
  /** Waits up to `timeout` for the record to satisfy `done`. Returns the latest record either way. */
  readonly waitFor: (
    id: string,
    done: (record: MediaRecord) => boolean,
    timeout: Duration.Input
  ) => Effect.Effect<MediaRecord, OwlError>
}

export class MediaLibrary extends Context.Service<MediaLibrary, MediaLibraryShape>()("owl/MediaLibrary") {
  static readonly layer = Layer.effect(
    MediaLibrary,
    Effect.gen(function*() {
      const storage = yield* Storage
      const records = new Map<string, MediaRecord>()
      const loaded = yield* storage.readJson<ReadonlyArray<MediaRecord>>(CATALOG_KEY).pipe(Effect.orDie)
      for (const record of Option.getOrElse(loaded, () => [])) {
        // Analysis that was running when the container stopped is restarted later by the Analyzer.
        records.set(record.id, record)
      }
      const analyses = new Map<string, Analysis>()
      const writeLock = yield* Semaphore.make(1)
      // Writes coalesce: a caller that waited for the lock finds its change already written.
      let dirty = false
      const persist = Effect.suspend(() => {
        dirty = true
        return writeLock.withPermits(1)(Effect.suspend(() => {
          if (!dirty) return Effect.void
          dirty = false
          return storage.writeJson(CATALOG_KEY, [...records.values()])
        }))
      })

      const get = (id: string) =>
        Effect.suspend(() => {
          const record = records.get(id)
          if (record) return Effect.succeed(record)
          const known = [...records.keys()].slice(-10).join(", ")
          return Effect.fail(OwlError.notFound(
            `No media with id "${id}". ${known ? `Known media ids include: ${known}. ` : ""}Use media_list to see all media.`
          ))
        })

      const update = (id: string, f: (record: MediaRecord) => MediaRecord) =>
        Effect.gen(function*() {
          const next = f(yield* get(id))
          records.set(id, next)
          yield* persist
          return next
        })

      return MediaLibrary.of({
        list: Effect.sync(() => [...records.values()]),
        get,
        create: (input) =>
          Effect.gen(function*() {
            const record: MediaRecord = {
              id: input.id ?? newId("m"),
              name: input.name,
              createdAt: new Date().toISOString(),
              sourceKey: input.sourceKey,
              origin: input.origin,
              status: "importing",
              stages: {}
            }
            records.set(record.id, record)
            yield* persist
            return record
          }),
        update,
        setStage: (id, stage, state) =>
          Effect.gen(function*() {
            const record = yield* get(id)
            const next = { ...record, stages: { ...record.stages, [stage]: state } }
            records.set(id, next)
            // Progress ticks stay in memory. Only status changes are written to storage.
            if (record.stages[stage]?.status !== state.status || state.note !== record.stages[stage]?.note) {
              yield* persist
            }
          }),
        analysis: (id) =>
          Effect.gen(function*() {
            const cached = analyses.get(id)
            if (cached) return Option.some(cached)
            const stored = yield* storage.readJson<Analysis>(analysisKey(id))
            if (Option.isSome(stored)) analyses.set(id, stored.value)
            return stored
          }),
        saveAnalysis: (id, analysis) =>
          Effect.gen(function*() {
            analyses.set(id, analysis)
            yield* storage.writeJson(analysisKey(id), analysis)
          }),
        remove: (id) =>
          Effect.gen(function*() {
            yield* get(id)
            records.delete(id)
            analyses.delete(id)
            yield* persist
            yield* storage.removePrefix(`media/${id}/`)
          }),
        waitFor: (id, done, timeout) =>
          get(id).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("400 millis"),
              until: done
            }),
            Effect.timeoutOption(timeout),
            Effect.flatMap(() => get(id))
          )
      })
    })
  )
}
