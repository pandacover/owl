/**
 * Worker thread entry: runs the CPU-heavy audio analysis off the main thread
 * so MCP requests stay responsive while a long file is analyzed.
 */
import { readFileSync } from "node:fs"
import { parentPort, workerData } from "node:worker_threads"
import { analyzeAudio } from "./audio.ts"

const { pcmPath, sampleRate } = workerData as { pcmPath: string; sampleRate: number }
const buffer = readFileSync(pcmPath)
const pcm = new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 2))
parentPort!.postMessage(analyzeAudio(pcm, sampleRate))
