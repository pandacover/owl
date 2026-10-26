import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

/**
 * Stand-ins for Cloudflare and Anthropic services, so the full Cloudflare
 * setup can be tested in Node: an in-memory R2 bucket, fake Workers AI
 * models and a fake Claude Messages API.
 */

interface StoredObject {
  readonly bytes: Uint8Array
  readonly contentType: string
}

const toBytes = async (body: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null): Promise<Uint8Array> => {
  if (body === null) return new Uint8Array()
  if (typeof body === "string") return new TextEncoder().encode(body)
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  return new Uint8Array(await new Response(body as ReadableStream).arrayBuffer())
}

const objectBody = (o: StoredObject, key: string, range?: { offset: number; length: number }) => {
  const bytes = range ? o.bytes.subarray(range.offset, range.offset + range.length) : o.bytes
  return {
    key,
    size: o.bytes.length,
    httpEtag: `"${o.bytes.length}"`,
    httpMetadata: { contentType: o.contentType },
    body: new Response(bytes).body
  }
}

/** The subset of R2Bucket that owl's Worker uses. */
export class FakeBucket {
  readonly objects = new Map<string, StoredObject>()
  private readonly uploads = new Map<string, { key: string; contentType: string; parts: Map<number, Uint8Array> }>()
  private nextUpload = 1

  async head(key: string) {
    const o = this.objects.get(key)
    return o ? { ...objectBody(o, key), body: undefined } : null
  }
  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    const o = this.objects.get(key)
    return o ? objectBody(o, key, options?.range) : null
  }
  async put(key: string, body: ReadableStream | ArrayBuffer | string | null, options?: { httpMetadata?: { contentType?: string } }) {
    this.objects.set(key, { bytes: await toBytes(body), contentType: options?.httpMetadata?.contentType ?? "application/octet-stream" })
  }
  async delete(keys: string | Array<string>) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key)
  }
  async list(options: { prefix?: string; cursor?: string }) {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(options.prefix ?? "")).sort()
    const start = options.cursor ? Number(options.cursor) : 0
    const page = keys.slice(start, start + 2)
    return {
      objects: page.map((key) => ({ key, size: this.objects.get(key)!.bytes.length })),
      truncated: start + 2 < keys.length,
      cursor: String(start + 2)
    }
  }
  async createMultipartUpload(key: string, options?: { httpMetadata?: { contentType?: string } }) {
    const uploadId = `u${this.nextUpload++}`
    this.uploads.set(uploadId, { key, contentType: options?.httpMetadata?.contentType ?? "application/octet-stream", parts: new Map() })
    return { uploadId }
  }
  resumeMultipartUpload(key: string, uploadId: string) {
    const upload = this.uploads.get(uploadId)
    return {
      uploadPart: async (partNumber: number, body: ReadableStream | ArrayBuffer) => {
        if (!upload || upload.key !== key) throw new Error("unknown upload")
        upload.parts.set(partNumber, await toBytes(body))
        return { partNumber, etag: `etag-${partNumber}` }
      },
      complete: async (parts: Array<{ partNumber: number; etag: string }>) => {
        if (!upload || upload.key !== key) throw new Error("unknown upload")
        const chunks = [...parts].sort((a, b) => a.partNumber - b.partNumber).map((p) => upload.parts.get(p.partNumber)!)
        const total = chunks.reduce((n, c) => n + c.length, 0)
        const bytes = new Uint8Array(total)
        let offset = 0
        for (const c of chunks) {
          bytes.set(c, offset)
          offset += c.length
        }
        this.objects.set(key, { bytes, contentType: upload.contentType })
        this.uploads.delete(uploadId)
      }
    }
  }
}

const hashVector = (text: string, dims = 64) => {
  const v = new Array<number>(dims).fill(0)
  for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0
    for (const c of word) h = (h * 31 + c.charCodeAt(0)) >>> 0
    v[h % dims]! += 1
  }
  return v
}

/** Workers AI binding: Whisper returns one fixed sentence, embeddings are word hashes. */
export class FakeAi {
  readonly calls: Array<string> = []
  async run(model: string, input: Record<string, unknown>) {
    this.calls.push(model)
    if (model.includes("whisper")) {
      const words = [["Hello", 0.5, 0.9], ["everyone,", 0.95, 1.4], ["um,", 1.6, 1.9], ["welcome", 2.6, 3.0], ["to", 3.05, 3.15], ["owl.", 3.2, 3.6]] as const
      return {
        text: "Hello everyone, um, welcome to owl.",
        transcription_info: { language: "en" },
        segments: [{
          start: 0.5,
          end: 3.6,
          text: "Hello everyone, um, welcome to owl.",
          no_speech_prob: 0.01,
          avg_logprob: -0.2,
          words: words.map(([word, start, end]) => ({ word, start, end }))
        }]
      }
    }
    if (model.includes("bge")) {
      return { shape: [], data: (input["text"] as Array<string>).map((t) => hashVector(t)) }
    }
    throw new Error(`unexpected model ${model}`)
  }
}

export interface Listening {
  readonly url: string
  readonly close: () => Promise<void>
}

/** Serves a fetch-style handler on a local port. */
export const serve = (handler: (request: Request) => Promise<Response> | Response): Promise<Listening> =>
  new Promise((resolve) => {
    const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Array<Buffer> = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v)
      const request = new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method!,
        headers,
        ...(body && req.method !== "GET" && req.method !== "HEAD" ? { body } : {})
      })
      try {
        const response = await handler(request)
        res.writeHead(response.status, Object.fromEntries(response.headers))
        if (response.body && req.method !== "HEAD") {
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk)
        }
        res.end()
      } catch (error) {
        res.writeHead(500)
        res.end(String(error))
      }
    })
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) })
    })
  })

/** Claude Messages API that answers caption requests with structured JSON. */
export const fakeClaude = () => {
  const requests: Array<{ model: string; images: number }> = []
  const handler = async (request: Request) => {
    const body = await request.json() as {
      model: string
      messages: Array<{ content: Array<{ type: string; text?: string }> }>
    }
    const content = body.messages[0]!.content
    requests.push({ model: body.model, images: content.filter((c) => c.type === "image").length })
    const shots: Array<number> = []
    const frames = new Map<number, number>()
    for (const c of content) {
      const m = c.type === "text" ? /^Shot (\d+) /.exec(c.text ?? "") : null
      if (m) shots.push(Number(m[1]))
      else if (c.type === "image" && shots.length > 0) {
        const shot = shots[shots.length - 1]!
        frames.set(shot, (frames.get(shot) ?? 0) + 1)
      }
    }
    const json = {
      shots: shots.map((shot) => ({
        shot,
        description: shot % 2 === 1 ? "Bright color bars fill the frame." : "A red sports car drives along a coastal road at sunset.",
        subjects: shot % 2 === 1 ? ["color bars"] : ["red car"],
        setting: shot % 2 === 1 ? "test pattern" : "coastal road",
        shot_type: "wide",
        camera_motion: "static",
        on_screen_text: "",
        tags: shot % 2 === 1 ? ["colorful", "pattern"] : ["car", "sunset", "driving"],
        appeal: 3 + (shot % 2),
        issues: "",
        frame_notes: Array.from({ length: frames.get(shot) ?? 0 }, (_, i) => `Frame ${i + 1} of shot ${shot}.`)
      }))
    }
    return Response.json({
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: JSON.stringify(json) }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 100 }
    })
  }
  return { handler, requests }
}
