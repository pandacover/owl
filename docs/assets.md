# Creative assets

owl's playbook (edit_guide "playbook") pairs looks, transitions, fonts and sounds by mood. Everything in it is free to use in commercial videos. This page says where each part comes from and under what license, checked on 2026-10-28.

## Looks and transitions

Built by owl from FFmpeg filters in `src/render/graph.ts`. No outside files, nothing to license.

- 12 looks: cinematic, warm, clean, mono, film, teal_orange, bleach, noir, golden, night, pastel, vivid.
- 21 transitions, including whip_left/right/up/down (a motion-blurred push), light_leak (a warm light over a dissolve) and glitch (RGB-split slices). The extra filters run only on the overlap frames.

## Fonts

Eight families bundled in `assets/fonts`, all under the SIL Open Font License 1.1. The OFL allows bundling fonts with software under another license (OFL FAQ 1.3) and using them for video titling; videos made with them are not covered by the OFL (FAQ 1.1.1, 1.13). See `assets/fonts/README.md` for files and sources.

## Sound effects

33 hand-picked sounds from the free Sonniss #GameAudioGDC bundles (2023, 2024, 2026), listed in `src/domain/Stock.ts` and shown to the agent in edit_guide "sounds".

License (https://sonniss.com/gdc-bundle-license/): royalty free, commercial use, no attribution required, unlimited projects; the sounds may be copied and distributed but not sold as they are. The bundle page also forbids using them to train AI or machine learning models. owl only places them in edits.

The files are not in this repository. `media_import {"stock": "<name>"}` downloads one from the bundle's copy on the Internet Archive (`archive.org/download/sonniss-gdc-<year>-game-audio-bundle-normalized/...`) the first time it is used. After that it is an ordinary media item in storage, and later imports of the same name return it.

## Music

Not bundled. Free music that sounds premium is rare, so music comes from the user's own tracks (the upload page or media_import). Pixabay's Content License allows its tracks in commercial videos with no credit, but not standalone redistribution, so a Pixabay track should be uploaded by the user for their edit, not added to this repository.

Ruled out: Uppbeat's free plan (credit required, social platforms only), the YouTube Audio Library (many tracks are YouTube only) and the Epidemic Sound API free tier (prototyping only).
