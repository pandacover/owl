/**
 * Media records and analysis results. These are internal, trusted JSON
 * documents persisted by owl itself, so they are plain interfaces.
 */

export type MediaKind = "video" | "audio" | "image"

export interface Probe {
  readonly kind: MediaKind
  readonly duration: number
  /** Display size after rotation. 0 for audio. */
  readonly width: number
  readonly height: number
  readonly fps: number
  readonly hasVideo: boolean
  readonly hasAudio: boolean
  readonly videoCodec?: string | undefined
  readonly audioCodec?: string | undefined
  readonly sampleRate?: number | undefined
  readonly channels?: number | undefined
  readonly rotation: number
  readonly bytes: number
  readonly bitrate?: number | undefined
}

export type StageName = "probe" | "proxy" | "shots" | "audio" | "frames" | "captions" | "transcript" | "index"

export type StageStatus = "pending" | "running" | "done" | "skipped" | "failed"

export interface StageState {
  readonly status: StageStatus
  readonly progress?: number | undefined
  readonly note?: string | undefined
}

export type MediaStatus = "importing" | "analyzing" | "ready" | "failed"

export interface MediaRecord {
  readonly id: string
  readonly name: string
  readonly createdAt: string
  readonly sourceKey: string
  readonly origin: { readonly type: "upload" | "url"; readonly url?: string | undefined }
  readonly status: MediaStatus
  readonly probe?: Probe | undefined
  readonly stages: Partial<Record<StageName, StageState>>
  readonly error?: string | undefined
  /** Short summary built after analysis, e.g. "12 shots, music at 118 BPM, no speech". */
  readonly summary?: string | undefined
}

export interface ShotCaption {
  readonly description: string
  readonly subjects: ReadonlyArray<string>
  readonly setting: string
  readonly shotType: string
  readonly cameraMotion: string
  readonly onScreenText: string
  readonly tags: ReadonlyArray<string>
  /** 1 to 5, how usable and attractive the shot is. */
  readonly appeal: number
  readonly issues: string
  /** One short note per keyframe, in keyframe order: what is visible then and what just changed. */
  readonly notes?: ReadonlyArray<string> | undefined
}

/**
 * A step inside a mostly still shot, such as one screen of a screen recording.
 * Moments split where the picture changes after a still stretch (a tap, a page
 * change, a scroll), so each one shows an action and its result.
 */
export interface Moment {
  readonly start: number
  readonly end: number
  /** Saved frame for this moment, after the change has settled. */
  readonly keyframe: number
}

export interface Shot {
  /** 1-based, stable for a given analysis. */
  readonly index: number
  readonly start: number
  readonly end: number
  /** 0 to 1 average frame-to-frame change inside the shot. */
  readonly motion: number
  readonly motionLabel: "static" | "low" | "medium" | "high"
  /** Average brightness 0 to 1, from the analysis pass. */
  readonly brightness?: number | undefined
  /** Times of frames saved for this shot. With moments, one per moment. */
  readonly keyframes: ReadonlyArray<number>
  readonly moments?: ReadonlyArray<Moment> | undefined
  readonly caption?: ShotCaption | undefined
}

export type AudioKind = "none" | "silent" | "speech" | "music" | "speech_and_music" | "sound"

export interface AudioAnalysis {
  readonly kind: AudioKind
  /** Loudness curve in dBFS, one value per `hop` seconds. */
  readonly hop: number
  readonly loudness: ReadonlyArray<number>
  readonly meanDb: number
  readonly peakDb: number
  readonly silences: ReadonlyArray<readonly [number, number]>
  readonly tempo?: number | undefined
  readonly tempoConfidence: number
  readonly beats: ReadonlyArray<number>
  /** Every beat that starts a bar, assuming 4/4. */
  readonly downbeats: ReadonlyArray<number>
  /** Strongest onsets (hits, drops) by strength. */
  readonly accents: ReadonlyArray<number>
}

export interface Word {
  readonly w: string
  readonly s: number
  readonly e: number
}

export interface TranscriptSegment {
  readonly start: number
  readonly end: number
  readonly text: string
  readonly words: ReadonlyArray<Word>
}

export interface Transcript {
  readonly language?: string | undefined
  readonly segments: ReadonlyArray<TranscriptSegment>
}

export interface Analysis {
  readonly version: 1
  /** Shot and moment detector that produced `shots`. Older analyses are re-detected at startup. */
  readonly detector?: number | undefined
  readonly shots: ReadonlyArray<Shot>
  readonly audio?: AudioAnalysis | undefined
  readonly transcript?: Transcript | undefined
}
