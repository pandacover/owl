import { Worker } from "node:worker_threads"
import { Effect } from "effect"
import type { AudioAnalysis } from "../domain/Media.ts"
import { PCM_SAMPLE_RATE } from "./audio.ts"

// Source runs with type stripping (.ts), the build runs compiled .js.
const workerUrl = new URL(import.meta.url.endsWith(".ts") ? "./audioWorker.ts" : "./audioWorker.js", import.meta.url)

/** Analyzes a raw PCM file (mono s16le) in a worker thread. */
export const runAudioAnalysis = (pcmPath: string): Effect.Effect<AudioAnalysis, Error> =>
  Effect.callback<AudioAnalysis, Error>((resume) => {
    const worker = new Worker(workerUrl, { workerData: { pcmPath, sampleRate: PCM_SAMPLE_RATE } })
    worker.once("message", (result: AudioAnalysis) => resume(Effect.succeed(result)))
    worker.once("error", (error) => resume(Effect.fail(error)))
    worker.once("exit", (code) => {
      if (code !== 0) resume(Effect.fail(new Error(`Audio analysis worker exited with code ${code}`)))
    })
    return Effect.promise(() => worker.terminate())
  })
