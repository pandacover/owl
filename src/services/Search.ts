import { Context, Effect, Layer, Option } from "effect"
import { OwlConfig } from "../Config.ts"
import type { Analysis, MediaRecord, Shot } from "../domain/Media.ts"
import { MediaLibrary } from "./MediaLibrary.ts"
import { Storage } from "./Storage.ts"
import { WorkersAi } from "./WorkersAi.ts"

export interface SearchDoc {
  readonly mediaId: string
  readonly kind: "shot" | "speech"
  readonly start: number
  readonly end: number
  readonly shot?: number | undefined
  readonly text: string
  readonly appeal?: number | undefined
  readonly motion?: Shot["motionLabel"] | undefined
}

export interface SearchHit extends SearchDoc {
  readonly score: number
}

export interface SearchQuery {
  readonly query: string
  readonly mediaIds?: ReadonlyArray<string> | undefined
  readonly kind?: "any" | "shot" | "speech" | undefined
  readonly minAppeal?: number | undefined
  readonly motion?: ReadonlyArray<Shot["motionLabel"]> | undefined
  readonly limit: number
}

export interface SearchShape {
  /** Builds and stores embeddings for a media item. Safe to call again after re-analysis. */
  readonly indexMedia: (id: string) => Effect.Effect<{ readonly docs: number; readonly embedded: boolean }>
  readonly search: (query: SearchQuery) => Effect.Effect<ReadonlyArray<SearchHit>>
}

interface MediaIndex {
  readonly docs: ReadonlyArray<SearchDoc>
  readonly tokens: ReadonlyArray<ReadonlyArray<string>>
  readonly vectors?: ReadonlyArray<Float32Array> | undefined
}

const STOP = new Set("a an the and or of to in on at for with is are was were be by it this that from as into over under".split(" "))

export const tokenize = (text: string): Array<string> =>
  text.toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/[\s-]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => t.length > 4 ? t.replace(/(ing|ed|es|s)$/, "") : t)

export const shotText = (shot: Shot): string => {
  const c = shot.caption
  if (!c) return `${shot.motionLabel} motion shot`
  return [
    c.description,
    c.subjects.join(", "),
    c.setting,
    c.tags.join(" "),
    c.onScreenText ? `text: ${c.onScreenText}` : "",
    c.shotType.replace(/_/g, " "),
    c.cameraMotion.replace(/_/g, " ")
  ].filter(Boolean).join(". ")
}

/** Speech grouped into windows of a few sentences, so hits point at a usable range. */
export const speechDocs = (mediaId: string, analysis: Analysis): Array<SearchDoc> => {
  const out: Array<SearchDoc> = []
  let current: { start: number; end: number; parts: Array<string> } | undefined
  for (const seg of analysis.transcript?.segments ?? []) {
    if (current && (seg.end - current.start > 20 || seg.start - current.end > 2)) {
      out.push({ mediaId, kind: "speech", start: current.start, end: current.end, text: current.parts.join(" ") })
      current = undefined
    }
    if (!current) current = { start: seg.start, end: seg.end, parts: [] }
    current.end = seg.end
    current.parts.push(seg.text)
  }
  if (current) out.push({ mediaId, kind: "speech", start: current.start, end: current.end, text: current.parts.join(" ") })
  return out
}

const buildDocs = (record: MediaRecord, analysis: Analysis): Array<SearchDoc> => [
  ...analysis.shots.map((shot): SearchDoc => ({
    mediaId: record.id,
    kind: "shot",
    start: shot.start,
    end: shot.end,
    shot: shot.index,
    text: shotText(shot),
    appeal: shot.caption?.appeal,
    motion: shot.motionLabel
  })),
  ...speechDocs(record.id, analysis)
]

const embeddingsKey = (id: string) => `media/${id}/embeddings.json`

interface StoredEmbeddings {
  readonly model: string
  readonly texts: ReadonlyArray<string>
  readonly vectors: ReadonlyArray<string>
}

const toBase64 = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64")
const fromBase64 = (s: string) => {
  const b = Buffer.from(s, "base64")
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}

const normalize = (v: ReadonlyArray<number>): Float32Array => {
  const out = Float32Array.from(v)
  let norm = 0
  for (const x of out) norm += x * x
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / norm
  return out
}

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!
  return s
}

export class Search extends Context.Service<Search, SearchShape>()("owl/Search") {
  static readonly layer = Layer.effect(
    Search,
    Effect.gen(function*() {
      const config = yield* OwlConfig
      const library = yield* MediaLibrary
      const storage = yield* Storage
      const ai = yield* WorkersAi
      const indexes = new Map<string, MediaIndex>()

      const embed = (texts: ReadonlyArray<string>) =>
        Effect.gen(function*() {
          const vectors: Array<Float32Array> = []
          for (let i = 0; i < texts.length; i += 50) {
            const out = yield* ai.run(config.embeddingModel, { text: texts.slice(i, i + 50) })
            const data = (out as { data?: ReadonlyArray<ReadonlyArray<number>> }).data
            if (!data || data.length !== Math.min(50, texts.length - i)) {
              return yield* Effect.fail(new Error("Unexpected embedding response"))
            }
            for (const v of data) vectors.push(normalize(v))
          }
          return vectors
        })

      const loadIndex = (id: string): Effect.Effect<Option.Option<MediaIndex>> =>
        Effect.gen(function*() {
          const cached = indexes.get(id)
          if (cached) return Option.some(cached)
          const record = yield* library.get(id)
          const analysis = yield* library.analysis(id)
          if (Option.isNone(analysis)) return Option.none()
          const docs = buildDocs(record, analysis.value)
          const stored = yield* storage.readJson<StoredEmbeddings>(embeddingsKey(id))
          // Only reuse stored vectors when they match the current documents.
          const vectors = Option.isSome(stored) && stored.value.model === config.embeddingModel &&
              stored.value.texts.length === docs.length && stored.value.texts.every((t, i) => t === docs[i]!.text)
            ? stored.value.vectors.map(fromBase64)
            : undefined
          const index: MediaIndex = { docs, tokens: docs.map((d) => tokenize(d.text)), vectors }
          indexes.set(id, index)
          return Option.some(index)
        }).pipe(Effect.orElseSucceed(() => Option.none()))

      const indexMedia = (id: string) =>
        Effect.gen(function*() {
          indexes.delete(id)
          const record = yield* library.get(id)
          const analysis = yield* library.analysis(id)
          if (Option.isNone(analysis)) return { docs: 0, embedded: false }
          const docs = buildDocs(record, analysis.value)
          let vectors: ReadonlyArray<Float32Array> | undefined
          if (ai.available && docs.length > 0) {
            const texts = docs.map((d) => d.text)
            vectors = yield* embed(texts).pipe(
              Effect.tap((v) =>
                storage.writeJson(embeddingsKey(id), {
                  model: config.embeddingModel,
                  texts,
                  vectors: v.map(toBase64)
                } satisfies StoredEmbeddings)
              ),
              Effect.tapError((e) => Effect.logWarning(`Embedding failed for ${id}, keyword search only`, e)),
              Effect.orElseSucceed(() => undefined)
            )
          }
          indexes.set(id, { docs, tokens: docs.map((d) => tokenize(d.text)), vectors })
          return { docs: docs.length, embedded: vectors !== undefined }
        }).pipe(Effect.orElseSucceed(() => ({ docs: 0, embedded: false })))

      const search = (query: SearchQuery) =>
        Effect.gen(function*() {
          const records = yield* library.list
          const ids = query.mediaIds && query.mediaIds.length > 0
            ? query.mediaIds
            : records.map((r) => r.id)
          const loaded: Array<MediaIndex> = []
          for (const id of ids) {
            const index = yield* loadIndex(id)
            if (Option.isSome(index)) loaded.push(index.value)
          }
          const candidates: Array<{ doc: SearchDoc; tokens: ReadonlyArray<string>; vector?: Float32Array | undefined }> =
            []
          for (const index of loaded) {
            index.docs.forEach((doc, i) => {
              if (query.kind && query.kind !== "any" && doc.kind !== query.kind) return
              if (query.minAppeal !== undefined && doc.kind === "shot" && (doc.appeal ?? 0) < query.minAppeal) return
              if (query.motion && query.motion.length > 0 && doc.kind === "shot" && !query.motion.includes(doc.motion!)) {
                return
              }
              candidates.push({ doc, tokens: index.tokens[i]!, vector: index.vectors?.[i] })
            })
          }
          if (candidates.length === 0) return []
          const queryTokens = [...new Set(tokenize(query.query))]

          // BM25 over the candidate set.
          const n = candidates.length
          const avgLength = candidates.reduce((s, c) => s + c.tokens.length, 0) / n || 1
          const df = new Map<string, number>()
          for (const c of candidates) for (const t of new Set(c.tokens)) df.set(t, (df.get(t) ?? 0) + 1)
          const bm25 = candidates.map((c) => {
            let score = 0
            for (const q of queryTokens) {
              const tf = c.tokens.filter((t) => t === q || (q.length > 3 && t.startsWith(q))).length
              if (tf === 0) continue
              const idf = Math.log(1 + (n - (df.get(q) ?? 0) + 0.5) / ((df.get(q) ?? 0) + 0.5))
              score += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * c.tokens.length / avgLength))
            }
            return score
          })
          const maxBm25 = Math.max(...bm25) || 1

          let semantic: Array<number> | undefined
          if (ai.available && query.query.trim() && candidates.some((c) => c.vector)) {
            const vectors = yield* embed([query.query]).pipe(Effect.orElseSucceed(() => undefined))
            const q = vectors?.[0]
            if (q) semantic = candidates.map((c) => c.vector ? Math.max(0, (dot(q, c.vector) - 0.3) / 0.5) : 0)
          }

          const hits = candidates.map((c, i): SearchHit => {
            const lexical = bm25[i]! / maxBm25
            const score = semantic ? 0.4 * lexical + 0.6 * Math.min(1, semantic[i]!) : lexical
            return { ...c.doc, score: Math.round(score * 1000) / 1000 }
          })
          const relevant = queryTokens.length === 0 && !semantic ? hits : hits.filter((h) => h.score > 0.05)
          return relevant
            .sort((a, b) => b.score - a.score || (b.appeal ?? 0) - (a.appeal ?? 0))
            .slice(0, query.limit)
        }).pipe(Effect.orElseSucceed(() => []))

      return Search.of({ indexMedia, search })
    })
  )
}
