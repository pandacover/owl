import { Effect } from "effect"
import type { FfmpegError } from "../domain/Errors.ts"
import type { FfmpegShape } from "../services/Ffmpeg.ts"

/** Scale so the long side is at most `maxSide`, keeping even dimensions. */
export const fitLongSide = (maxSide: number) =>
  `scale='if(gte(iw,ih),min(${maxSide},iw),-2)':'if(gte(iw,ih),-2,min(${maxSide},ih))'`

const BATCH = 12

/**
 * Grabs single frames at the given times. Each time becomes its own seeked
 * input, so a long file is never decoded from the start, and one FFmpeg
 * process handles a whole batch.
 */
export const extractFrames = (
  ffmpeg: FfmpegShape,
  input: string,
  requests: ReadonlyArray<{ readonly time: number; readonly output: string }>,
  options: { readonly maxSide: number; readonly quality?: number; readonly concurrency?: number }
): Effect.Effect<void, FfmpegError> => {
  const batches: Array<Array<{ readonly time: number; readonly output: string }>> = []
  for (let i = 0; i < requests.length; i += BATCH) batches.push(requests.slice(i, i + BATCH))
  return Effect.forEach(batches, (batch) => {
    const args: Array<string> = []
    for (const r of batch) args.push("-ss", Math.max(0, r.time).toFixed(3), "-i", input)
    batch.forEach((r, i) => {
      args.push("-map", `${i}:v:0`, "-frames:v", "1", "-vf", fitLongSide(options.maxSide), "-q:v", String(options.quality ?? 3), r.output)
    })
    return ffmpeg.run(args)
  }, { concurrency: options.concurrency ?? 2, discard: true })
}
