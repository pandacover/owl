import { Schema } from "effect"

/**
 * Every time value in owl is seconds as a number. Agents may also send a
 * timecode string such as "1:02.5" or "00:01:02.500", which is parsed here.
 */
export const TimeInput = Schema.Union([Schema.Finite, Schema.String]).annotate({
  description: "Time in seconds (e.g. 62.5) or a timecode string (e.g. \"1:02.5\")."
})
export type TimeInput = typeof TimeInput.Type

const timecodePattern = /^(?:(\d+):)?(?:(\d+):)?(\d+(?:\.\d+)?)s?$/

/** Parses seconds or a timecode. Returns undefined when the input is not a time. */
export const parseTime = (input: TimeInput): number | undefined => {
  if (typeof input === "number") return Number.isFinite(input) ? input : undefined
  const trimmed = input.trim()
  const match = timecodePattern.exec(trimmed)
  if (match === null) return undefined
  const [, a, b, c] = match
  const seconds = Number(c)
  if (a !== undefined && b !== undefined) return Number(a) * 3600 + Number(b) * 60 + seconds
  if (a !== undefined) return Number(a) * 60 + seconds
  return seconds
}

/** Rounds to milliseconds so values stay readable in JSON. */
export const round3 = (n: number): number => Math.round(n * 1000) / 1000

/** Formats seconds as m:ss.s (or h:mm:ss.s), the format used in all agent-facing text. */
export const formatTime = (seconds: number): string => {
  const negative = seconds < 0
  const totalTenths = Math.round(Math.abs(seconds) * 10)
  const tenths = totalTenths % 10
  const totalSeconds = Math.floor(totalTenths / 10)
  const s = totalSeconds % 60
  const m = Math.floor(totalSeconds / 60) % 60
  const h = Math.floor(totalSeconds / 3600)
  const ss = `${String(s).padStart(2, "0")}.${tenths}`
  const body = h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`
  return negative ? `-${body}` : body
}

export const formatRange = (start: number, end: number): string => `${formatTime(start)}–${formatTime(end)}`

export const formatDuration = (seconds: number): string =>
  seconds < 60 ? `${round1(seconds)}s` : formatTime(seconds)

export const round1 = (n: number): number => Math.round(n * 10) / 10
