import { createHmac, timingSafeEqual } from "node:crypto"
import { Context, Effect, Layer, Option, Redacted } from "effect"
import { OwlConfig } from "../Config.ts"

/**
 * Signed, expiring links to stored files (renders, previews, frames).
 *
 * A link is /f/<expiry>/<signature>/<key>. On Cloudflare the Worker checks the
 * signature with the same secret and streams the file from R2, so downloads
 * never touch the container. Locally the owl server serves the same paths.
 */
export interface LinksShape {
  readonly fileUrl: (key: string, ttlSeconds?: number) => Effect.Effect<string>
  readonly uploadUrl: Effect.Effect<string>
  /** Remembers the public origin seen on incoming requests. */
  readonly setOrigin: (origin: string) => Effect.Effect<void>
  readonly verify: (expiry: string, signature: string, key: string) => boolean
}

export const signFile = (secret: string, expiry: number, key: string) =>
  createHmac("sha256", secret).update(`${expiry}/${key}`).digest("base64url").slice(0, 32)

const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/")

export class Links extends Context.Service<Links, LinksShape>()("owl/Links") {
  static readonly layer = Layer.effect(
    Links,
    Effect.gen(function*() {
      const config = yield* OwlConfig
      const secret = Redacted.value(config.token)
      let origin = Option.getOrElse(config.publicUrl, () => `http://localhost:${config.port}`).replace(/\/$/, "")
      const pinned = Option.isSome(config.publicUrl)

      return Links.of({
        fileUrl: (key, ttlSeconds = 7 * 24 * 3600) =>
          Effect.sync(() => {
            const expiry = Math.floor(Date.now() / 1000) + ttlSeconds
            return `${origin}/f/${expiry}/${signFile(secret, expiry, key)}/${encodeKey(key)}`
          }),
        uploadUrl: Effect.sync(() => {
          // The upload page is guarded by a signed token that lasts a day.
          const expiry = Math.floor(Date.now() / 1000) + 24 * 3600
          return `${origin}/upload/${expiry}/${signFile(secret, expiry, "upload")}`
        }),
        setOrigin: (value) =>
          Effect.sync(() => {
            if (!pinned && /^https?:\/\/[^/]+$/.test(value)) origin = value
          }),
        verify: (expiry, signature, key) => {
          const exp = Number(expiry)
          if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false
          const expected = Buffer.from(signFile(secret, exp, key))
          const given = Buffer.from(signature)
          return expected.length === given.length && timingSafeEqual(expected, given)
        }
      })
    })
  )
}
