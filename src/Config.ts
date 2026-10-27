import * as Os from "node:os"
import { Config, Context, Effect, Layer, Option, Redacted } from "effect"

/**
 * Runtime settings, read once from the environment.
 *
 * On Cloudflare the Worker passes these to the container as env vars.
 * Locally they come from the shell.
 */
export interface OwlConfigShape {
  readonly port: number
  /** Secret that guards the MCP endpoint path and signs download links. */
  readonly token: Redacted.Redacted<string>
  /** "local" keeps everything under dataDir. "r2" persists to Cloudflare R2 through the Worker. */
  readonly storage: "local" | "r2"
  readonly dataDir: string
  readonly cacheDir: string
  readonly cacheMaxBytes: number
  readonly r2Url: string
  readonly aiUrl: string
  readonly ctlUrl: string
  /** Workers AI over its REST API, for running outside Cloudflare. */
  readonly cfAccountId: Option.Option<string>
  readonly cfApiToken: Option.Option<Redacted.Redacted<string>>
  readonly transcriber: "workers-ai" | "none"
  readonly transcribeModel: string
  readonly embeddingModel: string
  readonly anthropicApiKey: Option.Option<Redacted.Redacted<string>>
  readonly visionModel: string
  readonly publicUrl: Option.Option<string>
  readonly cpus: number
  readonly analysisConcurrency: number
  readonly renderConcurrency: number
  /** Memory one render may use, in MB. Long edits render in pieces that fit it. */
  readonly renderMemoryMb: number
}

export class OwlConfig extends Context.Service<OwlConfig, OwlConfigShape>()("owl/Config") {
  static readonly layer = Layer.effect(
    OwlConfig,
    Effect.gen(function*() {
      const storage = yield* Config.Literals(["local", "r2"], "OWL_STORAGE").pipe(Config.withDefault("local" as const))
      const cfAccountId = yield* Config.option(Config.String("CF_ACCOUNT_ID"))
      const cfApiToken = yield* Config.option(Config.Redacted("CF_API_TOKEN"))
      const workersAiAvailable = storage === "r2" || (Option.isSome(cfAccountId) && Option.isSome(cfApiToken))
      const transcriber = yield* Config.Literals(["workers-ai", "none"], "OWL_TRANSCRIBER").pipe(
        Config.withDefault(workersAiAvailable ? "workers-ai" as const : "none" as const)
      )
      const cpus = Math.max(1, Os.availableParallelism())
      // The container's limit when it has one: the host's total memory is not ours to use.
      const limit = process.constrainedMemory?.() || Os.totalmem()
      const renderConcurrency = yield* Config.Int("OWL_RENDER_CONCURRENCY").pipe(Config.withDefault(1))
      return OwlConfig.of({
        port: yield* Config.Int("PORT").pipe(Config.withDefault(8080)),
        token: yield* Config.Redacted("OWL_TOKEN"),
        storage,
        dataDir: yield* Config.String("OWL_DATA_DIR").pipe(Config.withDefault("./.data")),
        cacheDir: yield* Config.String("OWL_CACHE_DIR").pipe(Config.withDefault(`${Os.tmpdir()}/owl-cache`)),
        cacheMaxBytes: (yield* Config.Number("OWL_CACHE_MAX_GB").pipe(Config.withDefault(14))) * 1024 ** 3,
        r2Url: yield* Config.String("OWL_R2_URL").pipe(Config.withDefault("http://owl.r2")),
        aiUrl: yield* Config.String("OWL_AI_URL").pipe(Config.withDefault("http://owl.ai")),
        ctlUrl: yield* Config.String("OWL_CTL_URL").pipe(Config.withDefault("http://owl.ctl")),
        cfAccountId,
        cfApiToken,
        transcriber,
        transcribeModel: yield* Config.String("OWL_TRANSCRIBE_MODEL").pipe(
          Config.withDefault("@cf/openai/whisper-large-v3-turbo")
        ),
        embeddingModel: yield* Config.String("OWL_EMBEDDING_MODEL").pipe(Config.withDefault("@cf/baai/bge-m3")),
        anthropicApiKey: yield* Config.option(Config.Redacted("ANTHROPIC_API_KEY")),
        visionModel: yield* Config.String("OWL_VISION_MODEL").pipe(Config.withDefault("claude-opus-5-5")),
        publicUrl: yield* Config.option(Config.String("OWL_PUBLIC_URL")),
        cpus,
        analysisConcurrency: yield* Config.Int("OWL_ANALYSIS_CONCURRENCY").pipe(Config.withDefault(2)),
        renderConcurrency,
        renderMemoryMb: yield* Config.Int("OWL_RENDER_MEMORY_MB").pipe(
          Config.withDefault(Math.round(Math.min(6000, Math.max(800, (limit / 1024 ** 2) * 0.4)) / Math.max(1, renderConcurrency)))
        )
      })
    })
  )
}
