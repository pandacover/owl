import type { Word } from "../domain/Media.ts"
import {
  type CaptionSettings,
  type OutputSettings,
  placeMain,
  type TextFont,
  type TextItem,
  type TextPosition,
  type TextStyle,
  type Timeline
} from "../domain/Timeline.ts"

/**
 * Text and captions become one ASS subtitle file, burned in by libass. ASS
 * gives real typography (outline, shadow, boxes, per-word color) and
 * animation tags without a filter per text item.
 */

export const FONT = "Inter"

/** Font family names, matching the files in assets/fonts. */
const FAMILIES: Record<TextFont, { readonly regular: string; readonly bold: string }> = {
  sans: { regular: "Inter", bold: "Inter" },
  display: { regular: "Inter Display", bold: "Inter Display Black" },
  serif: { regular: "Instrument Serif", bold: "Instrument Serif" },
  light: { regular: "Inter Display Light", bold: "Inter Display Light" }
}

const ALIGN: Record<TextPosition, number> = {
  lower_left: 1,
  bottom: 2,
  center: 5,
  upper_left: 7,
  top: 8,
  upper_right: 9
}

/** #RRGGBB to ASS &HAABBGGRR. */
const assColor = (hex: string, alpha = 0) => {
  const h = hex.replace("#", "").slice(0, 6)
  const a = alpha.toString(16).padStart(2, "0").toUpperCase()
  return `&H${a}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase()
}

/** ASS alpha (0 opaque, 255 clear) from the optional opacity digits of #RRGGBBAA. */
const assAlpha = (hex: string): number => {
  const h = hex.replace("#", "")
  return h.length === 8 ? 255 - parseInt(h.slice(6, 8), 16) : 0
}

/** Box padding for text that gets a box only because a background was given. */
const BOX_PAD = 0.3

/** The style a text item draws with: its own, or a boxed version when it has a background but no box. */
const itemSpec = (item: TextItem): StyleSpec => {
  const style = TEXT_STYLES[item.style]
  if (!item.background || style.border === 3) return style
  return { ...style, border: 3, outline: style.size * BOX_PAD, shadow: 0, soft: false }
}

const styleKey = (item: TextItem) =>
  `${item.style}.${item.position}.${item.font ?? TEXT_STYLES[item.style].font}${
    item.background && TEXT_STYLES[item.style].border !== 3 ? ".box" : ""
  }`

/** Relative luminance of a #RRGGBB color, 0 (black) to 1 (white). */
const luminance = (hex: string) => {
  const h = hex.replace("#", "")
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

const assTime = (t: number) => {
  const cs = Math.max(0, Math.round(t * 100))
  const h = Math.floor(cs / 360000)
  const m = Math.floor(cs / 6000) % 60
  const s = Math.floor(cs / 100) % 60
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`
}

const escapeText = (s: string) => s.replace(/\\/g, "⧵").replace(/[{}]/g, (c) => c === "{" ? "(" : ")").replace(/\r?\n/g, "\\N")

interface StyleSpec {
  readonly size: number
  readonly bold: boolean
  readonly outline: number
  readonly shadow: number
  /** 1 outline, 3 opaque box. */
  readonly border: 1 | 3
  readonly back: string
  readonly font: TextFont
  readonly color: string
  /** Letter spacing, in fractions of the frame's short side. */
  readonly spacing: number
  /** Soft outline: a translucent dark halo instead of a hard black edge. */
  readonly soft: boolean
  readonly uppercase: boolean
}

const spec = (s: Partial<StyleSpec> & Pick<StyleSpec, "size">): StyleSpec => ({
  bold: true,
  outline: 0.004,
  shadow: 0,
  border: 1,
  back: "#000000",
  font: "sans",
  color: "#FFFFFF",
  spacing: 0,
  soft: true,
  uppercase: false,
  ...s
})

const TEXT_STYLES: Record<TextStyle, StyleSpec> = {
  title: spec({ size: 0.1, font: "display", spacing: -0.001 }),
  headline: spec({ size: 0.13, font: "display", spacing: -0.002, outline: 0.005 }),
  kicker: spec({ size: 0.032, spacing: 0.004, uppercase: true, outline: 0.003 }),
  subtitle: spec({ size: 0.055, bold: false, outline: 0.003 }),
  lower_third: spec({ size: 0.045, outline: 0.012, border: 3, back: "#111111", soft: false }),
  caption: spec({ size: 0.05, outline: 0.004 }),
  highlight: spec({ size: 0.062, font: "display", outline: 0.02, border: 3, back: "#FFFFFF", color: "#111111", soft: false }),
  cta: spec({ size: 0.07, font: "display", outline: 0.022, border: 3, back: "#E11D48", soft: false }),
  label: spec({ size: 0.035, outline: 0.008, border: 3, back: "#000000", soft: false }),
  statement: spec({ size: 0.058, bold: false, font: "light", outline: 0.002, spacing: -0.0005 })
}

const styleLine = (
  name: string,
  spec: StyleSpec,
  base: number,
  align: number,
  margins: [number, number, number],
  font: TextFont = spec.font
) => {
  const px = (k: number) => Math.max(1, Math.round(k * base))
  const family = spec.bold ? FAMILIES[font].bold : FAMILIES[font].regular
  // The Black and serif families carry their weight in the name, so they are not made bold again.
  const bold = spec.bold && family === FAMILIES[font].regular && font === "sans"
  return [
    `Style: ${name}`,
    family,
    px(spec.size),
    assColor(spec.color),
    assColor(spec.color),
    // With BorderStyle 3 libass fills the box with the outline color.
    spec.border === 3 ? assColor(spec.back, 0x08) : assColor("#000000", spec.soft ? 0xB8 : 0),
    assColor("#000000", 0x80),
    bold ? -1 : 0,
    0,
    0,
    0,
    100,
    100,
    Math.round(spec.spacing * base * 10) / 10,
    0,
    spec.border,
    spec.border === 3 ? px(spec.outline) : Math.max(1, px(spec.outline)),
    px(spec.shadow),
    align,
    margins[0],
    margins[1],
    margins[2],
    1
  ].join(",")
}

/** Where an aligned line sits, for \\move and \\pos. */
const anchor = (align: number, output: OutputSettings, marginV: number) => {
  const x = align === 1 || align === 7
    ? Math.round(output.width * 0.06)
    : align === 9
    ? Math.round(output.width * 0.94)
    : Math.round(output.width / 2)
  const y = align === 5 ? Math.round(output.height / 2) : align >= 7 ? marginV : output.height - marginV
  return { x, y }
}

const textEvent = (item: TextItem, output: OutputSettings, marginV: number) => {
  const style = itemSpec(item)
  const base = Math.min(output.width, output.height)
  // An explicit y pins the top of the text at that height; the position still decides left, center or right.
  const pinned = item.y !== undefined
  const horizontal = ALIGN[item.position] % 3
  const align = pinned ? (horizontal === 1 ? 7 : horizontal === 0 ? 9 : 8) : ALIGN[item.position]
  const point = pinned
    ? { x: anchor(align, output, marginV).x, y: Math.round(item.y! * output.height) }
    : anchor(align, output, marginV)
  const raw = style.uppercase ? item.text.toUpperCase() : item.text
  const color = item.color ? `\\c${assColor(item.color)}` : ""
  const box = item.background && style.border === 3
    ? `\\3c${assColor(item.background)}\\3a&H${assAlpha(item.background).toString(16).padStart(2, "0").toUpperCase()}&`
    : ""
  // A dark halo helps light text over video; behind dark text it only smudges, so dark text gets none.
  const darkText = item.color !== undefined && luminance(item.color) < 0.45
  const soft = style.border === 3 ? "" : darkText ? "\\bord0\\shad0" : style.soft ? "\\blur6" : ""
  const size = item.size !== undefined && item.size !== 1 ? `\\fs${Math.max(1, Math.round(style.size * base * item.size))}` : ""
  const lead = `{${color}${box}${soft}${size}}`
  const durationMs = Math.round((item.end - item.start) * 1000)
  let tags = pinned ? `\\an${align}\\pos(${point.x},${point.y})` : ""
  let body = escapeText(raw)
  switch (item.animation) {
    case "none":
      break
    case "fade":
      tags += "\\fad(250,250)"
      break
    case "pop":
      tags += "\\fad(120,200)\\fscx70\\fscy70\\t(0,180,\\fscx108\\fscy108)\\t(180,280,\\fscx100\\fscy100)"
      break
    case "zoom":
      tags += "\\fad(200,200)\\fscx118\\fscy118\\t(0,450,0.5,\\fscx100\\fscy100)"
      break
    case "slide_up":
    case "rise": {
      const { x, y } = point
      const shift = Math.round(output.height * (item.animation === "rise" ? 0.025 : 0.04))
      tags = `\\an${align}\\fad(${item.animation === "rise" ? 300 : 200},200)\\move(${x},${y + shift},${x},${y},0,${
        item.animation === "rise" ? 450 : 300
      })`
      break
    }
    case "words":
    case "typewriter": {
      const lines = raw.split(/\r?\n/)
      const letters = item.animation === "typewriter"
      const units = lines.reduce((sum, l) => sum + (letters ? l.length : l.split(/\s+/).filter(Boolean).length), 0)
      // Finish revealing within the first half of the text's time.
      const step = Math.max(letters ? 15 : 60, Math.min(letters ? 45 : 160, Math.round(durationMs * 0.5 / Math.max(1, units))))
      let offset = 0
      body = lines.map((line) => {
        const parts = letters ? [...line].map(escapeText) : line.split(/\s+/).filter(Boolean).map(escapeText)
        const out = parts
          .map((part, i) => {
            const t = (offset + i) * step
            const fade = letters ? 1 : 220
            const sharpen = letters || style.border === 3 ? "" : "\\blur6"
            // In a box only the letters fade in, so the box stays put.
            const a = style.border === 3 ? "\\1a" : "\\alpha"
            return `{${a}&HFF&${sharpen}\\t(${t},${t + fade},${a}&H00&${sharpen ? "\\blur0" : ""})}${part}`
          })
          .join(letters ? "" : " ")
        offset += parts.length
        return out
      }).join("\\N")
      tags += "\\fad(0,200)"
      break
    }
  }
  return `Dialogue: 1,${assTime(item.start)},${assTime(item.end)},${styleKey(item)},,0,0,0,,${
    tags ? `{${tags}}` : ""
  }${lead === "{}" ? "" : lead}${body}`
}

export interface CaptionWord {
  readonly w: string
  /** Timeline times. */
  readonly s: number
  readonly e: number
}

/** Words spoken in the main track, at timeline times. */
export const timelineWords = (
  timeline: Timeline,
  wordsOf: (mediaId: string) => ReadonlyArray<Word>
): Array<CaptionWord> => {
  const out: Array<CaptionWord> = []
  for (const p of placeMain(timeline.main)) {
    const c = p.clip
    if (c.volume === 0) continue
    for (const w of wordsOf(c.mediaId)) {
      const mid = (w.s + w.e) / 2
      if (mid < c.in || mid > c.out) continue
      const s = p.start + (Math.max(w.s, c.in) - c.in) / c.speed
      const e = p.start + (Math.min(w.e, c.out) - c.in) / c.speed
      // A word inside a transition overlap belongs to the clip that starts there; skip the earlier copy.
      if (out.length > 0 && s < out[out.length - 1]!.s) continue
      out.push({ w: w.w.trim(), s, e })
    }
  }
  return out.filter((w) => w.w.length > 0)
}

/** Groups words into caption lines: a line ends at the word limit, a sentence end or a pause. */
export const captionLines = (words: ReadonlyArray<CaptionWord>, maxWords: number): Array<Array<CaptionWord>> => {
  const lines: Array<Array<CaptionWord>> = []
  let line: Array<CaptionWord> = []
  for (const w of words) {
    const prev = line[line.length - 1]
    if (prev && (line.length >= maxWords || w.s - prev.e > 0.6 || /[.!?]$/.test(prev.w))) {
      lines.push(line)
      line = []
    }
    line.push(w)
  }
  if (line.length > 0) lines.push(line)
  return lines
}

const captionEvents = (words: ReadonlyArray<CaptionWord>, settings: CaptionSettings): Array<string> => {
  const fix = (s: string) => escapeText(settings.uppercase ? s.toUpperCase() : s)
  const lines = captionLines(words, settings.maxWordsPerLine)
  const events: Array<string> = []
  lines.forEach((line, i) => {
    const start = line[0]!.s
    const next = lines[i + 1]?.[0]?.s
    // Hold a line until the next one when the gap is short, so captions do not flicker.
    const end = next !== undefined && next - line[line.length - 1]!.e < 0.4 ? next : line[line.length - 1]!.e + 0.15
    if (settings.style === "karaoke") {
      const hi = assColor(settings.highlightColor)
      line.forEach((word, j) => {
        const s = j === 0 ? start : word.s
        const e = j === line.length - 1 ? end : line[j + 1]!.s
        const text = line.map((w, k) => k === j ? `{\\c${hi}}${fix(w.w)}{\\c&HFFFFFF&}` : fix(w.w)).join(" ")
        events.push(`Dialogue: 0,${assTime(s)},${assTime(e)},Caption,,0,0,0,,${text}`)
      })
    } else {
      events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${fix(line.map((w) => w.w).join(" "))}`)
    }
  })
  return events
}

const CAPTION_STYLES: Record<CaptionSettings["style"], StyleSpec> = {
  clean: spec({ size: 0.055, bold: false, outline: 0.004, shadow: 0.002, soft: false }),
  bold: spec({ size: 0.075, outline: 0.006, shadow: 0.003, soft: false }),
  karaoke: spec({ size: 0.075, outline: 0.006, shadow: 0.003, soft: false }),
  boxed: spec({ size: 0.055, outline: 0.012, border: 3, soft: false })
}

/** Builds the ASS document, or undefined when there is nothing to draw. */
export const buildAss = (
  timeline: Timeline,
  words: ReadonlyArray<CaptionWord>
): string | undefined => {
  const out = timeline.output
  const captions = timeline.captions
  if (timeline.texts.length === 0 && (!captions || words.length === 0)) return undefined
  const base = Math.min(out.width, out.height)
  const portrait = out.height > out.width
  const marginH = Math.round(out.width * 0.06)
  const marginV = Math.round(out.height * 0.06)
  const styles: Array<string> = []
  const used = new Map(timeline.texts.map((t) => [styleKey(t), t]))
  for (const [key, t] of used) {
    styles.push(styleLine(key, itemSpec(t), base, ALIGN[t.position], [marginH, marginH, marginV], t.font ?? TEXT_STYLES[t.style].font))
  }
  if (captions) {
    const align = captions.position === "top" ? 8 : captions.position === "center" ? 5 : 2
    // Portrait video is watched in apps that draw controls over the bottom, so captions sit higher.
    const v = captions.position === "bottom" && portrait ? Math.round(out.height * 0.22) : Math.round(out.height * 0.08)
    styles.push(styleLine("Caption", CAPTION_STYLES[captions.style], base, align, [marginH, marginH, v]))
  }
  const events = [
    ...timeline.texts.map((t) => textEvent(t, out, marginV)),
    ...(captions ? captionEvents(words, captions) : [])
  ]
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${out.width}`,
    `PlayResY: ${out.height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styles,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    ""
  ].join("\n")
}
