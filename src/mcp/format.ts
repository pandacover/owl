import { isSoundEffect } from "../analysis/audio.ts"
import type { Analysis, MediaRecord, Shot, StageName } from "../domain/Media.ts"
import { formatDuration, formatRange, formatTime, round1 } from "../domain/Time.ts"
import type { SearchHit } from "../services/Search.ts"
import type { RenderJob } from "../services/Renderer.ts"

/**
 * Agent-facing text. Compact, one fact per line, times as m:ss.s, ids first,
 * so an agent can scan and act without parsing JSON.
 */

const STAGES: ReadonlyArray<StageName> = ["probe", "proxy", "shots", "audio", "frames", "transcript", "captions", "index"]

const q = (s: string, max = 40) => `"${s.length > max ? `${s.slice(0, max - 1)}…` : s}"`

export const stageLine = (record: MediaRecord): string =>
  STAGES.flatMap((name) => {
    const stage = record.stages[name]
    if (!stage) return [`${name} pending`]
    const progress = stage.status === "running" && stage.progress !== undefined ? ` ${Math.round(stage.progress * 100)}%` : ""
    const note = stage.note ? ` (${stage.note})` : ""
    return [`${name} ${stage.status}${progress}${note}`]
  }).join(", ")

export const mediaLine = (record: MediaRecord): string => {
  const parts = [`${record.id} ${q(record.name)}`, record.status]
  if (record.status === "ready" && record.summary) parts.push(record.summary)
  else if (record.status === "failed") parts.push(record.error ?? "unknown error")
  else if (record.probe) parts.push(`${record.probe.kind} ${formatDuration(record.probe.duration)}`)
  return parts.join(" · ")
}

export const shotLine = (shot: Shot, full = false): string => {
  const c = shot.caption
  const head = `  shot ${shot.index}  ${formatRange(shot.start, shot.end)}  ${shot.motionLabel === "static" ? "static" : `${shot.motionLabel} motion`}`
  if (!c) return head + momentLines(shot, full)
  const extras = [
    `appeal ${c.appeal}`,
    c.shotType.replace(/_/g, " "),
    c.cameraMotion === "static" ? "" : c.cameraMotion.replace(/_/g, " ")
  ].filter(Boolean)
  const tail = [
    c.description,
    c.onScreenText ? `On-screen text: ${q(c.onScreenText, 80)}.` : "",
    c.issues ? `Issues: ${c.issues}.` : "",
    c.tags.length ? `Tags: ${c.tags.join(", ")}.` : ""
  ].filter(Boolean).join(" ")
  return `${head} · ${extras.join(" · ")} — ${tail}${momentLines(shot, full)}`
}

/** Moments of a shot, one per line, with what the frame shows. */
const momentLines = (shot: Shot, full: boolean): string => {
  const notes = shot.caption?.notes ?? []
  if (shot.moments && shot.moments.length > 0) {
    return shot.moments
      .map((m, i) => `\n      moment ${i + 1}  ${formatRange(m.start, m.end)}${notes[i] ? `  ${notes[i]}` : ""}`)
      .join("")
  }
  if (!full || notes.length < 2) return ""
  return shot.keyframes.map((t, i) => notes[i] ? `\n      at ${formatTime(t)}  ${notes[i]}` : "").join("")
}

export const describeMedia = (record: MediaRecord, analysis: Analysis | undefined, full: boolean): string => {
  const lines = [mediaLine(record)]
  const p = record.probe
  if (p && p.kind !== "audio") {
    lines.push(
      `${p.kind}: ${p.width}x${p.height}${p.kind === "video" ? ` @ ${round1(p.fps)}fps, ${formatDuration(p.duration)}` : ""}${
        p.hasAudio ? ", has audio" : ", no audio"
      }`
    )
  }
  if (record.status !== "ready") lines.push(`Progress: ${stageLine(record)}`)
  if (!analysis) return lines.join("\n")

  if (analysis.shots.length > 0 && p?.kind === "video") {
    lines.push("", `Shots (${analysis.shots.length}):`)
    for (const shot of analysis.shots) lines.push(shotLine(shot, full))
  } else if (p?.kind === "image" && analysis.shots[0]?.caption) {
    lines.push("", `Looks like: ${shotLine(analysis.shots[0]).replace(/^.*— /, "")}`)
  }

  const a = analysis.audio
  if (a) {
    const effect = p?.kind === "audio" && isSoundEffect(a, p.duration)
    const parts = [`Audio: ${effect ? "sound effect" : a.kind}`, `mean ${round1(a.meanDb)} dB, peak ${round1(a.peakDb)} dB`]
    if (a.tempo && !effect) {
      parts.push(
        `${round1(a.tempo)} BPM (confidence ${a.tempoConfidence.toFixed(2)}), ${a.beats.length} beats, first downbeat ${
          formatTime(a.downbeats[0] ?? a.beats[0] ?? 0)
        }`
      )
    }
    if (a.silences.length > 0) parts.push(`${a.silences.length} quiet stretches`)
    if (a.accents.length > 0) parts.push(`${a.accents.length} accents (hits)`)
    lines.push("", parts.join(" · "))
    if (a.sections && a.sections.length > 0) {
      const label = (e: number) => e < 0.25 ? "calm" : e < 0.5 ? "soft" : e < 0.75 ? "lively" : "intense"
      lines.push("Parts by energy (0 to 10, relative to this track; pick in/out from these to match the edit):")
      for (const x of a.sections) {
        lines.push(
          `  ${formatRange(x.start, x.end)}  ${label(x.energy)} ${Math.round(x.energy * 10)}/10${x.trend === "steady" ? "" : `, ${x.trend}`}, peak ${formatTime(x.peak)}`
        )
      }
      if (a.rises && a.rises.length > 0) {
        lines.push(`Rises (energy jumps up; land a reveal or cut into a build here): ${a.rises.map(formatTime).join(", ")}`)
      }
    }
    if (a.hits && a.hits.length > 0 && (effect || full)) {
      const shown = full ? a.hits : a.hits.slice(0, 12)
      lines.push(
        a.repeatEvery !== undefined
          ? `One sound repeated every ${a.repeatEvery.toFixed(3)}s. Each repeat (use one with add_audio in = its start, out = its end):`
          : `Separate sounds (silence around each; to use one sound, add_audio with in = its start and out = its end):`,
        ...shown.map((h, i) =>
          `  ${i + 1}. ${h.start.toFixed(3)}–${h.end.toFixed(3)}s (${Math.round((h.end - h.start) * 1000)}ms), loudest at ${h.peak.toFixed(3)}, ${
            round1(h.db)
          } dB${h.strikes ? `, ${h.strikes.length} strikes at ${h.strikes.map((x) => x.toFixed(3)).join(" ")}` : ""}`
        )
      )
      if (shown.some((h) => h.strikes)) {
        lines.push(
          "  Strikes are the sharp hits inside a sound; one shutter click has two (open and close). Use a whole sound for one click or hit. Cut between strikes only inside a long burst."
        )
      }
      if (shown.length < a.hits.length) lines.push(`  ...${a.hits.length - shown.length} more (detail full lists all)`)
    }
    if (full && !effect) {
      if (a.downbeats.length > 0) lines.push(`Downbeats (s): ${a.downbeats.map((b) => b.toFixed(2)).join(" ")}`)
      if (a.beats.length > 0) lines.push(`Beats (s): ${a.beats.map((b) => b.toFixed(2)).join(" ")}`)
      if (a.accents.length > 0) lines.push(`Accents (s): ${[...a.accents].sort((x, y) => x - y).map((b) => b.toFixed(2)).join(" ")}`)
      if (a.silences.length > 0) {
        lines.push(`Quiet: ${a.silences.map(([s, e]) => formatRange(s, e)).join(", ")}`)
      }
    }
  }

  const t = analysis.transcript
  if (t && t.segments.length > 0) {
    const words = t.segments.reduce((n, s) => n + s.words.length, 0)
    const text = t.segments.map((s) => s.text.trim()).join(" ")
    lines.push(
      "",
      `Speech: ${words} words${t.language ? `, ${t.language}` : ""}. ${
        full ? "" : "Use media_transcript for timings. "
      }Text: ${q(text, full ? 4000 : 400)}`
    )
  }
  return lines.join("\n")
}

export const transcriptText = (
  record: MediaRecord,
  analysis: Analysis | undefined,
  range: { readonly start: number; readonly end: number },
  words: boolean
): string => {
  const t = analysis?.transcript
  if (!t || t.segments.length === 0) {
    const transcript = record.stages.transcript
    return `${record.id} has no transcript${transcript?.note ? ` (${transcript.note})` : ""}.`
  }
  const segments = t.segments.filter((s) => s.end > range.start && s.start < range.end)
  const lines = [`${record.id} ${q(record.name)} transcript${t.language ? ` (${t.language})` : ""}, ${segments.length} segments:`]
  for (const s of segments) {
    if (words && s.words.length > 0) {
      lines.push(`[${formatRange(s.start, s.end)}] ${s.words.map((w) => `${w.w.trim()}@${w.s.toFixed(2)}-${w.e.toFixed(2)}`).join(" ")}`)
    } else {
      lines.push(`[${formatRange(s.start, s.end)}] ${s.text.trim()}`)
    }
  }
  return lines.join("\n")
}

export const searchText = (query: string, hits: ReadonlyArray<SearchHit>, names: (id: string) => string): string => {
  if (hits.length === 0) {
    return `No results for ${q(query, 80)}. Try other words, fewer filters, or media_list to check that media is analyzed.`
  }
  const lines = [`${hits.length} result${hits.length === 1 ? "" : "s"} for ${q(query, 80)}:`]
  for (const h of hits) {
    const image = h.kind === "shot" && h.end === 0
    const where = image
      ? "image"
      : h.kind === "shot"
      ? `shot ${h.shot}${h.moment ? ` moment ${h.moment}` : ""}  ${formatRange(h.start, h.end)}`
      : `speech  ${formatRange(h.start, h.end)}`
    const extras = h.kind === "shot" && !image ? ` · ${h.motion === "static" ? "static" : `${h.motion} motion`}` : ""
    const appeal = h.appeal ? ` · appeal ${h.appeal}` : ""
    lines.push(
      `  ${h.mediaId} ${q(names(h.mediaId), 24)} ${where}  score ${h.score}${extras}${appeal} — ${
        h.kind === "speech" ? q(h.text, 160) : h.text.split(". ")[0]
      }`
    )
  }
  return lines.join("\n")
}

const mb = (bytes: number) => `${round1(bytes / 1024 / 1024)} MB`

export const renderLine = (job: RenderJob, url?: string): string => {
  const range = job.start !== undefined ? ` ${formatRange(job.start, job.end ?? 0)}` : ""
  const head = `${job.id} · ${job.quality}${range} of ${job.projectId} v${job.projectVersion} · ${job.status}`
  switch (job.status) {
    case "queued":
      return `${head}`
    case "running":
      return `${head} ${Math.round(job.progress * 100)}%`
    case "failed":
      return `${head}: ${job.error ?? "unknown error"}`
    case "done":
      return `${head} · ${formatDuration(job.duration ?? 0)}, ${job.width}x${job.height}, ${mb(job.bytes ?? 0)}, took ${
        round1(job.took ?? 0)
      }s${url ? `\nLink (valid 7 days): ${url}` : ""}`
  }
}
