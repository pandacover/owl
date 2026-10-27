import { describe, expect, it } from "vitest"
import { analyzeAudio, findHits, findSections, isSoundEffect } from "../../src/analysis/audio.ts"

// Three movements: 60s quiet and sparse, a 3s pause, 40s medium, a 3s pause, 60s loud and busy.
const track = () => {
  const parts: Array<[number, number, number]> = [[30, -40, 0.3], [4, -50, 0.1], [26, -40, 0.3], [3, -90, 0], [40, -28, 0.8], [3, -90, 0], [60, -12, 2]]
  const loudness: Array<number> = []
  const onsets: Array<number> = []
  for (const [seconds, db, busy] of parts) {
    for (let i = 0; i < seconds * 10; i++) loudness.push(db + Math.sin(i) * 0.5)
    for (let i = 0; i < seconds * 100; i++) onsets.push(i % 25 === 0 ? busy * 10 : 0)
  }
  return { loudness, envelope: { values: Float32Array.from(onsets), hopSeconds: 0.01 } }
}

describe("music sections", () => {
  it("splits at the pauses between movements and ranks their energy", () => {
    const { loudness, envelope } = track()
    const { sections, rises } = findSections(loudness, 0.1, envelope, 166)
    expect(sections.map((s) => [s.start, s.end])).toEqual([[0, 60], [63, 103], [106, 166]])
    const [a, b, c] = sections.map((s) => s.energy)
    expect(a!).toBeLessThan(b!)
    expect(b!).toBeLessThan(c!)
    expect(c!).toBeGreaterThan(0.8)
    expect(rises.some((r) => Math.abs(r - 106) < 2)).toBe(true)
  })

  it("leaves short audio alone", () => {
    const { loudness, envelope } = track()
    expect(findSections(loudness.slice(0, 150), 0.1, envelope, 15).sections).toEqual([])
  })
})

describe("sound effect hits", () => {
  // A shutter: a sharp open click, a second click 70ms later, decay to silence at 180ms,
  // repeated every 190ms over a faint noise floor, as in a stock shutter sound file.
  const rate = 22050
  const shutter = (repeats: number) => {
    const samples = new Float32Array(Math.round(rate * 0.19 * repeats + rate * 0.5))
    let seed = 1
    for (let i = 0; i < samples.length; i++) {
      seed = (seed * 16807) % 2147483647
      samples[i] = (seed / 2147483647 - 0.5) * 0.0004
    }
    for (let r = 0; r < repeats; r++) {
      const at = Math.round(r * 0.19 * rate)
      for (const [offset, length] of [[0, 0.06], [0.07, 0.11]] as const) {
        for (let i = 0; i < length * rate; i++) {
          const k = at + Math.round(offset * rate) + i
          samples[k] = samples[k]! + Math.sin(i * 1.3) * 0.6 * Math.exp(-i / (rate * 0.012))
        }
      }
    }
    return samples
  }

  it("finds each shutter as one sound with two attacks", () => {
    const { hits, repeat } = findHits(shutter(4), rate)
    expect(repeat).toBeCloseTo(0.19, 2)
    expect(hits).toHaveLength(4)
    expect(hits[0]!.start).toBeLessThan(0.005)
    expect(hits[0]!.end).toBeGreaterThan(0.1)
    expect(hits[0]!.end).toBeLessThan(0.19)
    expect(hits[0]!.transients).toBe(2)
    expect(hits[1]!.start).toBeCloseTo(0.19, 1)
  })

  it("calls short beatless audio a sound effect", () => {
    const samples = shutter(4)
    const pcm = Int16Array.from(samples, (v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767))
    const audio = analyzeAudio(pcm, rate)
    expect(audio.hits?.length).toBe(4)
    expect(isSoundEffect(audio, samples.length / rate)).toBe(true)
  })
})

it("keeps unrelated sounds apart", () => {
  const rate = 22050
  const samples = new Float32Array(rate * 3)
  for (const [at, length, freq] of [[0.2, 0.3, 0.2], [1.1, 0.05, 0.9], [2, 0.6, 0.05]] as const) {
    for (let i = 0; i < length * rate; i++) samples[Math.round(at * rate) + i] = Math.sin(i * freq) * 0.5
  }
  const { hits, repeat } = findHits(samples, rate)
  expect(repeat).toBeUndefined()
  const expected = [[0.2, 0.5], [1.1, 1.15], [2, 2.6]]
  expect(hits).toHaveLength(3)
  // Measured every 4ms.
  hits.forEach((h, i) => {
    expect(Math.abs(h.start - expected[i]![0]!)).toBeLessThan(0.009)
    expect(Math.abs(h.end - expected[i]![1]!)).toBeLessThan(0.009)
  })
})
