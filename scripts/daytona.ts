/**
 * Deploys owl to a Daytona sandbox, for testing the editor without Cloudflare.
 *
 * Creates (or reuses) a public sandbox named "owl" with FFmpeg installed,
 * uploads the server code, writes its settings and (re)starts it under a small
 * supervisor loop. Files live on the sandbox disk, which survives redeploys.
 *
 * Needs DAYTONA_API_KEY and OWL_TOKEN. Optional: ANTHROPIC_API_KEY,
 * OWL_VISION_MODEL, CF_ACCOUNT_ID + CF_API_TOKEN (speech transcripts and
 * semantic search), DAYTONA_CPU, DAYTONA_MEMORY, DAYTONA_DISK, DAYTONA_RESET.
 */
import { execFileSync } from "node:child_process"
import { appendFileSync } from "node:fs"
import { Daytona, DaytonaNotFoundError, Image, type Sandbox } from "@daytona/sdk"

const NAME = "owl"
const PORT = 8080

const env = (key: string) => process.env[key]?.trim() || undefined
const fail = (message: string): never => {
  console.error(`\n${message}\n`)
  process.exit(1)
}
const summary = (text: string) => {
  console.log(text)
  const file = env("GITHUB_STEP_SUMMARY")
  if (file) appendFileSync(file, `${text}\n`)
}

if (!env("DAYTONA_API_KEY")) fail("DAYTONA_API_KEY is missing. Add it as a repository secret, then run the workflow again.")
const token = env("OWL_TOKEN") ?? fail("OWL_TOKEN is missing. Add it as a repository secret, then run the workflow again.")
if (!/^[A-Za-z0-9_-]{16,}$/.test(token)) fail("OWL_TOKEN must be at least 16 letters, numbers, - or _.")

const daytona = new Daytona()

const image = Image.base("node:22-trixie-slim").runCommands(
  "apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-inter fonts-dejavu-core fonts-noto-core ca-certificates procps tar && rm -rf /var/lib/apt/lists/*"
)

const find = async () => {
  try {
    return await daytona.get(NAME)
  } catch (error) {
    if (error instanceof DaytonaNotFoundError) return undefined
    throw error
  }
}

let sandbox: Sandbox | undefined = await find()
if (sandbox && env("DAYTONA_RESET") === "true") {
  console.log("Deleting the old sandbox (reset requested)...")
  await sandbox.delete()
  sandbox = undefined
}
if (!sandbox) {
  console.log("Creating the sandbox. The first build installs FFmpeg and takes a few minutes...")
  sandbox = await daytona.create(
    {
      name: NAME,
      image,
      public: true,
      autoStopInterval: 0,
      resources: {
        cpu: Number(env("DAYTONA_CPU") ?? 2),
        memory: Number(env("DAYTONA_MEMORY") ?? 4),
        disk: Number(env("DAYTONA_DISK") ?? 10)
      },
      labels: { app: "owl" }
    },
    { timeout: 0, onSnapshotCreateLogs: (chunk) => process.stdout.write(chunk) }
  )
} else if (sandbox.state !== "started") {
  console.log(`Starting the sandbox (it was ${sandbox.state})...`)
  await sandbox.start(120)
}
const box = sandbox
// Claude reaches owl from the internet, so the sandbox must stay up and public.
await box.setAutostopInterval(0)
await box.setPublic(true)

const home = (await box.getUserHomeDir()) ?? "/root"
const app = `${home}/owl`
const origin = (await box.getPreviewLink(PORT)).url.replace(/\/$/, "")

const run = async (command: string, timeout = 600) => {
  const result = await box.process.executeCommand(command, app, undefined, timeout)
  if (result.exitCode !== 0) fail(`Command failed (${result.exitCode}): ${command}\n${result.result}`)
  return result.result
}

console.log("Uploading the server code...")
const bundle = execFileSync("tar", ["-czf", "-", "package.json", "package-lock.json", "src"], { maxBuffer: 256 * 1024 ** 2 })
await box.process.executeCommand(`mkdir -p ${app}`, home)
await box.fs.uploadFile(bundle, `${app}/owl.tgz`)
await run("rm -rf src && tar -xzf owl.tgz && rm owl.tgz")
console.log("Installing dependencies...")
await run("npm ci --omit=dev --ignore-scripts --no-audit --no-fund")

const settings: Record<string, string | undefined> = {
  PORT: String(PORT),
  OWL_TOKEN: token,
  OWL_STORAGE: "local",
  OWL_DATA_DIR: `${home}/owl-data`,
  OWL_CACHE_DIR: `${home}/owl-cache`,
  OWL_CACHE_MAX_GB: "2",
  OWL_PUBLIC_URL: origin,
  ANTHROPIC_API_KEY: env("ANTHROPIC_API_KEY"),
  OWL_VISION_MODEL: env("OWL_VISION_MODEL"),
  CF_ACCOUNT_ID: env("CF_ACCOUNT_ID"),
  CF_API_TOKEN: env("CF_API_TOKEN")
}
const dotenv = Object.entries(settings)
  .filter((entry): entry is [string, string] => entry[1] !== undefined)
  .map(([key, value]) => `${key}=${value}`)
  .join("\n")
await box.fs.uploadFile(Buffer.from(`${dotenv}\n`), `${app}/.env`)
await box.fs.uploadFile(
  Buffer.from(`#!/bin/sh\ncd "${app}"\nwhile true; do\n  node --env-file=.env src/main.ts\n  sleep 2\ndone\n`),
  `${app}/supervise.sh`
)

// The supervisor restarts owl when it exits, so stopping the old process is
// enough to load the new code. Start the supervisor if it is not running.
console.log("Starting owl...")
await box.process.executeCommand("pkill -f '[n]ode --env-file=.env src/main.ts' || true", app)
const supervised = await box.process.executeCommand("pgrep -f '[s]upervise.sh'", app)
if (supervised.exitCode !== 0) {
  await box.process.deleteSession("owl").catch(() => undefined)
  await box.process.createSession("owl")
  await box.process.executeSessionCommand("owl", { command: `sh ${app}/supervise.sh > ${home}/owl.log 2>&1`, runAsync: true })
}

let healthy = false
for (let i = 0; i < 60 && !healthy; i++) {
  await new Promise((resolve) => setTimeout(resolve, 2000))
  const check = `node -e "fetch('http://127.0.0.1:${PORT}/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"`
  healthy = (await box.process.executeCommand(check, app)).exitCode === 0
}
if (!healthy) fail(`owl did not start. Last log lines:\n${await run(`tail -n 40 ${home}/owl.log`)}`)

summary(`## owl is running on Daytona

MCP URL (add it as a custom connector in Claude):

\`${origin}/mcp/<your OWL_TOKEN>\`

Replace \`<your OWL_TOKEN>\` with the OWL_TOKEN secret you set. Sandbox: \`${box.id}\`.`)
