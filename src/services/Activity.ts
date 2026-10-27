import { Context, Effect, Layer, Redacted, Schedule } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { OwlConfig } from "../Config.ts"

/**
 * Tracks background work (analysis, renders). On Cloudflare the container is
 * put to sleep after a period without incoming requests, which would kill a
 * long render. While work is running, this pings the Worker so the container's
 * Durable Object renews its activity timeout.
 */
export interface ActivityShape {
  readonly track: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly busy: Effect.Effect<number>
}

export class Activity extends Context.Service<Activity, ActivityShape>()("owl/Activity") {
  static readonly layer = Layer.effect(
    Activity,
    Effect.gen(function*() {
      const config = yield* OwlConfig
      const http = yield* HttpClient.HttpClient
      let running = 0

      if (config.storage === "r2") {
        const ping = Effect.suspend(() =>
          running === 0
            ? Effect.void
            : http.execute(
              HttpClientRequest.post(`${config.ctlUrl}/keepalive`).pipe(
                HttpClientRequest.setHeader("x-owl-token", Redacted.value(config.token))
              )
            ).pipe(Effect.ignore)
        )
        yield* ping.pipe(Effect.repeat(Schedule.spaced("45 seconds")), Effect.forkScoped)
      }

      return Activity.of({
        track: (effect) =>
          Effect.acquireUseRelease(
            Effect.sync(() => running++),
            () => effect,
            () => Effect.sync(() => running--)
          ),
        busy: Effect.sync(() => running)
      })
    })
  )
}
