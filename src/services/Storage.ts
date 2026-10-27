import { Context, Effect, FileSystem, Layer, Option, Path, Redacted, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { OwlConfig } from "../Config.ts"
import { StorageError } from "../domain/Errors.ts"

export interface StoredObject {
  readonly key: string
  readonly size: number
}

/**
 * Durable object storage plus a local file cache.
 *
 * FFmpeg needs real files, so every read of a media file goes through
 * `localPath`, which returns a path on local disk. In local mode that is the
 * stored file itself. In R2 mode objects are downloaded into a bounded cache,
 * because Cloudflare container disks are wiped whenever the container sleeps.
 *
 * Binary objects are written once and never modified, so a cached copy never
 * goes stale. JSON documents are read from storage directly.
 */
export interface StorageShape {
  readonly kind: "local" | "r2"
  readonly readJson: <A>(key: string) => Effect.Effect<Option.Option<A>, StorageError>
  readonly writeJson: (key: string, value: unknown) => Effect.Effect<void, StorageError>
  readonly writeBytes: (key: string, bytes: Uint8Array, contentType: string) => Effect.Effect<void, StorageError>
  /** Local path of the object, downloading it into the cache when needed. */
  readonly localPath: (key: string) => Effect.Effect<string, StorageError>
  /** Where to write a new file for `key` before calling `commitFile`. */
  readonly stagingPath: (key: string) => Effect.Effect<string, StorageError>
  /** Persists a file that was written at `stagingPath(key)`. */
  readonly commitFile: (key: string, contentType: string) => Effect.Effect<void, StorageError>
  readonly exists: (key: string) => Effect.Effect<boolean, StorageError>
  readonly list: (prefix: string) => Effect.Effect<ReadonlyArray<StoredObject>, StorageError>
  readonly remove: (key: string) => Effect.Effect<void, StorageError>
  readonly removePrefix: (prefix: string) => Effect.Effect<void, StorageError>
}

export class Storage extends Context.Service<Storage, StorageShape>()("owl/Storage") {
  static readonly layer = Layer.unwrap(Effect.gen(function*() {
    const config = yield* OwlConfig
    return config.storage === "r2" ? layerR2 : layerLocal
  }))
}

const fail = (op: string, key: string) => (cause: unknown) =>
  new StorageError({ op, key, message: cause instanceof Error ? cause.message : String(cause) })

const validateKey = (key: string) =>
  key.length === 0 || key.startsWith("/") || key.split("/").some((part) => part === ".." || part === "")
    ? Effect.fail(new StorageError({ op: "key", key, message: "Invalid storage key" }))
    : Effect.void

const layerLocal = Layer.effect(
  Storage,
  Effect.gen(function*() {
    const config = yield* OwlConfig
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = path.resolve(config.dataDir)
    yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.orDie)

    const pathOf = (key: string) => validateKey(key).pipe(Effect.as(path.join(root, key)))

    const writeAtomic = (key: string, data: Uint8Array) =>
      Effect.gen(function*() {
        const target = yield* pathOf(key)
        yield* fs.makeDirectory(path.dirname(target), { recursive: true })
        const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
        yield* fs.writeFile(tmp, data)
        yield* fs.rename(tmp, target)
      }).pipe(Effect.mapError(fail("write", key)))

    const walk = (dir: string): Effect.Effect<Array<StoredObject>, unknown> =>
      Effect.gen(function*() {
        if (!(yield* fs.exists(dir))) return []
        const entries = yield* fs.readDirectory(dir, { recursive: true })
        const out: Array<StoredObject> = []
        for (const entry of entries) {
          const full = path.join(dir, entry)
          const info = yield* fs.stat(full)
          if (info.type === "File" && !entry.endsWith(".tmp")) {
            out.push({ key: path.relative(root, full).split(path.sep).join("/"), size: Number(info.size) })
          }
        }
        return out
      })

    return Storage.of({
      kind: "local",
      readJson: <A>(key: string) =>
        Effect.gen(function*() {
          const file = yield* pathOf(key)
          if (!(yield* fs.exists(file))) return Option.none<A>()
          return Option.some(JSON.parse(yield* fs.readFileString(file)) as A)
        }).pipe(Effect.mapError(fail("readJson", key))),
      writeJson: (key, value) => writeAtomic(key, new TextEncoder().encode(JSON.stringify(value))),
      writeBytes: (key, bytes) => writeAtomic(key, bytes),
      localPath: (key) =>
        Effect.gen(function*() {
          const file = yield* pathOf(key)
          if (!(yield* fs.exists(file))) return yield* Effect.fail(new Error("Object not found"))
          return file
        }).pipe(Effect.mapError(fail("localPath", key))),
      stagingPath: (key) =>
        Effect.gen(function*() {
          const file = yield* pathOf(key)
          yield* fs.makeDirectory(path.dirname(file), { recursive: true })
          return file
        }).pipe(Effect.mapError(fail("stagingPath", key))),
      commitFile: (key) => validateKey(key),
      exists: (key) => Effect.flatMap(pathOf(key), (file) => fs.exists(file)).pipe(Effect.mapError(fail("exists", key))),
      list: (prefix) => walk(path.join(root, prefix)).pipe(Effect.mapError(fail("list", prefix))),
      remove: (key) =>
        Effect.flatMap(pathOf(key), (file) => fs.remove(file, { force: true })).pipe(
          Effect.mapError(fail("remove", key))
        ),
      removePrefix: (prefix) =>
        Effect.flatMap(pathOf(prefix.replace(/\/$/, "")), (dir) => fs.remove(dir, { recursive: true, force: true })).pipe(
          Effect.mapError(fail("removePrefix", prefix))
        )
    })
  })
)

/** Objects above this size are uploaded in parts. */
const MULTIPART_THRESHOLD = 64 * 1024 * 1024
const PART_SIZE = 32 * 1024 * 1024

/**
 * R2 through the Worker's outbound handler at `http://owl.r2`. The container
 * holds no R2 credentials: the handler runs in the Workers runtime with the
 * bucket binding. The HTTP contract is in worker/r2.ts.
 */
const layerR2 = Layer.effect(
  Storage,
  Effect.gen(function*() {
    const config = yield* OwlConfig
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(HttpClientRequest.setHeader("x-owl-token", Redacted.value(config.token)))
    )
    const ok = HttpClient.filterStatusOk(client)
    const cacheRoot = path.resolve(config.cacheDir)
    yield* fs.makeDirectory(cacheRoot, { recursive: true }).pipe(Effect.orDie)

    const url = (key: string) => `${config.r2Url}/${key.split("/").map(encodeURIComponent).join("/")}`
    const cachePathOf = (key: string) => validateKey(key).pipe(Effect.as(path.join(cacheRoot, key)))

    // Least-recently-used cache bookkeeping, rebuilt lazily as files are touched.
    const cacheIndex = new Map<string, { size: number; used: number }>()
    const touch = (key: string, size: number) => cacheIndex.set(key, { size, used: Date.now() })
    const evict = Effect.gen(function*() {
      let total = 0
      for (const entry of cacheIndex.values()) total += entry.size
      if (total <= config.cacheMaxBytes) return
      const oldest = [...cacheIndex.entries()].sort((a, b) => a[1].used - b[1].used)
      for (const [key, entry] of oldest) {
        if (total <= config.cacheMaxBytes * 0.8) break
        yield* fs.remove(path.join(cacheRoot, key), { force: true }).pipe(Effect.ignore)
        cacheIndex.delete(key)
        total -= entry.size
      }
    })

    // Concurrent requests for the same object share one download.
    const inflight = new Map<string, Effect.Effect<string, unknown>>()
    const download = (key: string, target: string) =>
      Effect.gen(function*() {
        yield* fs.makeDirectory(path.dirname(target), { recursive: true })
        const tmp = `${target}.${Date.now()}.part`
        const response = yield* ok.get(url(key))
        yield* response.stream.pipe(Stream.run(fs.sink(tmp)))
        yield* fs.rename(tmp, target)
        const info = yield* fs.stat(target)
        touch(key, Number(info.size))
        yield* evict
        return target
      })

    const localPath = (key: string) =>
      Effect.gen(function*() {
        const target = yield* cachePathOf(key)
        if (yield* fs.exists(target)) {
          const known = cacheIndex.get(key)
          touch(key, known?.size ?? Number((yield* fs.stat(target)).size))
          return target
        }
        const pending = inflight.get(key)
        if (pending) return yield* pending
        const shared = yield* Effect.cached(
          download(key, target).pipe(Effect.ensuring(Effect.sync(() => inflight.delete(key))))
        )
        inflight.set(key, shared)
        return yield* shared
      }).pipe(Effect.mapError(fail("localPath", key)))

    const putSmall = (key: string, file: string, contentType: string) =>
      Effect.gen(function*() {
        const request = yield* HttpClientRequest.put(url(key)).pipe(HttpClientRequest.bodyFile(file, { contentType }))
        yield* ok.execute(request)
      })

    const putMultipart = (key: string, file: string, size: number, contentType: string) =>
      Effect.gen(function*() {
        const created = yield* ok.post(`${url(key)}?uploads`, {
          headers: { "content-type": contentType }
        }).pipe(Effect.flatMap((r) => r.json))
        const uploadId = (created as unknown as { uploadId: string }).uploadId
        const partCount = Math.ceil(size / PART_SIZE)
        const parts = yield* Effect.forEach(
          Array.from({ length: partCount }, (_, i) => i),
          (i) =>
            Effect.gen(function*() {
              const request = yield* HttpClientRequest.put(
                `${url(key)}?uploadId=${encodeURIComponent(uploadId)}&partNumber=${i + 1}`
              ).pipe(HttpClientRequest.bodyFile(file, { offset: i * PART_SIZE, bytesToRead: PART_SIZE }))
              const response = yield* ok.execute(request)
              const body = (yield* response.json) as unknown as { etag: string }
              return { partNumber: i + 1, etag: body.etag }
            }).pipe(Effect.retry({ times: 2 })),
          { concurrency: 3 }
        )
        yield* ok.execute(
          HttpClientRequest.post(`${url(key)}?uploadId=${encodeURIComponent(uploadId)}`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ parts })
          )
        )
      })

    return Storage.of({
      kind: "r2",
      readJson: <A>(key: string) =>
        Effect.gen(function*() {
          yield* validateKey(key)
          const response = yield* client.get(url(key))
          if (response.status === 404) return Option.none<A>()
          if (response.status >= 400) return yield* Effect.fail(new Error(`HTTP ${response.status}`))
          return Option.some((yield* response.json) as A)
        }).pipe(Effect.mapError(fail("readJson", key))),
      writeJson: (key, value) =>
        validateKey(key).pipe(
          Effect.andThen(ok.execute(HttpClientRequest.put(url(key)).pipe(HttpClientRequest.bodyJsonUnsafe(value)))),
          Effect.asVoid,
          Effect.mapError(fail("writeJson", key))
        ),
      writeBytes: (key, bytes, contentType) =>
        validateKey(key).pipe(
          Effect.andThen(ok.execute(
            HttpClientRequest.put(url(key)).pipe(HttpClientRequest.bodyUint8Array(bytes, contentType))
          )),
          Effect.asVoid,
          Effect.mapError(fail("writeBytes", key))
        ),
      localPath,
      stagingPath: (key) =>
        Effect.gen(function*() {
          const target = yield* cachePathOf(key)
          yield* fs.makeDirectory(path.dirname(target), { recursive: true })
          return target
        }).pipe(Effect.mapError(fail("stagingPath", key))),
      commitFile: (key, contentType) =>
        Effect.gen(function*() {
          const file = yield* cachePathOf(key)
          const size = Number((yield* fs.stat(file)).size)
          if (size > MULTIPART_THRESHOLD) yield* putMultipart(key, file, size, contentType)
          else yield* putSmall(key, file, contentType)
          touch(key, size)
          yield* evict
        }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.mapError(fail("commitFile", key))),
      exists: (key) =>
        validateKey(key).pipe(
          Effect.andThen(client.head(url(key))),
          Effect.map((r) => r.status === 200),
          Effect.mapError(fail("exists", key))
        ),
      list: (prefix) =>
        client.get(`${config.r2Url}/?list=${encodeURIComponent(prefix)}`).pipe(
          Effect.flatMap((r) => r.json),
          Effect.map((body) => (body as unknown as { objects: ReadonlyArray<StoredObject> }).objects),
          Effect.mapError(fail("list", prefix))
        ),
      remove: (key) =>
        Effect.gen(function*() {
          yield* ok.execute(HttpClientRequest.delete(url(key)))
          const cached = yield* cachePathOf(key)
          yield* fs.remove(cached, { force: true })
          cacheIndex.delete(key)
        }).pipe(Effect.mapError(fail("remove", key))),
      removePrefix: (prefix) =>
        Effect.gen(function*() {
          yield* ok.execute(HttpClientRequest.delete(`${config.r2Url}/?prefix=${encodeURIComponent(prefix)}`))
          const cached = yield* cachePathOf(prefix.replace(/\/$/, ""))
          yield* fs.remove(cached, { recursive: true, force: true })
          for (const key of cacheIndex.keys()) if (key.startsWith(prefix)) cacheIndex.delete(key)
        }).pipe(Effect.mapError(fail("removePrefix", prefix)))
    })
  })
)
