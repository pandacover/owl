import { type ChildProcess, spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * Runs the real server with local storage and drives it through an MCP
 * client, the way Claude would. Needs ffmpeg and the sample media from
 * scripts/sample-media.sh (OWL_SAMPLES points at the folder).
 */

const SAMPLES = process.env["OWL_SAMPLES"] ?? "/tmp/claude-0/media"
const PORT = 18000 + Math.floor(Math.random() * 1000)
const TOKEN = "e2e-token"
const base = `http://127.0.0.1:${PORT}`

let server: ChildProcess
let client: Client
let dataDir: string

type Content = { type: string; text?: string; data?: string; mimeType?: string }
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })
  const content = result.content as Array<Content>
  const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n")
  if (process.env["OWL_E2E_LOG"]) console.log(`\n>>> ${name} ${JSON.stringify(args).slice(0, 300)}\n${text}`)
  return { text, images: content.filter((c) => c.type === "image"), isError: result.isError === true }
}

const upload = async (uploadUrl: string, file: string) => {
  const name = file.split("/").pop()!
  const bytes = readFileSync(file)
  const start = await (await fetch(`${uploadUrl}/start`, {
    method: "POST",
    body: JSON.stringify({ name, size: bytes.length, type: "" })
  })).json() as { id: string; key: string; uploadId: string; partSize: number }
  const parts = []
  for (let i = 0; i * start.partSize < bytes.length; i++) {
    const res = await fetch(`${uploadUrl}/part?key=${encodeURIComponent(start.key)}&uploadId=${start.uploadId}&part=${i + 1}`, {
      method: "PUT",
      body: bytes.subarray(i * start.partSize, (i + 1) * start.partSize)
    })
    parts.push({ partNumber: i + 1, etag: ((await res.json()) as { etag: string }).etag })
  }
  const done = await (await fetch(`${uploadUrl}/complete`, {
    method: "POST",
    body: JSON.stringify({ id: start.id, key: start.key, uploadId: start.uploadId, name, parts })
  })).json() as { id: string }
  return done.id
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "owl-e2e-"))
  server = spawn(process.execPath, ["src/main.ts"], {
    env: { ...process.env, PORT: String(PORT), OWL_TOKEN: TOKEN, OWL_DATA_DIR: dataDir, OWL_CACHE_DIR: join(dataDir, "cache") },
    stdio: ["ignore", "inherit", "inherit"]
  })
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  client = new Client({ name: "owl-e2e", version: "1.0.0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${TOKEN}`)))
}, 30_000)

afterAll(async () => {
  await client?.close()
  server?.kill()
  rmSync(dataDir, { recursive: true, force: true })
})

describe("owl over MCP", () => {
  const ids: Record<string, string> = {}

  it("lists tools with object input schemas", async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toContain("timeline_edit")
    for (const tool of tools) expect(tool.inputSchema.type).toBe("object")
  })

  it("uploads and analyzes media", async () => {
    const link = await call("media_upload_link")
    const url = /(http\S+\/upload\/\S+)/.exec(link.text)![1]!
    expect((await fetch(url)).status).toBe(200)
    for (const name of ["scenes.mp4", "vertical.mp4", "echo-hereweare.mp4", "logo.png"]) {
      ids[name] = await upload(url, join(SAMPLES, name))
    }
    for (const id of Object.values(ids)) {
      const got = await call("media_get", { media: id, wait_seconds: 50 })
      expect(got.text).toContain("ready")
    }
    const scenes = await call("media_get", { media: ids["scenes.mp4"], detail: "full" })
    expect(scenes.text).toMatch(/4 shots/)
    expect(scenes.text).toMatch(/BPM/)
  }, 120_000)

  it("shows source frames as images", async () => {
    const frames = await call("preview_frames", { media: ids["scenes.mp4"] })
    expect(frames.images.length).toBe(4)
    expect(frames.images[0]!.mimeType).toBe("image/jpeg")
  })

  it("searches by keywords without AI keys", async () => {
    const res = await call("media_search", { query: "static" })
    expect(res.isError).toBe(false)
  })

  it("builds, previews, undoes and renders an edit", async () => {
    const created = await call("project_create", { name: "E2E reel", aspect: "9:16" })
    const project = /(p_[a-z0-9]+)/.exec(created.text)![1]!
    const edit = await call("timeline_edit", {
      project,
      ops: [
        {
          op: "set_main",
          clips: [
            { media: ids["scenes.mp4"], shot: 1 },
            { media: ids["vertical.mp4"], in: 0, out: 2, transition: { type: "crossfade", duration: 0.4 } },
            { media: ids["scenes.mp4"], in: "0:06", out: "0:08.5" }
          ]
        },
        { op: "add_overlay", media: ids["logo.png"], start: 0.5, duration: 2, layout: "pip_top_right" },
        { op: "add_text", text: "Owl test", start: 0.2, duration: 2, style: "title" },
        { op: "add_audio", media: ids["echo-hereweare.mp4"], volume: 0.3, fill: true }
      ]
    })
    expect(edit.isError).toBe(false)
    expect(edit.text).toContain("c1")
    expect(edit.text).toContain("1080x1920")

    const bad = await call("timeline_edit", { project, ops: [{ op: "trim_clip", clip: "c42", in: 1 }] })
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain("Main clips are: c1, c2, c3")

    const frames = await call("preview_frames", { project, times: [1, 4] })
    expect(frames.images.length).toBe(2)

    await call("timeline_edit", { project, ops: [{ op: "delete", ids: ["c2"] }] })
    const undone = await call("timeline_undo", { project })
    expect(undone.text).toContain("c2")

    const render = await call("render_start", { project, quality: "draft", wait_seconds: 50 })
    expect(render.text).toContain("done")
    const link = /Link \(valid 7 days\): (\S+)/.exec(render.text)![1]!
    const video = await fetch(link)
    expect(video.status).toBe(200)
    expect(Number(video.headers.get("content-length"))).toBeGreaterThan(10_000)
    const ranged = await fetch(link, { headers: { range: "bytes=0-99" } })
    expect(ranged.status).toBe(206)
    expect((await ranged.arrayBuffer()).byteLength).toBe(100)
    const again = await call("render_start", { project, quality: "draft" })
    expect(again.text).toContain(/(r_[a-z0-9]+)/.exec(render.text)![1]!)
  }, 120_000)
})
