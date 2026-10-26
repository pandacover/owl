import { open } from "node:fs/promises"
import { Effect, FileSystem, Redacted } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { OwlConfig } from "../Config.ts"
import { newId, randomCode } from "../domain/Ids.ts"
import { Analyzer } from "../services/Analyzer.ts"
import { Links } from "../services/Links.ts"
import { MediaLibrary } from "../services/MediaLibrary.ts"
import { Storage } from "../services/Storage.ts"
import { uploadPage } from "./uploadPage.ts"

const CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  json: "application/json"
}

export const contentType = (key: string) =>
  CONTENT_TYPES[key.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream"

/** "IMG 1234.MOV" to "mov". Unknown types keep a neutral extension; FFmpeg probes the content anyway. */
export const extensionOf = (name: string) => {
  const ext = /\.([a-z0-9]{2,5})$/i.exec(name)?.[1]?.toLowerCase()
  return ext ?? "bin"
}

const PART_SIZE = 16 * 1024 * 1024

const json = (body: unknown, status = 200) =>
  HttpServerResponse.text(JSON.stringify(body), { status, contentType: "application/json" })
const fail = (message: string, status = 400) => HttpServerResponse.text(message, { status })

/**
 * Plain HTTP routes next to the MCP endpoint: health, signed file downloads,
 * the local upload page, and the hook the Cloudflare Worker calls after an
 * upload to R2 finishes.
 */
export const RoutesLive = HttpRouter.use(Effect.fnUntraced(function*(router) {
  const config = yield* OwlConfig
  const links = yield* Links
  const storage = yield* Storage
  const library = yield* MediaLibrary
  const analyzer = yield* Analyzer
  const fs = yield* FileSystem.FileSystem
  const secret = Redacted.value(config.token)

  const registerUpload = (id: string, key: string, name: string) =>
    Effect.gen(function*() {
      yield* library.create({ id, name, sourceKey: key, origin: { type: "upload" } })
      yield* analyzer.start(id)
      return json({ id, name })
    })

  yield* router.add("GET", "/health", HttpServerResponse.text("ok"))

  // Files: /f/<expiry>/<signature>/<key...>
  yield* router.add("GET", "/f/*", (request) =>
    Effect.gen(function*() {
      const path = new URL(request.url, "http://x").pathname
      const [, , expiry, signature, ...rest] = path.split("/")
      const key = rest.map(decodeURIComponent).join("/")
      if (!expiry || !signature || !key || !links.verify(expiry, signature, key)) return fail("Link expired or invalid.", 403)
      const local = yield* storage.localPath(key)
      const size = Number((yield* fs.stat(local)).size)
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers["range"] ?? "")
      const headers = {
        "accept-ranges": "bytes",
        "cache-control": "private, max-age=3600",
        "content-disposition": `inline; filename="${key.split("/").pop()}"`
      }
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
        const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1
        if (start >= size || start > end) {
          return HttpServerResponse.empty({ status: 416, headers: { "content-range": `bytes */${size}` } })
        }
        return yield* HttpServerResponse.file(local, {
          status: 206,
          offset: start,
          bytesToRead: end - start + 1,
          contentType: contentType(key),
          headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}` }
        })
      }
      return yield* HttpServerResponse.file(local, { contentType: contentType(key), headers })
    }).pipe(Effect.catch(() => Effect.succeed(fail("Not found.", 404)))))

  // Local upload page and API. On Cloudflare the Worker answers these paths itself.
  const uploadGuard = (request: HttpServerRequest.HttpServerRequest) => {
    const [, , expiry, signature] = new URL(request.url, "http://x").pathname.split("/")
    return Boolean(expiry && signature && links.verify(expiry, signature, "upload"))
  }
  const uploads = new Map<string, { readonly key: string; readonly path: string }>()

  yield* router.add("GET", "/upload/:expiry/:signature", (request) =>
    Effect.succeed(uploadGuard(request) ? HttpServerResponse.html(uploadPage) : fail("This upload link expired. Ask Claude for a new one.", 403)))

  yield* router.add("POST", "/upload/:expiry/:signature/start", (request) =>
    Effect.gen(function*() {
      if (!uploadGuard(request)) return fail("Upload link expired.", 403)
      const body = JSON.parse(yield* request.text) as { name?: string }
      const id = newId("m")
      const key = `media/${id}/source.${extensionOf(body.name ?? "")}`
      const path = yield* storage.stagingPath(key)
      yield* fs.writeFile(path, new Uint8Array())
      const uploadId = randomCode(16)
      uploads.set(uploadId, { key, path })
      return json({ id, key, uploadId, partSize: PART_SIZE })
    }).pipe(Effect.catch((e) => Effect.succeed(fail(String(e), 500)))))

  yield* router.add("PUT", "/upload/:expiry/:signature/part", (request) =>
    Effect.gen(function*() {
      if (!uploadGuard(request)) return fail("Upload link expired.", 403)
      const params = new URL(request.url, "http://x").searchParams
      const upload = uploads.get(params.get("uploadId") ?? "")
      const part = Number(params.get("part"))
      if (!upload || !Number.isInteger(part) || part < 1) return fail("Unknown upload.")
      const bytes = new Uint8Array(yield* request.arrayBuffer)
      yield* Effect.promise(async () => {
        const handle = await open(upload.path, "r+")
        try {
          await handle.write(bytes, 0, bytes.length, (part - 1) * PART_SIZE)
        } finally {
          await handle.close()
        }
      })
      return json({ etag: `${part}` })
    }).pipe(Effect.catch((e) => Effect.succeed(fail(String(e), 500)))))

  yield* router.add("POST", "/upload/:expiry/:signature/complete", (request) =>
    Effect.gen(function*() {
      if (!uploadGuard(request)) return fail("Upload link expired.", 403)
      const body = JSON.parse(yield* request.text) as { id: string; uploadId: string; name?: string }
      const upload = uploads.get(body.uploadId)
      if (!upload) return fail("Unknown upload.")
      uploads.delete(body.uploadId)
      yield* storage.commitFile(upload.key, contentType(upload.key))
      return yield* registerUpload(body.id, upload.key, body.name ?? "upload")
    }).pipe(Effect.catch((e) => Effect.succeed(fail(String(e), 500)))))

  // Called by the Worker once an upload to R2 is complete.
  yield* router.add("POST", "/internal/uploads/complete", (request) =>
    Effect.gen(function*() {
      if (request.headers["x-owl-token"] !== secret) return fail("Forbidden.", 403)
      const body = JSON.parse(yield* request.text) as { id: string; key: string; name: string }
      if (!/^m_[a-z0-9]+$/.test(body.id) || !body.key.startsWith(`media/${body.id}/`)) return fail("Bad upload.")
      return yield* registerUpload(body.id, body.key, body.name)
    }).pipe(Effect.catch((e) => Effect.succeed(fail(String(e), 500)))))
}))
