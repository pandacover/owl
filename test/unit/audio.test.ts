import { describe, expect, it } from "vitest"
import { findSections } from "../../src/analysis/audio.ts"

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
