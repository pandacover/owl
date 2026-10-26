/**
 * Editing know-how for the agent, served by the edit_guide tool. Kept out of
 * the server instructions so it costs nothing until the agent asks for it.
 */

export const GUIDE_TOPICS = ["principles", "screen_recording", "product_ad", "talking_head", "montage", "text"] as const
export type GuideTopic = typeof GUIDE_TOPICS[number]

const PRINCIPLES = `Premium edit principles (read before building any edit)

Hook
- The first 1.5 seconds decide everything. Open on the strongest visual with a 3 to 6 word headline. No logo intro, no slow fade from black.

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
- Default to hard cuts. Use smooth_left or smooth_up (0.3 to 0.4s) to move between app steps. Avoid crossfades between UI screens; they look muddy. fade_black only at the very end.

Sound
- A premium edit has music. If the user has no track, ask for one (they can upload it with media_upload_link) before the final render, and say why. Cut on beats (media_get detail full lists beat times; edit_beat_montage does it automatically).

Ending
- End card for 2 to 2.5 seconds: product name, one call to action (cta style) and the URL or handle.

Checking
- After building: timeline_get, then preview_frames with a project at every text change and every zoom peak. Fix overlaps, cut-off text and unreadable contrast before rendering. Then a draft render.

Ask the user for anything you cannot see: brand colors, the URL, the one message the ad must land.`

const SCREEN_RECORDING = `Recipe: app or website demo from screen recordings (9:16, 12 to 20 seconds)

Material
- media_get lists each screen recording's moments: one per screen or step, with a note of what is on screen. Use {media, shot, moment} in clips to take exactly one step. preview_frames with media shows one frame per moment.

Frame
- set_output aspect 9:16, background and gradient from the app's colors (e.g. cream #F5EEE6 to warm #E3C9B3 for a light app; near-black #0E0E10 to #24242A for a dark app).
- Every screen clip: fit "card", card {scale 0.72, y 0.08} when a headline sits above it. The card frames the phone screen with rounded corners and a shadow, which reads as a polished product shot.

Structure
1. Hook (0 to 2s): the best-looking screen, slow push-in, headline at the top.
2. Steps (2 to 3s each, 3 or 4 of them): one moment each, punch-in on the tapped element, a short benefit line.
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

Styles: headline (very large, for hooks), title (large), kicker (small spaced capitals above a headline), subtitle and caption (supporting lines), highlight (text on a solid box), cta (call to action box), lower_third (name strip), label (small tag).
Fonts: display (heavy, modern; default for headline, title, highlight, cta), serif (elegant, editorial), sans (clean UI look).
Animations: words (word by word, best for headlines), rise (soft slide up), zoom (settles in), typewriter (letters), fade, pop.

Stacking a kicker over a headline: same position, kicker y 0.04, headline y 0.065 (top of a 9:16 frame). Start the headline 0.2s after the kicker.
Benefit line over a card: highlight at the bottom, background in the brand color, white text.
End card: title with the product name centered, cta below it (position bottom), both on the background.
Contrast: set color to a dark tone (#1F1A17) on light backgrounds; leave white over video.
Length: headlines 3 to 6 words, benefit lines up to 5 words, nothing longer than 2 lines in 9:16.
Check every text with preview_frames before rendering.`

export const GUIDE: Record<GuideTopic, string> = {
  principles: PRINCIPLES,
  screen_recording: SCREEN_RECORDING,
  product_ad: PRODUCT_AD,
  talking_head: TALKING_HEAD,
  montage: MONTAGE,
  text: TEXT
}
