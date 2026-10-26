import { Context, Effect, Layer, Option, Redacted } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { OwlConfig } from "../Config.ts"
import { AiError } from "../domain/Errors.ts"

/**
 * Cloudflare Workers AI. Inside the Cloudflare container, requests go to the
 * Worker's outbound handler at `http://owl.ai`, which calls the AI binding,
 * so no API token is needed. Elsewhere it uses the REST API with
 * CF_ACCOUNT_ID and CF_API_TOKEN.
 */
export interface WorkersAiShape {
  readonly available: boolean
  readonly run: (model: string, input: unknown) => Effect.Effect<unknown, AiError>
}

export class WorkersAi extends Context.Service<WorkersAi, WorkersAiShape>()("owl/WorkersAi") {
  static readonly layer = Layer.effect(
    WorkersAi,
    Effect.gen(function*() {
      const config = yield* OwlConfig
      const http = yield* HttpClient.HttpClient
      const rest = Option.all({ account: config.cfAccountId, token: config.cfApiToken })
      const viaWorker = config.storage === "r2"
      const available = viaWorker || Option.isSome(rest)

      const run = (model: string, input: unknown) =>
        Effect.gen(function*() {
          let request: HttpClientRequest.HttpClientRequest
          if (viaWorker) {
            request = HttpClientRequest.post(`${config.aiUrl}/run/${model}`).pipe(
              HttpClientRequest.setHeader("x-owl-token", Redacted.value(config.token))
            )
          } else if (Option.isSome(rest)) {
            request = HttpClientRequest.post(
              `https://api.cloudflare.com/client/v4/accounts/${rest.value.account}/ai/run/${model}`
            ).pipe(HttpClientRequest.bearerToken(Redacted.value(rest.value.token)))
          } else {
            return yield* new AiError({ service: "workers-ai", message: "Workers AI is not configured." })
          }
          const response = yield* http.execute(HttpClientRequest.bodyJsonUnsafe(request, input))
          const body = yield* response.json
          if (response.status >= 400) {
            return yield* new AiError({
              service: "workers-ai",
              message: `HTTP ${response.status}: ${JSON.stringify(body).slice(0, 300)}`
            })
          }
          // The REST API wraps output in { result }, the binding does not.
          const unwrapped = !viaWorker && body !== null && typeof body === "object" && "result" in body
            ? (body as { result: unknown }).result
            : body
          return unwrapped as unknown
        }).pipe(
          Effect.retry({ times: 2, while: (e) => !(e instanceof AiError && e.message.startsWith("HTTP 4")) }),
          Effect.mapError((e) => e instanceof AiError ? e : new AiError({ service: "workers-ai", message: String(e) }))
        )

      return WorkersAi.of({ available, run })
    })
  )
}
