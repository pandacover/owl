/**
 * Stock sound effects the agent can bring into the library by name.
 *
 * A small hand-picked set from the free Sonniss #GameAudioGDC bundles: sound
 * design by professional studios, royalty free for commercial use with no
 * credit (https://sonniss.com/gdc-bundle-license/). The files are not in this
 * repository. media_import fetches one from the bundle's Internet Archive copy
 * the first time it is used, and it then lives in storage like any upload.
 */

export type SoundCategory = "whoosh" | "riser" | "impact" | "ui" | "glitch" | "foley"

export interface StockSound {
  readonly id: string
  readonly category: SoundCategory
  /** What it sounds like and where it fits. */
  readonly use: string
  /** Bundle year, which picks the Internet Archive item. */
  readonly bundle: 2023 | 2024 | 2026
  /** "<studio> - <library>/<file>" inside the bundle. */
  readonly path: string
}

export const STOCK_SOUNDS: ReadonlyArray<StockSound> = [
  // Whooshes: start them a little before the cut so the loudest part lands on it.
  { id: "whoosh_sweep", category: "whoosh", use: "clean motion-graphics sweep; slides, smooth pushes, text flying in", bundle: 2026, path: "Cinematic Sound Design - Ultra Transitions & Impacts/Woosh Sweep Slide Infographics Basic.wav" },
  { id: "whoosh_air", category: "whoosh", use: "soft airy gust; calm cinematic cuts and blur transitions", bundle: 2024, path: "Rescopic Sound - Distinct Whooshes/WHSH_Airy-Whoosh Wind Gust 11_RSCPC_DW.wav" },
  { id: "whoosh_fast", category: "whoosh", use: "short bright whoosh; whip transitions and quick punch-ins", bundle: 2024, path: "Rescopic Sound - Distinct Whooshes/WHSH_Pure SciFi-Whoosh Fast 03_RSCPC_DW.wav" },
  { id: "whoosh_heavy", category: "whoosh", use: "deep heavy whoosh; big reveals and slow pushes", bundle: 2024, path: "Mechanical Wave - Cinematic Feel/WHSH_Sci-Fi Heavy Whoosh_MWSFX_CF 29.wav" },
  { id: "whoosh_wind", category: "whoosh", use: "five long wind rushes in one file; travel, outdoor, scene changes", bundle: 2026, path: "344 Audio - Elemental Palette Designed Vol. 1/WINDDsgn_Wind, Rush, Whoosh, Long x5 01_344 Audio_Elemental Palette Designed Vol 1.wav" },
  { id: "whoosh_glass", category: "whoosh", use: "crystalline shimmer whoosh; luxury, beauty, jewelry", bundle: 2026, path: "Epic Stock Media - Elemental Mutation Whooshes and Impacts/GLASMvmt_Whoosh Glass Crystal Fragments Sharp Shards Dry 05_ESM_EMWI.wav" },
  { id: "whoosh_cut", category: "whoosh", use: "sweep that ends in a hit; a cut that lands hard", bundle: 2026, path: "Cinematic Sound Design - Colossal Impacts/Impact Cut Sweep.wav" },
  // Risers: end them exactly on the reveal.
  { id: "riser_strings", category: "riser", use: "orchestral string riser; builds into a reveal or title", bundle: 2024, path: "Orbital Emitter - Cinematic Transitions for Editors Volume 2/112,StringsSectionRiser.wav" },
  { id: "riser_metal", category: "riser", use: "dark metallic trailer riser; tension before a drop", bundle: 2024, path: "Jake Fielding - Haunted Metal Vol.2 - Cinematic Creaks & Risers/DSGNRise_Cinematic Metallic Riser, Trailer, Designed,_JF_Haunted Metal Vol 2_39.wav" },
  // Impacts: on the first frame of the moment they mark.
  { id: "boom_trailer", category: "impact", use: "trailer boom; title cards and the main reveal", bundle: 2026, path: "Federico Soler - Effective Trailer Booms Vol. 2/EffectiveTrailer_Booms_Vol2_011.wav" },
  { id: "boom_deep", category: "impact", use: "deeper, longer trailer boom; the last hit before the end card", bundle: 2026, path: "Federico Soler - Effective Trailer Booms Vol. 2/EffectiveTrailer_Booms_Vol2_075.wav" },
  { id: "hit_cinematic", category: "impact", use: "big cinematic hit with a long tail", bundle: 2024, path: "Mechanical Wave - Cinematic Feel/DSGNBoom_Cinematic Hit_MWSFX_CF 05.wav" },
  { id: "hit_modern", category: "impact", use: "tight modern impact; product reveals, logo slams", bundle: 2024, path: "BluezoneCorp - Modern Cinematic Impact/Bluezone_BC0294_modern_cinematic_impact_boom_003.wav" },
  { id: "hit_epic", category: "impact", use: "epic orchestral-style impact", bundle: 2023, path: "344 Audio - Epic Impacts Vol. 1/Impact 021.wav" },
  { id: "hit_chord", category: "impact", use: "tonal hit with a chord and reverb; emotional beats, end cards", bundle: 2026, path: "Cinematic Sound Design - Ultra Transitions & Impacts/Impact Hit Rapid Chord Reverb.wav" },
  { id: "sub_drop_fast", category: "impact", use: "short sub bass drop; under a hard cut or a text slam", bundle: 2026, path: "344 Audio - Bass Drops & Downers Vol. 1/DSGNBass_Bass Drop & Downer Fast 16_344 Audio_Bass Drops & Downers.wav" },
  { id: "sub_drop", category: "impact", use: "sub bass drop; the drop after a build, felt more than heard", bundle: 2026, path: "344 Audio - Bass Drops & Downers Vol. 1/DSGNBass_Bass Drop & Downer Medium 04_344 Audio_Bass Drops & Downers.wav" },
  { id: "sub_drop_slow", category: "impact", use: "long slow sub drop; a slow-motion moment or the final card", bundle: 2026, path: "344 Audio - Bass Drops & Downers Vol. 1/DSGNBass_Bass Drop & Downer Slow 10_344 Audio_Bass Drops & Downers.wav" },
  { id: "downer_tone", category: "impact", use: "falling tone with reverb; a pause, a turn, cut to black", bundle: 2026, path: "344 Audio - Bass Drops & Downers Vol. 3/DSGNBass_Tone Downer (Reverb)_344 Audio_Bass Drops and Downers Vol 3.wav" },
  { id: "braam", category: "impact", use: "huge dark horn braam; one per film at most, for the biggest dramatic moment", bundle: 2026, path: "Jake Fielding - Cinematic Horn Braams/DSGNBram____Cinematic Horn Braam, Epic, Cinematic, Dark, Instrument, Huge-32.wav" },
  // Interface: on the frame of the tap or the change on screen.
  { id: "ui_pop", category: "ui", use: "short high pop; a card or label appearing", bundle: 2026, path: "Cinematic Sound Design - Interface & Infographics/Interface Pop High Short.wav" },
  { id: "ui_snap", category: "ui", use: "glassy accept snap; a tap that succeeds, a check mark", bundle: 2026, path: "Cinematic Sound Design - Interface & Infographics/Interface Accept Glassy Snap.wav" },
  { id: "ui_tick", category: "ui", use: "dry percussive snap; text appearing word by word, counters", bundle: 2026, path: "Cinematic Sound Design - Interface & Infographics/Interface Percussion Snap.wav" },
  { id: "ui_readout", category: "ui", use: "thin data readout; numbers and charts building", bundle: 2026, path: "Cinematic Sound Design - User Interface/Readout Thin Long.wav" },
  { id: "ui_chime", category: "ui", use: "soft kalimba rise; a friendly success or a notification", bundle: 2026, path: "CB_Sounddesign - Applicable Sounds - Organic UI and Building Games SFX/UIMisc_Kalimba 3 Up_CB Sounddesign_APPlicable Sounds.wav" },
  { id: "click_switch", category: "ui", use: "real light switch click; a tap or a scene switching on", bundle: 2026, path: "InMotionAudio - USA Hotel/MECHClik_USALightSwitch_On05_InMotionAudio_USAHotel.wav" },
  { id: "click_latch", category: "ui", use: "deep mechanical latch; a satisfying lock-in, hardware products", bundle: 2026, path: "Epic Stock Media - HD Lock And Mechanism Sound Design Kit/MECHLtch_Click Deep Mechanism Latch Button Nearfield Thunk 02_ESM_HDLM.wav" },
  // Glitch: very short, tech edits only.
  { id: "glitch_short", category: "glitch", use: "high electronic glitch; the glitch transition", bundle: 2026, path: "The Noisery - Rich Glitch/UIGlitch_User interface_Glitch_High_Electronic_The Noisery_Rich Glitch_05.wav" },
  { id: "glitch_data", category: "glitch", use: "corrupted data burst; errors, hacks, before-and-after", bundle: 2026, path: "The Noisery - Rich Glitch/UIGlitch_Designed_Glitch_Corrupted_Data Error_The Noisery_Rich Glitch_06.wav" },
  // Foley: real objects for texture and motifs.
  { id: "page_turn", category: "foley", use: "glossy page turn; editorial edits, a new chapter", bundle: 2026, path: "Cinematic Sound Design - Paper Foley/Encyclopedia Glossy Page Turn Muted.wav" },
  { id: "typewriter_key", category: "foley", use: "typewriter key; under typewriter text, one strike per letter or word", bundle: 2026, path: "344 Audio - Antique Typewriter/COMType_Typewriter Space Key, Typewriter 05_344 Audio_Antiques - Typewriter.wav" },
  { id: "typewriter_carriage", category: "foley", use: "typewriter carriage return; the end of a typed line", bundle: 2026, path: "344 Audio - Antique Typewriter/COMType_Typewriter Carriage Movement, Typewriter_344 Audio_Antiques - Typewriter_01.wav" },
  { id: "clock_tick", category: "foley", use: "antique clock ticking; countdowns, deadlines, tension", bundle: 2026, path: "344 Audio - Antique Clocks/CLOCKTick_You're Running Late _344 Audio_Antique Clocks.wav" }
]

export const STOCK_IDS = STOCK_SOUNDS.map((s) => s.id) as unknown as readonly [string, ...Array<string>]

export const stockSound = (id: string): StockSound | undefined => STOCK_SOUNDS.find((s) => s.id === id)

/** Where media_import downloads the sound from. */
export const stockUrl = (sound: StockSound): string =>
  `https://archive.org/download/sonniss-gdc-${sound.bundle}-game-audio-bundle-normalized/${
    sound.path.split("/").map(encodeURIComponent).join("/")
  }`

/** Studio and library, for credits and for the user to look the sound up. */
export const stockCredit = (sound: StockSound): string => sound.path.split("/")[0]!
