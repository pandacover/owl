import { formatDuration, formatRange, formatTime, round1 } from "../domain/Time.ts"
import {
  audioItemDuration,
  type CardSettings,
  clipDuration,
  type Fit,
  mainDuration,
  placeMain,
  type Project,
  timelineDuration,
  type ZoomKey
} from "../domain/Timeline.ts"

export interface DescribeSources {
  readonly name: (mediaId: string) => string
  /** Words spoken in a source range, if the media has a transcript. */
  readonly speech?: (mediaId: string, start: number, end: number) => string | undefined
  /** Short visual description of a source range, if the media has shot captions. */
  readonly visual?: (mediaId: string, start: number, end: number) => string | undefined
}

const zoomText = (keys: ReadonlyArray<ZoomKey>) =>
  `zoom ${keys.map((k) => `${round1(k.at)}s ${k.scale}x@${k.x},${k.y}`).join(" → ")}`

const fitText = (fit: Fit, card: CardSettings | undefined) =>
  fit === "card" && card ? `card${card.scale !== undefined ? ` ${card.scale}` : ""}${card.y ? ` y ${card.y}` : ""}` : fit

const quote = (s: string, max: number) => `"${s.length > max ? `${s.slice(0, max - 1)}…` : s}"`

/**
 * The timeline as compact text for an agent. One line per item, timeline
 * times first, so the agent can reason about the edit without JSON.
 */
export const describeProject = (project: Project, sources: DescribeSources, detailed: boolean): string => {
  const t = project.timeline
  const end = timelineDuration(t)
  const lines: Array<string> = []
  lines.push(
    `${project.id} ${quote(project.name, 60)} · version ${project.version} · ${t.output.width}x${t.output.height} ${
      round1(t.output.fps)
    }fps · length ${formatDuration(end)} · background ${t.output.background}${t.output.gradient ? `→${t.output.gradient}` : ""}${
      t.output.look ? ` · look ${t.output.look}` : ""
    }`
  )

  const placed = placeMain(t.main)
  lines.push("", `Main track (${t.main.length} clip${t.main.length === 1 ? "" : "s"}, ${formatDuration(mainDuration(t.main))}):`)
  if (placed.length === 0) lines.push("  (empty)")
  for (const p of placed) {
    const c = p.clip
    const extras: Array<string> = []
    if (c.speed !== 1) extras.push(`${c.speed}x`)
    if (c.volume !== 1) extras.push(c.volume === 0 ? "muted" : `vol ${c.volume}`)
    if (c.fit !== "auto") extras.push(fitText(c.fit, c.card))
    if (c.zoom) extras.push(zoomText(c.zoom))
    if (c.glow) extras.push(`glow ${c.glow}`)
    if (c.transition) extras.push(`${c.transition.type} ${c.transition.duration}s in`)
    lines.push(
      `  ${c.id}  ${formatRange(p.start, p.end)}  ${c.mediaId} ${quote(sources.name(c.mediaId), 30)} ${
        formatRange(c.in, c.out)
      }${extras.length ? `  ${extras.join(", ")}` : ""}`
    )
    if (detailed) {
      const visual = sources.visual?.(c.mediaId, c.in, c.out)
      if (visual) lines.push(`      sees: ${visual}`)
      const speech = sources.speech?.(c.mediaId, c.in, c.out)
      if (speech) lines.push(`      says: ${quote(speech, 400)}`)
    }
  }

  if (t.overlays.length > 0) {
    lines.push("", "Overlays:")
    for (const o of t.overlays) {
      const extras: Array<string> = [o.layout]
      if (o.volume > 0) extras.push(`vol ${o.volume}`)
      if (o.speed !== 1) extras.push(`${o.speed}x`)
      if (o.fit !== "auto") extras.push(fitText(o.fit, o.card))
      if (o.zoom) extras.push(zoomText(o.zoom))
      if (o.fadeIn > 0) extras.push(`fade in ${o.fadeIn}s`)
      if (o.fadeOut > 0) extras.push(`fade out ${o.fadeOut}s`)
      lines.push(
        `  ${o.id}  ${formatRange(o.start, o.start + clipDuration(o))}  ${o.mediaId} ${quote(sources.name(o.mediaId), 30)} ${
          formatRange(o.in, o.out)
        }  ${extras.join(", ")}`
      )
      if (detailed) {
        const visual = sources.visual?.(o.mediaId, o.in, o.out)
        if (visual) lines.push(`      sees: ${visual}`)
      }
    }
  }

  if (t.audio.length > 0) {
    lines.push("", "Audio:")
    const videoEnd = mainDuration(t.main) || end
    for (const a of t.audio) {
      const length = audioItemDuration(a, videoEnd)
      const extras = [`vol ${a.volume}`]
      if (a.loop) extras.push(a.duration === undefined ? "loops to end" : "looped")
      if (a.duck) extras.push("ducks under speech")
      if (a.fadeIn > 0) extras.push(`fade in ${a.fadeIn}s`)
      if (a.fadeOut > 0) extras.push(`fade out ${a.fadeOut}s`)
      lines.push(
        `  ${a.id}  ${formatRange(a.start, a.start + length)}  ${a.mediaId} ${quote(sources.name(a.mediaId), 30)} from ${
          formatTime(a.in)
        }  ${extras.join(", ")}`
      )
    }
  }

  if (t.texts.length > 0) {
    lines.push("", "Text:")
    for (const x of t.texts) {
      const extras: Array<string> = [x.style, x.position]
      if (x.animation !== "none") extras.push(x.animation)
      if (x.font) extras.push(x.font)
      if (x.y !== undefined) extras.push(`y ${x.y}`)
      if (x.color) extras.push(x.color)
      if (x.background) extras.push(`box ${x.background}`)
      lines.push(`  ${x.id}  ${formatRange(x.start, x.end)}  ${quote(x.text.replace(/\n/g, " / "), 80)}  ${extras.join(", ")}`)
    }
  }

  if (t.blurs && t.blurs.length > 0) {
    lines.push("", "Blurs:")
    for (const b of t.blurs) {
      lines.push(`  ${b.id}  ${formatRange(b.start, b.end)}  box x ${b.x} y ${b.y} w ${b.w} h ${b.h}`)
    }
  }

  if (t.captions) {
    const c = t.captions
    lines.push(
      "",
      `Captions: ${c.style}, ${c.position}, up to ${c.maxWordsPerLine} words per line${c.uppercase ? ", uppercase" : ""}${
        c.style === "karaoke" ? `, highlight ${c.highlightColor}` : ""
      }`
    )
  }
  return lines.join("\n")
}
