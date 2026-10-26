# owl

owl is a video editor built for AI agents. It runs as a remote MCP server: you connect it to Claude, give Claude your footage, and ask for the edit you want. Claude drives owl's tools; owl does the heavy work (analysis and rendering with FFmpeg) in the cloud and hands back links to finished MP4s.

It is written in TypeScript with [Effect](https://effect.website) and runs on Cloudflare (a Worker in front, one Container for the work, R2 for storage).

## What Claude can do with it

- **Bring in media.** Upload from a phone through a link Claude gives you, or import from a URL (direct links, Google Drive and Dropbox share links).
- **Understand footage, with or without speech.** Every file is analyzed in the background:
  - shots (cut detection) with a description of each shot by Claude vision: subjects, setting, shot type, camera motion, on-screen text, tags and an appeal score;
  - speech transcript with word timings (Whisper on Workers AI);
  - music tempo, beats, downbeats and accents, plus quiet parts and loudness.
  
  A product ad or B-roll with no voice is still fully searchable by what it shows.
- **Find material** by meaning ("close-up of the bottle on a table", "when she mentions the price") and look at frames.
- **Edit a timeline**: a magnetic main track (clips play back to back, gaps close), B-roll and picture-in-picture overlays, music and sound effects (ducked under speech), titles, lower thirds, call-to-action text, burned-in captions (four styles, including word-by-word karaoke), transitions, speed, any frame shape (16:9, 9:16, 1:1, 4:5). Every change is undoable.
- **Smart edits**: remove pauses, remove filler words, and cut a montage on the beat of a song.
- **See and render**: frames of the edit exactly as it will render, fast draft renders to check, and full-quality final renders with loudness normalization.

### Tools

| Tool | What it does |
| --- | --- |
| `media_upload_link` | Link to an upload page for the user (any size, resumable parts) |
| `media_import` | Import from a URL |
| `media_list`, `media_get`, `media_transcript`, `media_delete` | Inspect media and analysis |
| `media_search` | Search shots and speech by meaning |
| `preview_frames` | Frames of a source file, or of the edit as rendered |
| `project_create`, `project_list` | Projects |
| `timeline_get`, `timeline_edit`, `timeline_undo` | Read and change the edit (batched, atomic operations) |
| `edit_remove_pauses`, `edit_remove_fillers`, `edit_beat_montage` | Smart edits |
| `render_start`, `render_status` | Draft and final renders with download links |
| `edit_guide` | Editing recipes the agent reads before building (principles, screen recordings, product ads, talking heads, montages, text) |

Looks the timeline supports: framed cards on a gradient background with rounded corners and a shadow, keyframed zoom and pan, headline, kicker and highlight text styles in display, serif or sans fonts (bundled in `assets/fonts`, OFL), word by word and typewriter text, blur regions for private details, and slide and circle transitions. Screen recordings are split into moments, one per screen or step.

Tool results are compact text (and images for frames) written for an agent to read: ids first, times as `m:ss.s`, and errors that say what to do next.

## Set up on Cloudflare (works from a phone)

You need a Cloudflare account on the Workers Paid plan, and an Anthropic API key for shot descriptions.

1. **Create the storage bucket.** In the Cloudflare dashboard open **R2 Object Storage**, then **Create bucket**, and name it `owl-media`.
2. **Deploy from GitHub.** Open **Workers & Pages**, then **Create**, then **Import a repository**. Pick this repository. Keep the deploy command `npx wrangler deploy`: it builds the container image from the `Dockerfile` and rolls it out (no Docker needed on your side). The first deploy takes a few minutes.
3. **Add two secrets.** Open the new `owl` Worker, then **Settings**, then **Variables and Secrets**, and add:
   - `OWL_TOKEN`: a long random string of letters and numbers (for example 40 characters from a password generator). It works like a password: it is part of your MCP URL.
   - `ANTHROPIC_API_KEY`: your Anthropic API key. Without it owl still works, but shots get no descriptions.
4. **Find your MCP URL.** It is `https://owl.<your-subdomain>.workers.dev/mcp/<OWL_TOKEN>`. The Worker's page shows the `workers.dev` address.
5. **Connect Claude.** On claude.ai (a phone browser works) open **Customize**, then **Connectors**, then **+ Add**, then **Add custom connector**. Name it `owl`, paste the MCP URL, and pick **No sign in** (the token in the URL is the key). Then turn it on in a chat from the tools menu. Connectors run from Anthropic's cloud, so they work in every Claude app.

Try: *"Give me an upload link"*, upload a few clips, then *"Make a 20 second vertical ad from these clips, cut to the beat of the song, with a title and a call to action at the end."*

The container starts on the first request (this can take a little while) and goes to sleep after 15 minutes without activity. Long renders keep it awake until they finish. Everything is stored in R2, so nothing is lost when it sleeps.

### Testing without Cloudflare

To try owl before Cloudflare is ready, the `daytona` branch can deploy it to a Daytona sandbox. See [DAYTONA.md](DAYTONA.md).

### Choosing the vision model

Shot descriptions use `claude-opus-5-5` by default, with server-side fallback enabled. For large libraries, `claude-haiku-5-5` costs much less. Change `OWL_VISION_MODEL` in `wrangler.jsonc` (or in the dashboard) to switch.

## How it fits together

```
Claude ──MCP──▶ Worker ──▶ owl container (Node, Effect, FFmpeg)
                  │  ▲              │
   upload page ───┤  └─ owl.r2 ─────┤  R2 bucket: media, proxies, analysis,
   download links ┘     owl.ai ─────┤  projects, renders
                        owl.ctl ────┘  Workers AI: Whisper, embeddings
```

- The Worker serves the upload page and signed download links straight from R2, and forwards `/mcp/<token>` to the container.
- The container reaches R2, Workers AI and the Worker through outbound handlers on virtual hosts, so it holds no Cloudflare credentials.
- Analysis runs one FFmpeg decode per file that writes the editing proxy, scene-change scores, audio for beat tracking and audio for speech at the same time. Beat tracking runs in a worker thread.
- Rendering builds one FFmpeg filter graph per render. Each clip is a seeked input, so only the used parts of each file are decoded, and the result is encoded once. Draft renders use the 960px proxies.

Code map: `src/services` (storage, analysis, search, projects, renderer), `src/timeline` (the edit model and smart edits), `src/render` (FFmpeg graph and subtitles), `src/mcp` (tools and agent-facing text), `worker` (Cloudflare Worker).

## Run locally

Needs Node 22.18 or newer and FFmpeg.

```sh
npm install
OWL_TOKEN=dev npm start
# MCP endpoint: http://localhost:8080/mcp/dev
```

Locally, files are stored in `./.data`. Transcription and embeddings need Workers AI: set `CF_ACCOUNT_ID` and `CF_API_TOKEN` to use the REST API. Set `ANTHROPIC_API_KEY` for shot descriptions.

## Tests

```sh
npm run check      # types for the server, the Worker and the tests
npm test           # unit tests
npm run test:e2e   # makes sample media, then drives the real server over MCP
```

The end-to-end suite includes a simulation of the Cloudflare deployment: the Worker's real handlers run against an in-memory R2 bucket and fake Workers AI and Claude APIs, the server runs in R2 mode, and the test restarts it with an empty disk to check that nothing is lost.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OWL_TOKEN` | required | Secret in the MCP path and key for signed links |
| `ANTHROPIC_API_KEY` | none | Enables shot descriptions |
| `OWL_VISION_MODEL` | `claude-opus-5-5` | Model for shot descriptions |
| `OWL_STORAGE` | `local` | `r2` inside the Cloudflare container |
| `OWL_DATA_DIR` | `./.data` | Local storage folder |
| `OWL_CACHE_DIR` | system temp | Working files and the R2 download cache |
| `OWL_CACHE_MAX_GB` | `14` | Cache size limit |
| `CF_ACCOUNT_ID`, `CF_API_TOKEN` | none | Workers AI over REST when running outside Cloudflare |
| `OWL_TRANSCRIBE_MODEL` | `@cf/openai/whisper-large-v3-turbo` | Speech to text model |
| `OWL_EMBEDDING_MODEL` | `@cf/baai/bge-m3` | Search embeddings |
| `OWL_ANALYSIS_CONCURRENCY` | `2` | Files analyzed at once |
| `OWL_RENDER_CONCURRENCY` | `1` | Renders at once |
| `PORT` | `8080` | HTTP port |

## License

Apache-2.0
