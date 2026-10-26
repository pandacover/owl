import { Container, getContainer, type OutboundHandlerContext } from "@cloudflare/containers"
import { aiHandler, authorized, type HandlerEnv, handleUpload, r2Handler, serveFile, text } from "./handlers.ts"

// Outbound interception (owl.r2, owl.ai, owl.ctl) needs this export.
export { ContainerProxy } from "@cloudflare/containers"

/**
 * The Cloudflare front door for owl.
 *
 * - /mcp/<OWL_TOKEN> is forwarded to the owl container (one instance).
 * - /f/... signed download links are served straight from R2.
 * - /upload/... is the upload page; parts go straight to R2, then the
 *   container is told to analyze the file.
 *
 * The container reaches R2, Workers AI and this Worker through outbound
 * handlers on virtual hosts (owl.r2, owl.ai, owl.ctl), so it holds no
 * Cloudflare credentials.
 */

export interface Env extends HandlerEnv {
  readonly OWL: DurableObjectNamespace<OwlContainer>
  readonly ANTHROPIC_API_KEY?: string
  readonly OWL_VISION_MODEL?: string
}

const INSTANCE = "main"

/** Lets the container keep itself awake while it renders or analyzes. */
const ctlHandler = async (request: Request, env: Env, _ctx: OutboundHandlerContext): Promise<Response> => {
  if (!authorized(request, env)) return text("Forbidden", 403)
  if (new URL(request.url).pathname === "/keepalive") {
    await getContainer(env.OWL, INSTANCE).keepAlive()
    return text("ok")
  }
  return text("Not found", 404)
}

// --------------------------------------------------------------- container

export class OwlContainer extends Container<Env> {
  override defaultPort = 8080
  // Sleep when idle. Background jobs keep it awake through owl.ctl/keepalive.
  override sleepAfter = "15m"

  static override outboundByHost = {
    "owl.r2": r2Handler,
    "owl.ai": aiHandler,
    "owl.ctl": ctlHandler
  }

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env)
    this.envVars = {
      PORT: "8080",
      OWL_STORAGE: "r2",
      OWL_TOKEN: env.OWL_TOKEN,
      OWL_CACHE_DIR: "/tmp/owl",
      ...(env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } : {}),
      ...(env.OWL_VISION_MODEL ? { OWL_VISION_MODEL: env.OWL_VISION_MODEL } : {})
    }
  }

  keepAlive() {
    this.renewActivityTimeout()
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const parts = url.pathname.split("/").filter(Boolean)
    const origin = url.origin

    if (url.pathname === "/" || url.pathname === "/health") return text("owl is running")
    if (parts[0] === "f" && (request.method === "GET" || request.method === "HEAD")) {
      return serveFile(request, env, parts.slice(1))
    }
    if (parts[0] === "upload") {
      return handleUpload(request, env, parts.slice(1), origin, (r) => getContainer(env.OWL, INSTANCE).fetch(r))
    }
    if (parts[0] === "mcp") {
      // Only the secret path wakes the container.
      if (parts[1] !== env.OWL_TOKEN || parts.length !== 2) return text("Not found", 404)
      const forwarded = new Request(request)
      forwarded.headers.set("x-owl-origin", origin)
      return getContainer(env.OWL, INSTANCE).fetch(forwarded)
    }
    return text("Not found", 404)
  }
} satisfies ExportedHandler<Env>
