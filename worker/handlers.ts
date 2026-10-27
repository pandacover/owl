import { uploadPage } from "../src/http/uploadPage.ts"

/**
 * Request handlers of the Worker, kept free of Workers-only imports so the
 * tests can run them in Node against a fake bucket.
 */

export interface HandlerEnv {
  readonly BUCKET: R2Bucket
  readonly AI: Ai
  readonly OWL_TOKEN: string
}

/** Sends a request to the owl container. */
export type ContainerFetch = (request: Request) => Promise<Response>

const UPLOAD_PART_SIZE = 8 * 1024 * 1024

export const text = (body: string, status = 200) => new Response(body, { status })
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

export const authorized = (request: Request, env: HandlerEnv) => request.headers.get("x-owl-token") === env.OWL_TOKEN

// ---------------------------------------------------------------- signing

const encoder = new TextEncoder()
const keyCache = new Map<string, Promise<CryptoKey>>()
const hmacKey = (secret: string) => {
  let key = keyCache.get(secret)
  if (!key) {
    key = crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    keyCache.set(secret, key)
  }
  return key
}

const base64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

/** Same scheme as src/services/Links.ts. */
export const sign = async (secret: string, expiry: number, key: string) =>
  base64url(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(`${expiry}/${key}`))).slice(0, 32)

export const verify = async (secret: string, expiry: string, signature: string, key: string) => {
  const exp = Number(expiry)
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false
  const expected = await sign(secret, exp, key)
  if (expected.length !== signature.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  return diff === 0
}

// ------------------------------------------------------------ R2 contract

/**
 * The HTTP contract the container's Storage (src/services/Storage.ts) uses
 * at http://owl.r2.
 */
export const r2Handler = async (request: Request, env: HandlerEnv): Promise<Response> => {
  if (!authorized(request, env)) return text("Forbidden", 403)
  const url = new URL(request.url)
  const key = url.pathname.slice(1).split("/").map(decodeURIComponent).join("/")
  const params = url.searchParams
  const bucket = env.BUCKET

  if (key === "") {
    if (request.method === "GET" && params.has("list")) {
      const objects: Array<{ key: string; size: number }> = []
      let cursor: string | undefined
      do {
        const page = await bucket.list({ prefix: params.get("list") ?? "", ...(cursor ? { cursor } : {}) })
        for (const o of page.objects) objects.push({ key: o.key, size: o.size })
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor)
      return json({ objects })
    }
    if (request.method === "DELETE" && params.has("prefix")) {
      const prefix = params.get("prefix") ?? ""
      if (prefix.length < 3) return text("Prefix too short", 400)
      let cursor: string | undefined
      do {
        const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) })
        if (page.objects.length > 0) await bucket.delete(page.objects.map((o) => o.key))
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor)
      return text("ok")
    }
    return text("Bad request", 400)
  }

  switch (request.method) {
    case "GET": {
      const object = await bucket.get(key)
      if (!object) return text("Not found", 404)
      return new Response(object.body, {
        headers: { "content-length": String(object.size), "content-type": object.httpMetadata?.contentType ?? "application/octet-stream" }
      })
    }
    case "HEAD": {
      const object = await bucket.head(key)
      return object ? new Response(null, { headers: { "content-length": String(object.size) } }) : text("Not found", 404)
    }
    case "PUT": {
      const uploadId = params.get("uploadId")
      if (uploadId) {
        const part = await bucket.resumeMultipartUpload(key, uploadId).uploadPart(Number(params.get("partNumber")), request.body!)
        return json({ etag: part.etag })
      }
      await bucket.put(key, request.body, {
        httpMetadata: { contentType: request.headers.get("content-type") ?? "application/octet-stream" }
      })
      return text("ok")
    }
    case "POST": {
      if (params.has("uploads")) {
        const upload = await bucket.createMultipartUpload(key, {
          httpMetadata: { contentType: request.headers.get("content-type") ?? "application/octet-stream" }
        })
        return json({ uploadId: upload.uploadId })
      }
      const uploadId = params.get("uploadId")
      if (uploadId) {
        const { parts } = await request.json<{ parts: Array<R2UploadedPart> }>()
        await bucket.resumeMultipartUpload(key, uploadId).complete(parts)
        return text("ok")
      }
      return text("Bad request", 400)
    }
    case "DELETE":
      await bucket.delete(key)
      return text("ok")
    default:
      return text("Method not allowed", 405)
  }
}

/** Workers AI for the container: POST http://owl.ai/run/<model> with the model input as JSON. */
export const aiHandler = async (request: Request, env: HandlerEnv): Promise<Response> => {
  if (!authorized(request, env)) return text("Forbidden", 403)
  const model = new URL(request.url).pathname.replace(/^\/run\//, "")
  try {
    // The model name comes from owl's own config, so the loose typing is fine here.
    const run = env.AI.run.bind(env.AI) as unknown as (model: string, input: unknown) => Promise<unknown>
    const output = await run(model, await request.json())
    return json(output)
  } catch (error) {
    return json({ error: String(error) }, 502)
  }
}

// ----------------------------------------------------------------- routes

const CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  jpg: "image/jpeg",
  png: "image/png",
  mp3: "audio/mpeg",
  json: "application/json"
}

export const serveFile = async (request: Request, env: HandlerEnv, parts: Array<string>) => {
  const [expiry, signature, ...rest] = parts
  const key = rest.map(decodeURIComponent).join("/")
  if (!expiry || !signature || !key || !(await verify(env.OWL_TOKEN, expiry, signature, key))) {
    return text("This link expired or is invalid. Ask Claude for a new one.", 403)
  }
  const head = await env.BUCKET.head(key)
  if (!head) return text("Not found", 404)
  const size = head.size
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "")
  const headers = new Headers({
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600",
    "content-type": CONTENT_TYPES[key.split(".").pop() ?? ""] ?? head.httpMetadata?.contentType ?? "application/octet-stream",
    "content-disposition": `inline; filename="${key.split("/").pop()}"`,
    etag: head.httpEtag
  })
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } })
    const object = await env.BUCKET.get(key, { range: { offset: start, length: end - start + 1 } })
    if (!object) return text("Not found", 404)
    headers.set("content-range", `bytes ${start}-${end}/${size}`)
    headers.set("content-length", String(end - start + 1))
    return new Response(object.body, { status: 206, headers })
  }
  const object = await env.BUCKET.get(key)
  if (!object) return text("Not found", 404)
  headers.set("content-length", String(size))
  return new Response(object.body, { headers })
}

const ID_ALPHABET = "23456789bcdfghjkmnpqrstvwxyz"
const newMediaId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return `m_${[...bytes].map((b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("")}`
}
const extensionOf = (name: string) => /\.([a-z0-9]{2,5})$/i.exec(name)?.[1]?.toLowerCase() ?? "bin"

export const handleUpload = async (
  request: Request,
  env: HandlerEnv,
  parts: Array<string>,
  origin: string,
  container: ContainerFetch
) => {
  const [expiry, signature, action] = parts
  if (!expiry || !signature || !(await verify(env.OWL_TOKEN, expiry, signature, "upload"))) {
    return text("This upload link expired. Ask Claude for a new one.", 403)
  }
  if (!action && request.method === "GET") {
    return new Response(uploadPage, { headers: { "content-type": "text/html; charset=utf-8" } })
  }
  if (action === "start" && request.method === "POST") {
    const body = await request.json<{ name?: string; type?: string }>()
    const id = newMediaId()
    const key = `media/${id}/source.${extensionOf(body.name ?? "")}`
    const upload = await env.BUCKET.createMultipartUpload(key, {
      httpMetadata: { contentType: body.type || "application/octet-stream" }
    })
    return json({ id, key, uploadId: upload.uploadId, partSize: UPLOAD_PART_SIZE })
  }
  if (action === "part" && request.method === "PUT") {
    const params = new URL(request.url).searchParams
    const key = params.get("key") ?? ""
    if (!/^media\/m_[a-z0-9]+\/source\.[a-z0-9]+$/.test(key) || !request.body) return text("Bad part", 400)
    const part = await env.BUCKET.resumeMultipartUpload(key, params.get("uploadId") ?? "").uploadPart(
      Number(params.get("part")),
      request.body
    )
    return json({ etag: part.etag })
  }
  if (action === "complete" && request.method === "POST") {
    const body = await request.json<{ id: string; key: string; uploadId: string; name: string; parts: Array<R2UploadedPart> }>()
    if (!body.key.startsWith(`media/${body.id}/`)) return text("Bad upload", 400)
    await env.BUCKET.resumeMultipartUpload(body.key, body.uploadId).complete(body.parts)
    return container(new Request("http://owl/internal/uploads/complete", {
      method: "POST",
      headers: { "x-owl-token": env.OWL_TOKEN, "x-owl-origin": origin, "content-type": "application/json" },
      body: JSON.stringify({ id: body.id, key: body.key, name: body.name })
    }))
  }
  return text("Not found", 404)
}

