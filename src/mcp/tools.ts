import { Effect, FileSystem, Option, Schema } from "effect"
import { OwlConfig } from "../Config.ts"
import { OwlError } from "../domain/Errors.ts"
import { newId, randomCode } from "../domain/Ids.ts"
import type { Analysis } from "../domain/Media.ts"
import { formatDuration, formatRange, formatTime, parseTime, round3, TimeInput } from "../domain/Time.ts"
import { STOCK_IDS, stockSound, stockUrl } from "../domain/Stock.ts"
import { mainDuration, type Project, timelineDuration } from "../domain/Timeline.ts"
import { extractFrames } from "../analysis/frames.ts"
import { ClipInput, EditOp } from "../timeline/Ops.ts"
import { autoBeatsPerCut, fillerRanges, pauseRanges, planMontage, removePausesOps } from "../timeline/smart.ts"
import { Analyzer, FRAME_SIZE, frameKey, proxyKey } from "../services/Analyzer.ts"
import { Ffmpeg } from "../services/Ffmpeg.ts"
import { Links } from "../services/Links.ts"
import { MediaLibrary } from "../services/MediaLibrary.ts"
import { Projects } from "../services/Projects.ts"
import { Renderer } from "../services/Renderer.ts"
import { Search } from "../services/Search.ts"
import { Storage } from "../services/Storage.ts"
import { describeMedia, mediaLine, renderLine, searchText, transcriptText } from "./format.ts"
import { GUIDE, GUIDE_TOPICS } from "./guide.ts"
import { registerTool } from "./tool.ts"

const d = <S extends Schema.Top>(schema: S, description: string) => schema.annotate({ description }) as S
const opt = Schema.optionalKey

const ProjectId = d(Schema.String, "Project id, e.g. p_4hz9tc.")
const MediaId = d(Schema.String, "Media id, e.g. m_7kq2xd.")
const WaitSeconds = d(
  Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 50 })),
  "Wait up to this many seconds for the work to finish before answering. Default 0."
)

export const INSTRUCTIONS = `owl edits videos. You drive it with these tools; it does the heavy work (analysis, rendering) in the cloud.

Workflow:
1. Get media in. media_upload_link gives a page where the user uploads files from their phone or computer. media_import takes a public URL (direct link, Google Drive or Dropbox share link), or a stock sound effect by name (edit_guide "sounds").
2. Each file is analyzed in the background: shots with visual descriptions, moments inside still shots and screen recordings (one per screen or step), speech transcript with word timings, music tempo and beats, quiet parts. media_get with wait_seconds waits for it.
3. Before building, read edit_guide: "principles" and the recipe for the format (cinematic, screen_recording, product_ad, talking_head, montage, rhythm). Decide the concept (idea, motif, arc, one surprise) before building, then pick looks, transitions, fonts and sounds from "playbook". With music, also read "music": a long track must be scored to the edit, not played from 0. The user expects a premium, creative result, not a plain cut.
4. Find material with media_search and media_get. Look at frames with preview_frames before choosing shots when looks matter.
5. project_create, then build the edit with timeline_edit. Send many operations in one call. The main track is magnetic: clips play back to back and gaps close. Overlays, audio, text and blurs sit on top at timeline times and follow their content when the main track changes. Clips can zoom and pan (zoom keyframes) and float as a card over a color or gradient background (fit card).
6. Smart edits: edit_remove_pauses and edit_remove_fillers for talking footage, edit_beat_montage to cut clips on the beat of a song.
7. Check the result: timeline_get, preview_frames with a project at each text change and zoom, render_start quality "draft" for a fast watchable link. Fix what looks off before the final.
8. render_start quality "final" and give the user the link.

Times are seconds (12.5) or timecodes ("0:12.5"). in/out are times inside a source file. start/end/at are times on the edited timeline. Every edit is undoable with timeline_undo.`

const loadAnalysis = (library: typeof MediaLibrary.Service, id: string) =>
  library.analysis(id).pipe(Effect.map(Option.getOrUndefined), Effect.orElseSucceed((): Analysis | undefined => undefined))

const timeOrFail = (input: TimeInput, field: string) => {
  const t = parseTime(input)
  return t === undefined
    ? Effect.fail(OwlError.invalid(`${field} "${input}" is not a time. Use seconds or "m:ss.s".`))
    : Effect.succeed(t)
}

const guessName = (url: string) => {
  try {
    const u = new URL(url)
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "")
    return /\.[a-z0-9]{2,5}$/i.test(last) ? last : `${u.hostname} import`
  } catch {
    return "import"
  }
}

export const registerTools = Effect.gen(function*() {
  const config = yield* OwlConfig
  const library = yield* MediaLibrary
  const analyzer = yield* Analyzer
  const projects = yield* Projects
  const renderer = yield* Renderer
  const search = yield* Search
  const links = yield* Links
  const storage = yield* Storage
  const ffmpeg = yield* Ffmpeg
  const fs = yield* FileSystem.FileSystem

  const timelineSummary = (project: Project, outcome: { changes: ReadonlyArray<string>; notes: ReadonlyArray<string> }) =>
    Effect.gen(function*() {
      const lines = [...outcome.changes]
      if (outcome.notes.length > 0) lines.push("", "Notes:", ...outcome.notes.map((n) => `- ${n}`))
      lines.push("")
      if (project.timeline.main.length + project.timeline.overlays.length + project.timeline.texts.length <= 40) {
        lines.push(yield* projects.describe(project, false))
      } else {
        lines.push(
          `${project.id} is now version ${project.version}, ${project.timeline.main.length} main clips, length ${
            formatDuration(timelineDuration(project.timeline))
          }. Use timeline_get to see it.`
        )
      }
      return lines.join("\n")
    })

  // ------------------------------------------------------------------ guide

  yield* registerTool({
    name: "edit_guide",
    title: "Editing guide",
    description:
      "How to make an edit look premium: pacing, motion, typography, color, and step-by-step recipes with example operations. Read principles plus the recipe for the format before building an edit.",
    params: Schema.Struct({
      topic: d(
        Schema.Literals(GUIDE_TOPICS),
        "principles (always), cinematic (dark premium launch film, like Apple or Luma), screen_recording (app or website demos), product_ad (B-roll ads), talking_head, montage (music-driven), rhythm (cuts that speed up, frame skips, a sound effect on each cut), music (scoring a track to the edit: pick calm and intense parts, land the peak on the reveal), text (typography), playbook (looks, transitions, fonts and sounds paired by mood), sounds (stock sound effects to import by name, and how to time them)."
      )
    }),
    readOnly: true,
    handle: ({ topic }) => Effect.succeed(GUIDE[topic])
  })

  // ---------------------------------------------------------------- projects

  yield* registerTool({
    name: "project_create",
    title: "Create project",
    description: "Create an empty edit project. Returns its id. Optionally set the frame shape now; otherwise the first clip decides it.",
    params: Schema.Struct({
      name: d(Schema.String.check(Schema.isMinLength(1)), "Short name, e.g. \"Spring sale reel\"."),
      aspect: opt(d(Schema.Literals(["16:9", "9:16", "1:1", "4:5"]), "Frame shape. 9:16 for Reels, TikTok and Shorts."))
    }),
    handle: ({ name, aspect }) =>
      Effect.gen(function*() {
        let project = yield* projects.create(name)
        if (aspect) project = (yield* projects.edit(project.id, [{ op: "set_output", aspect }])).project
        return `Created ${project.id} ${JSON.stringify(name)}${aspect ? ` at ${aspect}` : ""}. Add clips with timeline_edit.` +
          " If you have not yet, read edit_guide \"principles\" and the recipe for this format first: the user expects a premium result."
      })
  })

  yield* registerTool({
    name: "project_delete",
    title: "Delete project",
    description: "Delete an edit project and its undo history. Media and finished render links are kept.",
    params: Schema.Struct({ project: ProjectId }),
    destructive: true,
    handle: ({ project }) =>
      projects.remove(project).pipe(Effect.map((p) => `Deleted ${p.id} ${JSON.stringify(p.name)}.`))
  })

  yield* registerTool({
    name: "project_list",
    title: "List projects",
    description: "List edit projects, most recently changed first.",
    params: Schema.Struct({}),
    readOnly: true,
    handle: () =>
      projects.list.pipe(Effect.map((list) =>
        list.length === 0
          ? "No projects yet. Create one with project_create."
          : list.map((p) =>
            `${p.id} ${JSON.stringify(p.name)} · version ${p.version} · ${p.clips} clips · ${formatDuration(p.duration)} · changed ${p.updatedAt.slice(0, 16).replace("T", " ")}`
          ).join("\n")
      ))
  })

  // ------------------------------------------------------------------- media

  yield* registerTool({
    name: "media_upload_link",
    title: "Get upload link",
    description:
      "Get a link to a web page where the user can upload video, audio and image files from their phone or computer (large files are fine). Give the link to the user. Uploaded files appear in media_list and are analyzed automatically.",
    params: Schema.Struct({}),
    readOnly: true,
    handle: () =>
      links.uploadUrl.pipe(Effect.map((url) =>
        `Upload page (valid 24 hours): ${url}\nAfter the user uploads, call media_list to see the new media ids.`
      ))
  })

  yield* registerTool({
    name: "media_import",
    title: "Import media from URL",
    description:
      "Import a video, audio or image file from a public URL: a direct file link, a Google Drive share link (file shared with \"anyone with the link\") or a Dropbox share link. Or bring in a stock sound effect by name (edit_guide \"sounds\" lists them). Returns a media id right away; download and analysis continue in the background.",
    params: Schema.Struct({
      url: opt(d(Schema.String.check(Schema.isPattern(/^https?:\/\//)), "Public http(s) URL.")),
      stock: opt(d(Schema.Literals(STOCK_IDS), "A stock sound effect by name, instead of url. Imported once; later calls return the same media id.")),
      name: opt(d(Schema.String, "Display name. Default: the file name from the URL."))
    }),
    openWorld: true,
    handle: ({ url, stock, name }) =>
      Effect.gen(function*() {
        if ((url === undefined) === (stock === undefined)) return yield* OwlError.invalid("Give either url or stock.")
        const sound = stock === undefined ? undefined : stockSound(stock)
        const source = sound ? stockUrl(sound) : url!
        if (sound) {
          const existing = (yield* library.list).find((r) => r.origin.url === source && r.status !== "failed")
          if (existing) {
            return `Stock sound "${sound.id}" is already in the library as ${existing.id} (${existing.status}). Use media "${existing.id}".`
          }
        }
        const displayName = name ?? (sound ? `${sound.id}.wav` : guessName(source))
        const ext = /\.([a-z0-9]{2,5})$/i.exec(displayName)?.[1]?.toLowerCase() ?? "bin"
        const id = newId("m")
        yield* library.create({ id, name: displayName, sourceKey: `media/${id}/source.${ext}`, origin: { type: "url", url: source } })
        yield* analyzer.start(id)
        return `Importing ${id} ${JSON.stringify(displayName)}. Call media_get with media "${id}" and wait_seconds to follow it.`
      })
  })

  yield* registerTool({
    name: "media_list",
    title: "List media",
    description: "List all media with status and a one-line summary (length, shots, music tempo, speech).",
    params: Schema.Struct({}),
    readOnly: true,
    handle: () =>
      library.list.pipe(Effect.map((list) =>
        list.length === 0
          ? "No media yet. Use media_upload_link or media_import."
          : [...list].reverse().filter((r) => !r.duplicateOf).map(mediaLine).join("\n")
      ))
  })

  yield* registerTool({
    name: "media_get",
    title: "Get media details",
    description:
      "Everything known about one media item: format, analysis progress, every shot with time range and visual description, audio (music tempo, beats, quiet parts) and a speech excerpt. detail \"full\" adds beat and accent times and the whole transcript text.",
    params: Schema.Struct({
      media: MediaId,
      wait_seconds: opt(d(WaitSeconds, "Wait up to this many seconds for analysis to finish. Default 0.")),
      detail: opt(d(Schema.Literals(["normal", "full"]), "Default normal."))
    }),
    readOnly: true,
    handle: ({ media, wait_seconds, detail }) =>
      Effect.gen(function*() {
        const record = wait_seconds
          ? yield* library.waitFor(media, (r) => r.status === "ready" || r.status === "failed", `${wait_seconds} seconds`)
          : yield* library.get(media)
        const analysis = yield* loadAnalysis(library, media)
        return describeMedia(record, analysis, detail === "full")
      })
  })

  yield* registerTool({
    name: "media_transcript",
    title: "Get transcript",
    description:
      "Speech transcript of a media item with timecodes. words: true gives every word with start-end seconds, for cutting on exact words.",
    params: Schema.Struct({
      media: MediaId,
      start: opt(d(TimeInput, "Only this part of the source. Default 0.")),
      end: opt(TimeInput),
      words: opt(d(Schema.Boolean, "Include word timings. Default false."))
    }),
    readOnly: true,
    handle: ({ media, start, end, words }) =>
      Effect.gen(function*() {
        const record = yield* library.get(media)
        const s = start === undefined ? 0 : yield* timeOrFail(start, "start")
        const e = end === undefined ? Number.MAX_SAFE_INTEGER : yield* timeOrFail(end, "end")
        return transcriptText(record, yield* loadAnalysis(library, media), { start: s, end: e }, words === true)
      })
  })

  yield* registerTool({
    name: "media_search",
    title: "Search footage",
    description:
      "Find shots and spoken moments across all media by meaning, e.g. \"close-up of the product on a table\", \"someone laughing\", \"when she mentions the price\". Returns media id, shot number and time range for each hit, ready to use in timeline_edit.",
    params: Schema.Struct({
      query: d(Schema.String.check(Schema.isMinLength(1)), "What to look for, in plain words."),
      media: opt(d(Schema.Array(Schema.String), "Only search these media ids.")),
      kind: opt(d(Schema.Literals(["any", "shot", "speech"]), "shot: visuals only. speech: spoken words only. Default any.")),
      min_appeal: opt(d(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })), "Only shots rated at least this (1-5).")),
      motion: opt(d(Schema.Array(Schema.Literals(["static", "low", "medium", "high"])), "Only shots with this much motion.")),
      limit: opt(d(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })), "Default 12."))
    }),
    readOnly: true,
    handle: (input) =>
      Effect.gen(function*() {
        const hits = yield* search.search({
          query: input.query,
          mediaIds: input.media,
          kind: input.kind,
          minAppeal: input.min_appeal,
          motion: input.motion,
          limit: input.limit ?? 12
        })
        const names = new Map((yield* library.list).map((r) => [r.id, r.name]))
        return searchText(input.query, hits, (id) => names.get(id) ?? id)
      })
  })

  yield* registerTool({
    name: "media_delete",
    title: "Delete media",
    description: "Delete a media item and its analysis. Projects that use it will fail to render until the clips are removed.",
    params: Schema.Struct({ media: MediaId }),
    destructive: true,
    handle: ({ media }) => library.remove(media).pipe(Effect.as(`Deleted ${media}.`))
  })

  // ------------------------------------------------------------------ seeing

  const MAX_FRAMES = 12

  const mediaFrames = (media: string, times: ReadonlyArray<number> | undefined, shots: ReadonlyArray<number> | undefined) =>
    Effect.gen(function*() {
      const record = yield* library.get(media)
      const probe = record.probe
      if (!probe) return yield* OwlError.notReady(`${media} is still importing. Call media_get with wait_seconds.`)
      if (probe.kind === "audio") return yield* OwlError.invalid(`${media} is audio only and has no frames.`)
      const analysis = yield* loadAnalysis(library, media)
      const allShots = analysis?.shots ?? []
      let picks: Array<{ time: number; caption: string }>
      if (times && times.length > 0) {
        picks = times.map((t) => ({ time: Math.min(Math.max(0, t), Math.max(0, probe.duration - 0.05)), caption: "" }))
      } else {
        let chosen = shots && shots.length > 0
          ? allShots.filter((s) => shots.includes(s.index))
          : allShots
        if (chosen.length === 0 && allShots.length === 0) {
          chosen = []
          picks = probe.kind === "image" ? [{ time: 0, caption: "" }] : [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => ({ time: f * probe.duration, caption: "" }))
        } else {
          if (chosen.length > MAX_FRAMES) {
            const step = chosen.length / MAX_FRAMES
            chosen = Array.from({ length: MAX_FRAMES }, (_, i) => chosen[Math.floor(i * step)]!)
          }
          // A shot split into moments (a screen recording) shows one frame per moment.
          picks = chosen.flatMap((s) =>
            s.moments && s.moments.length > 0
              ? s.moments.map((m, i) => ({
                time: m.keyframe,
                caption: `shot ${s.index} moment ${i + 1} (${formatRange(m.start, m.end)})`
              }))
              : [{
                time: s.keyframes[Math.floor(s.keyframes.length / 2)] ?? (s.start + s.end) / 2,
                caption: `shot ${s.index} (${formatRange(s.start, s.end)})`
              }]
          )
        }
      }
      picks = picks.slice(0, MAX_FRAMES)
      const images = yield* Effect.forEach(picks, (pick) =>
        Effect.gen(function*() {
          const key = frameKey(media, pick.time)
          if (yield* storage.exists(key)) return yield* fs.readFile(yield* storage.localPath(key))
          return undefined
        }), { concurrency: 6 })
      const missing = picks.map((p, i) => ({ ...p, i })).filter((p) => images[p.i] === undefined)
      if (missing.length > 0) {
        const input = probe.kind === "video" && record.stages.proxy?.status === "done"
          ? yield* storage.localPath(proxyKey(media))
          : yield* storage.localPath(record.sourceKey)
        const dir = `${config.cacheDir}/tmp/${randomCode(10)}`
        yield* Effect.acquireUseRelease(
          fs.makeDirectory(dir, { recursive: true }),
          () =>
            Effect.gen(function*() {
              yield* extractFrames(ffmpeg, input, missing.map((m) => ({ time: m.time, output: `${dir}/${m.i}.jpg` })), {
                maxSide: FRAME_SIZE,
                concurrency: 2
              })
              for (const m of missing) images[m.i] = yield* fs.readFile(`${dir}/${m.i}.jpg`)
            }),
          () => fs.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore)
        )
      }
      return {
        text: `${picks.length} frame${picks.length === 1 ? "" : "s"} of ${media} ${JSON.stringify(record.name)}:`,
        images: picks.map((p, i) => ({
          caption: `${formatTime(p.time)}${p.caption ? ` · ${p.caption}` : ""}`,
          data: images[i]!,
          mimeType: "image/jpeg"
        }))
      }
    })

  yield* registerTool({
    name: "preview_frames",
    title: "Look at frames",
    description:
      "See still frames. With media: frames of a source file (default one per shot and one per moment of a screen recording, or at the given source times). With project: frames of the edited video exactly as it will render, with overlays, text and captions (default 6 evenly spaced, or at the given timeline times). Use it to check looks, framing and text placement.",
    params: Schema.Struct({
      media: opt(MediaId),
      project: opt(ProjectId),
      times: opt(d(Schema.Array(TimeInput), `Times to show, at most ${MAX_FRAMES}.`)),
      shots: opt(d(Schema.Array(Schema.Int), "With media: only these shot numbers."))
    }),
    readOnly: true,
    handle: (input) =>
      Effect.gen(function*() {
        if ((input.media === undefined) === (input.project === undefined)) {
          return yield* OwlError.invalid("Give exactly one of media or project.")
        }
        const times = input.times ? yield* Effect.forEach(input.times, (t) => timeOrFail(t, "times")) : undefined
        if (input.media) return yield* mediaFrames(input.media, times, input.shots)
        const project = yield* projects.get(input.project!)
        const total = timelineDuration(project.timeline)
        if (total <= 0) return yield* OwlError.invalid("The timeline is empty.")
        const at = (times ?? [0.04, 0.2, 0.4, 0.6, 0.8, 0.96].map((f) => round3(f * total))).slice(0, MAX_FRAMES)
        const frames = yield* renderer.stills(project, at, 768)
        return {
          text: `${at.length} frame${at.length === 1 ? "" : "s"} of ${project.id} version ${project.version} (${formatDuration(total)} long):`,
          images: at.map((t, i) => ({ caption: formatTime(t), data: frames[i]!, mimeType: "image/jpeg" }))
        }
      })
  })

  // ---------------------------------------------------------------- timeline

  yield* registerTool({
    name: "timeline_get",
    title: "Show timeline",
    description:
      "The current edit as text: every main clip, overlay, audio item and text with ids and times. detailed: true adds what each clip shows and says.",
    params: Schema.Struct({ project: ProjectId, detailed: opt(Schema.Boolean) }),
    readOnly: true,
    handle: ({ project, detailed }) =>
      projects.get(project).pipe(Effect.flatMap((p) => projects.describe(p, detailed === true)))
  })

  yield* registerTool({
    name: "timeline_edit",
    title: "Edit timeline",
    description:
      `Change the edit with a list of operations, applied in order as one undoable step. If any operation fails, nothing changes and the error says which one and why. Read edit_guide (principles and a recipe) before the first edit.

Operations (field "op"): add_clips, set_main, trim_clip, split_clip, move_clip, delete_range (main track; later content ripples), add_overlay (B-roll, picture-in-picture, logo), add_audio (music ducks under speech by default), add_text, set_captions (burned in from speech), set_output (16:9, 9:16, 1:1, 4:5), update and delete (any item by id).

A clip takes "media" plus either "shot" (use a whole shot) or "in"/"out" (source times). Example:
{"ops":[{"op":"set_main","clips":[{"media":"m_7kq2xd","shot":3},{"media":"m_9bc4tz","in":12.5,"out":16,"transition":{"type":"crossfade"}}]},{"op":"add_text","text":"Spring Sale","start":0.3,"duration":2.5,"style":"title"},{"op":"add_audio","media":"m_2xk7pd","volume":0.3,"fill":true}]}`,
    params: Schema.Struct({
      project: ProjectId,
      ops: d(Schema.Array(EditOp).check(Schema.isMinLength(1)), "Operations to apply in order."),
      expected_version: opt(d(Schema.Int, "Fail instead of editing if the project changed since this version."))
    }),
    handle: ({ project, ops, expected_version }) =>
      Effect.gen(function*() {
        const outcome = yield* projects.edit(project, ops, expected_version)
        return yield* timelineSummary(outcome.project, outcome)
      })
  })

  yield* registerTool({
    name: "timeline_undo",
    title: "Undo or redo",
    description: "Undo the last edit steps (each timeline_edit or smart edit is one step), or redo them.",
    params: Schema.Struct({
      project: ProjectId,
      steps: opt(d(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })), "Default 1.")),
      redo: opt(d(Schema.Boolean, "Redo instead of undo."))
    }),
    handle: ({ project, steps, redo }) =>
      Effect.gen(function*() {
        const outcome = redo ? yield* projects.redo(project, steps ?? 1) : yield* projects.undo(project, steps ?? 1)
        return yield* timelineSummary(outcome.project, outcome)
      })
  })

  // ------------------------------------------------------------- smart edits

  const analysesFor = (project: Project) =>
    Effect.gen(function*() {
      const map = new Map<string, Analysis>()
      for (const c of project.timeline.main) {
        if (map.has(c.mediaId)) continue
        const a = yield* loadAnalysis(library, c.mediaId)
        if (a) map.set(c.mediaId, a)
      }
      return map
    })

  yield* registerTool({
    name: "edit_remove_pauses",
    title: "Remove pauses",
    description:
      "Cut pauses out of talking footage on the main track (jump cuts). Uses gaps between transcribed words, or quiet audio when there is no transcript. One undoable step.",
    params: Schema.Struct({
      project: ProjectId,
      min_pause: opt(d(Schema.Finite.check(Schema.isBetween({ minimum: 0.2, maximum: 10 })), "Only cut pauses at least this long, in seconds. Default 0.6.")),
      padding: opt(d(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })), "Silence kept next to speech, in seconds. Default 0.15.")),
      clips: opt(d(Schema.Array(Schema.String), "Only these main clip ids. Default all.")),
      dry_run: opt(d(Schema.Boolean, "Only report what would be cut."))
    }),
    handle: (input) =>
      Effect.gen(function*() {
        const project = yield* projects.get(input.project)
        const analyses = yield* analysesFor(project)
        const ranges = pauseRanges(project.timeline, (id) => analyses.get(id), {
          minPause: input.min_pause ?? 0.6,
          padding: input.padding ?? 0.15,
          clipIds: input.clips
        })
        const total = ranges.reduce((s, r) => s + r.end - r.start, 0)
        if (ranges.length === 0) return "No pauses long enough to cut."
        const summary = `${ranges.length} pause${ranges.length === 1 ? "" : "s"}, ${formatDuration(total)} in total (${formatDuration(mainDuration(project.timeline.main))} → ${
          formatDuration(mainDuration(project.timeline.main) - total)
        })`
        if (input.dry_run) {
          return `Would cut ${summary}:\n${ranges.slice(0, 60).map((r) => formatRange(r.start, r.end)).join(", ")}`
        }
        const outcome = yield* projects.edit(input.project, removePausesOps(ranges))
        return yield* timelineSummary(outcome.project, { changes: [`Cut ${summary}.`], notes: outcome.notes })
      })
  })

  yield* registerTool({
    name: "edit_remove_fillers",
    title: "Remove filler words",
    description:
      "Cut filler words (um, uh, er, hmm...) from the main track using word timings. Add your own words with extra_words. The transcriber sometimes leaves fillers out, so check with media_transcript if results look thin.",
    params: Schema.Struct({
      project: ProjectId,
      extra_words: opt(d(Schema.Array(Schema.String), "More single words to cut, e.g. [\"like\", \"basically\"].")),
      clips: opt(d(Schema.Array(Schema.String), "Only these main clip ids.")),
      dry_run: opt(Schema.Boolean)
    }),
    handle: (input) =>
      Effect.gen(function*() {
        const project = yield* projects.get(input.project)
        const analyses = yield* analysesFor(project)
        const found = fillerRanges(project.timeline, (id) => analyses.get(id), input.extra_words ?? [], input.clips)
        if (found.ranges.length === 0) return "No filler words found in the transcripts of the main clips."
        const counts = new Map<string, number>()
        for (const w of found.words) counts.set(w, (counts.get(w) ?? 0) + 1)
        const summary = `${found.ranges.length} filler word${found.ranges.length === 1 ? "" : "s"} (${[...counts].map(([w, c]) => `${w} ×${c}`).join(", ")})`
        if (input.dry_run) return `Would cut ${summary} at ${found.ranges.map((r) => formatTime(r.start)).join(", ")}.`
        const outcome = yield* projects.edit(input.project, removePausesOps(found.ranges))
        return yield* timelineSummary(outcome.project, { changes: [`Cut ${summary}.`], notes: outcome.notes })
      })
  })

  yield* registerTool({
    name: "edit_beat_montage",
    title: "Cut montage to the beat",
    description:
      "Build the main track from candidate clips cut exactly on the beats of a music track, and add the music. Give candidates in the order they should appear (find them with media_search). Each clip uses the middle of its range, for a whole number of beats. Replaces the main track; one undoable step.",
    params: Schema.Struct({
      project: ProjectId,
      music: d(MediaId, "Media with the music. It must be analyzed (has beats)."),
      clips: d(Schema.Array(ClipInput.mapFields((f) => ({ media: f.media, shot: f.shot, in: f.in, out: f.out }))).check(Schema.isMinLength(1)), "Candidate clips in order: media plus shot, or in/out."),
      beats_per_cut: opt(d(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 })), "Beats per clip. Default: picked from the tempo for cuts about every 1.2s.")),
      music_start: opt(d(TimeInput, "Where in the song to start. Default: first downbeat.")),
      max_length: opt(d(Schema.Finite, "Stop adding clips at this length in seconds.")),
      volume: opt(d(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 2 })), "Music volume. Default 1.")),
      transition: opt(d(Schema.Literals(["none", "crossfade", "dissolve", "fade_black"]), "Between clips. Default none (hard cuts on the beat)."))
    }),
    handle: (input) =>
      Effect.gen(function*() {
        const project = yield* projects.get(input.project)
        const music = yield* library.get(input.music)
        const musicAnalysis = yield* loadAnalysis(library, input.music)
        const beats = musicAnalysis?.audio?.beats ?? []
        if (!musicAnalysis?.audio?.tempo || beats.length < 4) {
          return yield* OwlError.invalid(
            `${input.music} has no beat grid${music.status !== "ready" ? " yet (still analyzing)" : " (no steady beat found)"}. Pick music with a clear beat, or build the cut with timeline_edit.`
          )
        }
        const candidates = yield* Effect.forEach(input.clips, (c) =>
          Effect.gen(function*() {
            const record = yield* library.get(c.media)
            if (!record.probe) return yield* OwlError.notReady(`${c.media} is still importing.`)
            const shots = (yield* loadAnalysis(library, c.media))?.shots ?? []
            let start = 0
            let end = record.probe.kind === "image" ? 3 : record.probe.duration
            if (c.shot !== undefined) {
              const shot = shots.find((s) => s.index === c.shot)
              if (!shot) return yield* OwlError.invalid(`${c.media} has no shot ${c.shot}.`)
              start = shot.start
              end = shot.end
            }
            if (c.in !== undefined) start = yield* timeOrFail(c.in, "in")
            if (c.out !== undefined) end = yield* timeOrFail(c.out, "out")
            return { media: c.media, in: start, out: end }
          }))
        const musicStart = input.music_start !== undefined
          ? yield* timeOrFail(input.music_start, "music_start")
          : musicAnalysis.audio.downbeats[0] ?? beats[0]!
        const beatsPerCut = input.beats_per_cut ?? autoBeatsPerCut(musicAnalysis.audio.tempo)
        const plan = planMontage(candidates, beats, { beatsPerCut, musicStart, maxLength: input.max_length })
        if (plan.clips.length === 0) return yield* OwlError.invalid(`No clips fit. ${plan.skipped.join("; ")}`)
        const transition = input.transition && input.transition !== "none"
          ? { type: input.transition, duration: Math.min(0.3, 60 / musicAnalysis.audio.tempo / 2) }
          : undefined
        const ops: Array<EditOp> = [
          {
            op: "set_main",
            clips: plan.clips.map((c, i) => (i > 0 && transition ? { ...c, transition } : c))
          },
          ...project.timeline.audio.filter((a) => a.mediaId === input.music).map((a): EditOp => ({ op: "delete", ids: [a.id] })),
          {
            op: "add_audio",
            media: input.music,
            in: plan.musicIn,
            volume: input.volume ?? 1,
            duck: false,
            fade_out: 0.5
          }
        ]
        const outcome = yield* projects.edit(input.project, ops)
        const notes = [...outcome.notes]
        if (plan.skipped.length > 0) notes.push(`Skipped: ${plan.skipped.join("; ")}.`)
        if (transition) notes.push("Transitions overlap clips, so cuts land slightly before the beat.")
        return yield* timelineSummary(outcome.project, {
          changes: [
            `Built a ${plan.clips.length}-clip montage, ${plan.beatsPerCut} beats per cut at ${Math.round(musicAnalysis.audio.tempo)} BPM, ${
              formatDuration(plan.length)
            } long, music from ${formatTime(plan.musicIn)}.`
          ],
          notes
        })
      })
  })

  // ------------------------------------------------------------------ render

  const renderReport = (id: string) =>
    Effect.gen(function*() {
      const job = yield* renderer.get(id)
      const url = job.status === "done" && job.key ? yield* links.fileUrl(job.key) : undefined
      return renderLine(job, url) +
        (job.status === "queued" || job.status === "running" ? `\nCall render_status with render "${job.id}" and wait_seconds to follow it.` : "")
    })

  yield* registerTool({
    name: "render_start",
    title: "Render video",
    description:
      "Render the project to an MP4 and get a download link. quality \"draft\" is fast and small (960px, from proxies): use it to check the edit. quality \"final\" is full quality with loudness normalization: use it for the deliverable. start/end render only part of the timeline. Renders of an unchanged project are reused.",
    params: Schema.Struct({
      project: ProjectId,
      quality: Schema.Literals(["draft", "final"]),
      start: opt(TimeInput),
      end: opt(TimeInput),
      wait_seconds: opt(d(WaitSeconds, "Wait up to this many seconds for the render. Default 30."))
    }),
    handle: (input) =>
      Effect.gen(function*() {
        const project = yield* projects.get(input.project)
        const start = input.start === undefined ? undefined : yield* timeOrFail(input.start, "start")
        const end = input.end === undefined ? undefined : yield* timeOrFail(input.end, "end")
        const job = yield* renderer.start(project, { quality: input.quality, start, end })
        yield* renderer.wait(job.id, input.wait_seconds ?? 30)
        return yield* renderReport(job.id)
      })
  })

  yield* registerTool({
    name: "render_status",
    title: "Render status",
    description: "Check a render, or list recent renders when no render id is given.",
    params: Schema.Struct({
      render: opt(d(Schema.String, "Render id, e.g. r_8mz2kc.")),
      project: opt(d(ProjectId, "Only list renders of this project.")),
      wait_seconds: opt(WaitSeconds)
    }),
    readOnly: true,
    handle: (input) =>
      Effect.gen(function*() {
        if (input.render) {
          if (input.wait_seconds) yield* renderer.wait(input.render, input.wait_seconds)
          return yield* renderReport(input.render)
        }
        const jobs = (yield* renderer.list(input.project)).slice(0, 10)
        if (jobs.length === 0) return "No renders yet."
        const lines = yield* Effect.forEach(jobs, (j) => renderReport(j.id))
        return lines.join("\n")
      })
  })
})
