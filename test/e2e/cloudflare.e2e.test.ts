import { type ChildProcess, spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { aiHandler, type HandlerEnv, handleUpload, r2Handler, serveFile } from "../../worker/handlers.ts"
import { FakeAi, FakeBucket, fakeClaude, type Listening, serve } from "./fakes.ts"

/**
 * The Cloudflare deployment, simulated in Node: the Worker's real handlers
 * run against an in-memory R2 bucket and fake Workers AI, the owl server runs
 * in R2 mode exactly as in the container, and Claude captions come from a fake
 * Messages API. Also checks that state survives a container restart.
 */

const SAMPLES = process.env["OWL_SAMPLES"] ?? "/tmp/claude-0/media"
const TOKEN = "cf-e2e-token"

const bucket = new FakeBucket()
const ai = new FakeAi()
const claude = fakeClaude()
const env = { BUCKET: bucket, AI: ai, OWL_TOKEN: TOKEN } as unknown as HandlerEnv

let r2: Listening
let aiServer: Listening
let ctl: Listening
let claudeServer: Listening
let front: Listening
let owl: ChildProcess
let owlUrl = ""
let client: Client
const keepalives: Array<string> = []
const tempDirs: Array<string> = []

const startOwl = async () => {
  const port = 19000 + Math.floor(Math.random() * 1000)
  const cache = mkdtempSync(join(tmpdir(), "owl-cf-cache-"))
  tempDirs.push(cache)
  owl = spawn(process.execPath, ["src/main.ts"], {
    env: {
      ...process.env,
      PORT: String(port),
      OWL_TOKEN: TOKEN,
      OWL_STORAGE: "r2",
      OWL_R2_URL: r2.url,
      OWL_AI_URL: aiServer.url,
      OWL_CTL_URL: ctl.url,
      OWL_CACHE_DIR: cache,
      ANTHROPIC_API_KEY: "test-key",
      ANTHROPIC_BASE_URL: claudeServer.url,
      OWL_VISION_MODEL: "claude-haiku-5-5"
    },
    stdio: ["ignore", "inherit", "inherit"]
  })
  owlUrl = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    try {
      // A request that lands while the server is still starting can go unanswered, so each try has a time limit.
      if ((await fetch(`${owlUrl}/health`, { signal: AbortSignal.timeout(2000) })).ok) return
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error("owl did not start")
}

const connect = async () => {
  client = new Client({ name: "cf-e2e", version: "1.0.0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${front.url}/mcp/${TOKEN}`)))
}

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })
  const content = result.content as Array<{ type: string; text?: string }>
  const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n")
  if (process.env["OWL_E2E_LOG"]) console.log(`\n>>> ${name} ${JSON.stringify(args).slice(0, 200)}\n${text}`)
  return { text, isError: result.isError === true, images: content.filter((c) => c.type === "image").length }
}

/** Forwards a request to the owl server, like the Container class does. */
const toContainer = async (request: Request) => {
  const url = new URL(request.url)
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()
  return fetch(`${owlUrl}${url.pathname}${url.search}`, { method: request.method, headers: request.headers, ...(body ? { body } : {}) })
}

beforeAll(async () => {
  r2 = await serve((request) => r2Handler(request, env))
  aiServer = await serve((request) => aiHandler(request, env))
  ctl = await serve((request) => {
    keepalives.push(new URL(request.url).pathname)
    return new Response("ok")
  })
  claudeServer = await serve(claude.handler)
  // The Worker's routing, as in worker/index.ts.
  front = await serve(async (request) => {
    const url = new URL(request.url)
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts[0] === "f") return serveFile(request, env, parts.slice(1))
    if (parts[0] === "upload") return handleUpload(request, env, parts.slice(1), url.origin, toContainer)
    if (parts[0] === "mcp" && parts[1] === TOKEN) {
      const forwarded = new Request(request)
      forwarded.headers.set("x-owl-origin", url.origin)
      return toContainer(forwarded)
    }
    return new Response("Not found", { status: 404 })
  })
  await startOwl()
  await connect()
}, 30_000)

afterAll(async () => {
  await client?.close()
  owl?.kill()
  for (const s of [r2, aiServer, ctl, claudeServer, front]) await s?.close()
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

const upload = async (uploadUrl: string, file: string) => {
  const name = file.split("/").pop()!
  const bytes = readFileSync(file)
  const start = await (await fetch(`${uploadUrl}/start`, { method: "POST", body: JSON.stringify({ name, size: bytes.length, type: "video/mp4" }) })).json() as {
    id: string
    key: string
    uploadId: string
    partSize: number
  }
  const parts = []
  for (let i = 0; i * start.partSize < bytes.length; i++) {
    const res = await fetch(`${uploadUrl}/part?key=${encodeURIComponent(start.key)}&uploadId=${start.uploadId}&part=${i + 1}`, {
      method: "PUT",
      body: bytes.subarray(i * start.partSize, (i + 1) * start.partSize)
    })
    parts.push({ partNumber: i + 1, etag: ((await res.json()) as { etag: string }).etag })
  }
  const done = await fetch(`${uploadUrl}/complete`, {
    method: "POST",
    body: JSON.stringify({ id: start.id, key: start.key, uploadId: start.uploadId, name, parts })
  })
  expect(done.status).toBe(200)
  return ((await done.json()) as { id: string }).id
}

describe("owl on Cloudflare (simulated)", () => {
  const ids: Record<string, string> = {}
  let project = ""

  it("uploads through the Worker into R2 and analyzes with AI", async () => {
    const link = await call("media_upload_link")
    const url = /(http\S+\/upload\/\S+)/.exec(link.text)![1]!
    expect(url.startsWith(front.url)).toBe(true)
    for (const name of ["scenes.mp4", "echo-hereweare.mp4"]) ids[name] = await upload(url, join(SAMPLES, name))
    expect(bucket.objects.has(`media/${ids["scenes.mp4"]}/source.mp4`)).toBe(true)

    const scenes = await call("media_get", { media: ids["scenes.mp4"], wait_seconds: 50 })
    expect(scenes.text).toContain("ready")
    expect(scenes.text).toContain("A red sports car drives along a coastal road")
    expect(scenes.text).toContain("Hello everyone")
    await call("media_get", { media: ids["echo-hereweare.mp4"], wait_seconds: 50 })
    expect(bucket.objects.has(`media/${ids["scenes.mp4"]}/proxy.mp4`)).toBe(true)
    expect(bucket.objects.has(`media/${ids["scenes.mp4"]}/embeddings.json`)).toBe(true)
    expect(claude.requests[0]!.model).toBe("claude-haiku-5-5")
    expect(claude.requests[0]!.images).toBeGreaterThan(0)
  }, 120_000)

  it("finds shots by meaning", async () => {
    const res = await call("media_search", { query: "car driving at sunset", kind: "shot", limit: 3 })
    expect(res.text).toMatch(/shot (2|4) .*red sports car/)
  })

  it("edits with smart tools and renders to a signed R2 link", async () => {
    project = /(p_[a-z0-9]+)/.exec((await call("project_create", { name: "CF test" })).text)![1]!
    await call("timeline_edit", {
      project,
      ops: [
        { op: "set_main", clips: [{ media: ids["scenes.mp4"], in: 0, out: 6 }] },
        { op: "set_captions", enabled: true, style: "karaoke" }
      ]
    })
    const fillers = await call("edit_remove_fillers", { project })
    expect(fillers.text).toContain("um ×1")
    const pauses = await call("edit_remove_pauses", { project, dry_run: true })
    expect(pauses.text).toContain("Would cut")

    const frames = await call("preview_frames", { project, times: [1] })
    expect(frames.images).toBe(1)

    const render = await call("render_start", { project, quality: "draft", wait_seconds: 50 })
    expect(render.text).toContain("done")
    const link = /Link \(valid 7 days\): (\S+)/.exec(render.text)![1]!
    expect(link.startsWith(front.url)).toBe(true)
    const video = await fetch(link, { headers: { range: "bytes=0-1023" } })
    expect(video.status).toBe(206)
    expect(video.headers.get("content-type")).toBe("video/mp4")
    const tampered = await fetch(link.replace(/\/f\/(\d+)\/./, "/f/$1/x"))
    expect(tampered.status).toBe(403)
  }, 120_000)

  it("keeps everything after the container restarts with an empty disk", async () => {
    await client.close()
    owl.kill()
    await new Promise((r) => setTimeout(r, 300))
    await startOwl()
    await connect()
    const list = await call("media_list")
    expect(list.text).toContain(ids["scenes.mp4"])
    const timeline = await call("timeline_get", { project })
    expect(timeline.text).toContain("Captions: karaoke")
    const final = await call("render_start", { project, quality: "final", wait_seconds: 50 })
    expect(final.text).toContain("done")
    expect(final.text).toContain("final")
  }, 120_000)
})
