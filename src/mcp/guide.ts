/**
 * Editing know-how for the agent, served by the edit_guide tool. Kept out of
 * the server instructions so it costs nothing until the agent asks for it.
 */

export const GUIDE_TOPICS = ["principles", "cinematic", "screen_recording", "product_ad", "talking_head", "montage", "text"] as const
export type GuideTopic = typeof GUIDE_TOPICS[number]

const PRINCIPLES = `Premium edit principles (read before building any edit)

Pick one style first and keep to it:
- Bold social: light or brand-colored background, big headlines, highlight boxes, fast energy. Recipes: screen_recording, product_ad.
- Cinematic: dark, calm and expensive, thin small text, slow holds then a fast build (the look of Apple and Luma launch films). Recipe: cinematic.
If the user names a reference ad or says "premium", "cinematic" or "launch film", use cinematic. If unsure, ask.

Hook
- The first 1.5 seconds decide everything. Open on the strongest visual with a 3 to 6 word headline. No logo intro, no slow fade from black (the cinematic style has its own calm opening).

Pacing
- Ads and promos: a new picture every 1 to 2.5 seconds. Hold only as long as it takes to read the key text.
- Never slow down screen recordings or UI (no speed below 1). Speed up typing, loading and scrolling (1.5x to 3x) or cut them out.
- One idea per beat: each segment shows one benefit and carries at most one line of text.

Motion
- Nothing sits dead still. Give still shots and screens a slow push (zoom 1 to 1.06 over the clip) and punch in (1.6x to 2.2x) on the exact thing being tapped or shown, then ease back out before the next step.
- Zoom x/y point at the element that matters. Check with preview_frames that it stays in frame.

Look
- Pick 2 or 3 brand colors from the footage (the app's accent and background colors) and reuse them for the background gradient, highlight boxes and the call to action.
- Contrast: dark text (#1F1A17 or similar) on light backgrounds, white text over video or dark backgrounds. Never white on light.
- At most 2 fonts and at most 2 text items on screen at once.
- Keep text out of the bottom 20% of a 9:16 frame (app buttons and captions live there) and away from the main subject.
- Hide private details with add_blur: phone numbers, contact names, emails, notification badges, personal messages, other apps on a home screen.

Transitions
- Default to hard cuts. Use smooth_left or smooth_up (0.3 to 0.4s) to move between app steps, or blur (0.3s) in the cinematic style. Avoid crossfades between UI screens; they look muddy. fade_black only at the very end.

Sound
- A premium edit has music. If the user has no track, ask for one (they can upload it with media_upload_link) before the final render, and say why. Cut on beats (media_get detail full lists beat times; edit_beat_montage does it automatically).

Ending
- End card for 2 to 2.5 seconds: product name, one call to action (cta style) and the URL or handle.

Checking
- After building: timeline_get, then preview_frames with a project at every text change and every zoom peak. Fix overlaps, cut-off text and unreadable contrast before rendering. Then a draft render.

Ask the user for anything you cannot see: brand colors, the URL, the one message the ad must land.`

const CINEMATIC = `Recipe: cinematic launch film (dark, calm, premium; modeled on Luma's launch ad)

Look
- set_output look "cinematic", background #07080A, gradient #141821 (or a dark tone of the brand color).
- Title cards are main clips with media "blank" and a glow: {"media":"blank","duration":3,"glow":"#9FB6CF"}.
- Text is quiet: style "statement" (thin, white, no box), centered, one line at a time, at most 6 words. The product name uses style "title" only on the end card. Never highlight boxes, kickers or heavy outlines in this style.
- Text sits on dark: blank cards or dark footage. Never put white text over a light app screen; cut to a blank card for the line instead.

Structure (times from a 68s launch film; scale down for 15 to 30s)
1. Cold open (3 to 4s): blank card, one line with animation fade, e.g. a quote or a question.
2. Name (2s): the product name on a blank card, fade_black into and out of it.
3. The problem (4 to 10s): real moments of the struggle, 1.5 to 3s each, hard cuts, no text.
4. The turn: an extreme close-up of the app, fit "cover" with zoom 2.5 to 3.5 on the input field or button (like a macro shot), and the typed prompt as statement text with animation "typewriter", kept on screen across 2 or 3 cuts.
5. Working beat (1.5 to 2s): blank card with glow and a status line like "Listening…".
6. Results (6 to 15s): each result 1 to 2s. Overviews as fit "card" (scale 0.8) on the dark background; details as zoomed cover shots. blur transitions (0.3s) between screens, otherwise hard cuts.
7. Build (2 to 3s): 8 to 12 very short cuts (0.15 to 0.3s each) on the music's rise, the fastest part of the film.
8. End (4 to 5s): blank card with glow, product name (title, fade), then a 2 to 4 word tagline (statement) alone, fade_black out.

Rhythm: long calm holds at the start and end, fast in the middle. The contrast is what feels expensive.
Sound: a cinematic track that builds (soft pads, pulse, hit). Ask the user for one; cut the build on beats.

Example ops (9:16):
[
  {"op":"set_output","aspect":"9:16","background":"#07080A","gradient":"#141821","look":"cinematic"},
  {"op":"set_main","clips":[
    {"media":"blank","duration":3,"glow":"#9FB6CF"},
    {"media":"blank","duration":2.4,"glow":"#9FB6CF","transition":{"type":"fade_black","duration":0.5}},
    {"media":"m_x","shot":1,"moment":1,"fit":"cover","zoom":[{"at":0,"scale":2.8,"x":0.5,"y":0.3},{"at":2,"scale":3.1,"x":0.5,"y":0.3}],"transition":{"type":"fade_black","duration":0.4}},
    {"media":"m_x","shot":1,"moment":2,"fit":"card","card":{"scale":0.8},"transition":{"type":"blur","duration":0.3}},
    {"media":"blank","duration":4,"glow":"#9FB6CF","transition":{"type":"fade_black","duration":0.5}}
  ]},
  {"op":"add_text","text":"\u201cYour thoughts deserve better notes.\u201d","style":"statement","start":0.4,"end":2.9,"animation":"fade"},
  {"op":"add_text","text":"Echo","style":"title","start":3.1,"end":4.4,"animation":"fade"}
]
Add the end card text at the last clip's start (timeline_get shows it).`

const SCREEN_RECORDING = `Recipe: app or website demo from screen recordings (9:16, 12 to 20 seconds)

Material
- media_get lists each screen recording's moments: one per screen or step, with a note of what is on screen. Use {media, shot, moment} in clips to take exactly one step. preview_frames with media shows one frame per moment.

Frame
- set_output aspect 9:16, background and gradient from the app's colors (e.g. cream #F5EEE6 to warm #E3C9B3 for a light app; near-black #0E0E10 to #24242A for a dark app).
- Every screen clip: fit "card", card {scale 0.72, y 0.08} when a headline sits above it. The card frames the phone screen with rounded corners and a shadow, which reads as a polished product shot.

Structure
1. Hook (0 to 2s): the best-looking screen, slow push-in, headline at the top.
2. Steps (2 to 3s each, 3 or 4 of them): one moment each, punch-in on the tapped element, a short benefit line. To dwell on a result, follow the step with a freeze clip of the same moment ({media, shot, moment, freeze: 1.5}); speed cannot go below 0.1, freeze holds a frame as long as you like.
3. End card (2 to 2.5s): the app icon or home screen moment with a cta and the URL.

Example ops (one timeline_edit call):
[
  {"op":"set_output","aspect":"9:16","background":"#F5EEE6","gradient":"#E3C9B3"},
  {"op":"set_main","clips":[
    {"media":"m_x","shot":1,"moment":1,"fit":"card","card":{"scale":0.72,"y":0.08},"zoom":[{"at":0,"scale":1},{"at":2,"scale":1.08}]},
    {"media":"m_x","shot":1,"moment":2,"fit":"card","card":{"scale":0.72,"y":0.08},"transition":{"type":"smooth_left","duration":0.35},
     "zoom":[{"at":0,"scale":1},{"at":0.6,"scale":1.9,"x":0.5,"y":0.3},{"at":1.8,"scale":1.9,"x":0.5,"y":0.3},{"at":2.3,"scale":1}]}
  ]},
  {"op":"add_text","text":"VOICE NOTES","style":"kicker","position":"top","y":0.04,"start":0,"end":2,"color":"#B5483A"},
  {"op":"add_text","text":"Speak. Echo writes it.","style":"headline","font":"serif","position":"top","y":0.065,"start":0.2,"end":2,"animation":"words","color":"#1F1A17"},
  {"op":"add_text","text":"Polished by AI","style":"highlight","position":"bottom","start":2.3,"end":4.3,"animation":"zoom","background":"#B5483A","color":"#FFFFFF"}
]

Tips
- Trim each moment to the action: start just before the tap and end once the new screen has settled.
- Cut out loading spinners and keyboard typing, or speed them up 2x to 3x.
- Status bars and home screens leak private things; blur them.`

const PRODUCT_AD = `Recipe: product ad from B-roll (no speech)

- Hook with the hero shot (highest appeal, close-up, clean background), headline in display font.
- Sequence: hero, detail close-ups, product in use, lifestyle, hero again with cta. 1 to 2 seconds per shot, cut on music beats.
- Use media_search with what you need ("close-up of the bottle", "hands opening the box") and min_appeal 4.
- Give still or slow shots a gentle push (zoom 1 to 1.08). Use fit "cover" for full-frame shots; fit "card" for product renders on a plain background.
- Text: one benefit per shot, 2 to 4 words, rise or words animation. End with cta on a brand-colored box and the URL.
- Music is essential. edit_beat_montage lays clips on beats fast; refine after.`

const TALKING_HEAD = `Recipe: talking-head video (creator, founder, tutorial)

- edit_remove_fillers, then edit_remove_pauses (keep about 0.15s padding) for tight pacing.
- Captions on: set_captions karaoke or bold, 2 to 3 words per line in 9:16, highlight_color a brand color.
- Every 3 to 5 seconds change something: a punch-in (zoom 1.15 to 1.3 on the face, held for a sentence), B-roll overlay for what is being described, or a text callout.
- Hook: start on the most surprising sentence, even if it comes later; move it to the start with move_clip or a duplicate clip.
- Music low (volume 0.15 to 0.25, duck on).`

const MONTAGE = `Recipe: music montage

- Pick the track first; media_get detail full gives tempo, beats and downbeats.
- edit_beat_montage with the clips in story order; cuts land on beats (every 2 beats at fast tempos, every beat for energy peaks).
- Put the best shot on the first downbeat and the strongest drop. End on a held shot with a fade_black ending matching the music's end.
- Text sparingly: one headline at the start and the cta at the end.`

const TEXT = `Typography recipes

Styles: statement (thin, calm, no box; the cinematic style), headline (very large, for hooks), title (large), kicker (small spaced capitals above a headline), subtitle and caption (supporting lines), highlight (text on a solid box), cta (call to action box), lower_third (name strip), label (small tag).
Fonts: display (heavy, modern; default for headline, title, highlight, cta), light (thin and premium; default for statement), serif (elegant, editorial), sans (clean UI look).
Animations: words (word by word, best for headlines), rise (soft slide up), zoom (settles in), typewriter (letters), fade, pop.

Stacking a kicker over a headline: same position, kicker y 0.04, headline y 0.065 (top of a 9:16 frame). Start the headline 0.2s after the kicker.
Benefit line over a card: highlight at the bottom, background in the brand color, white text.
End card: title with the product name centered, cta below it (position bottom), both on the background.
Contrast: set color to a dark tone (#1F1A17) on light backgrounds; leave white over video.
Text over a light or busy screen (white app UIs): give it a box with background, which works on every style. #0B0B0FB3 is a 70% dark box for white text; a brand color box with white text reads at any size. size scales the style (0.8 smaller, 1.3 bigger). On box styles, color sets the letters and background sets the box.
Length: headlines 3 to 6 words, benefit lines up to 5 words, nothing longer than 2 lines in 9:16.
Check every text with preview_frames before rendering.`

export const GUIDE: Record<GuideTopic, string> = {
  principles: PRINCIPLES,
  cinematic: CINEMATIC,
  screen_recording: SCREEN_RECORDING,
  product_ad: PRODUCT_AD,
  talking_head: TALKING_HEAD,
  montage: MONTAGE,
  text: TEXT
}
