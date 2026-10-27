import { createServer } from "node:http"
import { NodeHttpClient, NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer, Redacted } from "effect"
import { McpProtocol, McpServer } from "effect/ai"
import { HttpRouter, HttpServerRequest } from "effect/http"
import { OwlConfig } from "./Config.ts"
import { RoutesLive } from "./http/routes.ts"
import { INSTRUCTIONS, registerTools } from "./mcp/tools.ts"
import { Activity } from "./services/Activity.ts"
import { Analyzer } from "./services/Analyzer.ts"
import { Ffmpeg } from "./services/Ffmpeg.ts"
import { Links } from "./services/Links.ts"
import { MediaLibrary } from "./services/MediaLibrary.ts"
import { Projects } from "./services/Projects.ts"
import { Renderer } from "./services/Renderer.ts"
import { Search } from "./services/Search.ts"
import { Storage } from "./services/Storage.ts"
import { Transcriber } from "./services/Transcriber.ts"
import { Vision } from "./services/Vision.ts"
import { WorkersAi } from "./services/WorkersAi.ts"

export const VERSION = "0.1.0"

const PlatformLive = Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici)

/** Every owl service, wired together. */
export const ServicesLive = Layer.mergeAll(Analyzer.layer, Projects.layer, Renderer.layer).pipe(
  Layer.provideMerge(Layer.mergeAll(Search.layer, Activity.layer, Transcriber.layer, Vision.layer, Links.layer)),
  Layer.provideMerge(Layer.mergeAll(MediaLibrary.layer, WorkersAi.layer, Ffmpeg.layer)),
  Layer.provideMerge(Storage.layer),
  Layer.provideMerge(OwlConfig.layer),
  Layer.provideMerge(PlatformLive)
)

/** The MCP endpoint lives at /mcp/<OWL_TOKEN>, so the URL itself is the credential. */
const McpLive = Layer.unwrap(Effect.gen(function*() {
  const config = yield* OwlConfig
  return Layer.effectDiscard(registerTools).pipe(
    Layer.provideMerge(McpServer.layerHttp({
      name: "owl",
      version: VERSION,
      description: "Agentic video editor: analyze footage, edit a timeline, render MP4s.",
      instructions: INSTRUCTIONS,
      path: `/mcp/${Redacted.value(config.token)}`,
      protocols: [McpProtocol.v2026_07_28, McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26],
      allowedOrigins: ["https://claude.ai", "https://www.claude.ai", "https://claude.com"]
    }))
  )
}))

const ResumeLive = Layer.effectDiscard(Effect.gen(function*() {
  const analyzer = yield* Analyzer
  yield* analyzer.resumePending
}))

/** Remembers the public origin, so links point at the Worker's domain. */
const originMiddleware = HttpRouter.middleware(Effect.gen(function*() {
  const links = yield* Links
  return (effect) =>
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const forwarded = request.headers["x-owl-origin"]
      const host = request.headers["host"]
      if (forwarded) yield* links.setOrigin(forwarded)
      else if (host) yield* links.setOrigin(`${request.headers["x-forwarded-proto"] ?? "http"}://${host}`)
      return yield* effect
    })
}), { global: true })

const ServerLive = Layer.unwrap(Effect.gen(function*() {
  const config = yield* OwlConfig
  // The built-in access log would print the MCP path, which contains the token.
  return HttpRouter.serve(Layer.mergeAll(McpLive, RoutesLive, ResumeLive).pipe(Layer.provide(originMiddleware)), {
    disableLogger: true
  }).pipe(
    Layer.provide(NodeHttpServer.layer(() => createServer({ requestTimeout: 0 }), { port: config.port }))
  )
}))

if (import.meta.main) {
  ServerLive.pipe(
    Layer.provide(ServicesLive),
    Layer.launch,
    NodeRuntime.runMain
  )
}
