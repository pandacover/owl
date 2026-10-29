# Handoff: move owl from Daytona to Cloudflare

Written 2026-10-27. Owl has only run on the Daytona test sandbox so far. The Cloudflare setup (`wrangler.jsonc`, `worker/`, `Dockerfile`) is in the code and passes the simulated Cloudflare end-to-end test, but it has never been deployed for real. Expect the first deploy to need a check or two.

## Why move

| | Daytona (now) | Cloudflare standard-4 (target) |
| --- | --- | --- |
| CPU and memory | 2 CPU, 4 GB | 4 vCPU, 12 GiB, 20 GB disk |
| When it runs | Always on | Wakes on request, sleeps after 15 min idle |
| Cost | About $0.17 an hour while on, even idle | $5 a month plan, plus usage past the included amount (see Cost) |
| Storage | Sandbox disk (10 GB) | R2 bucket, kept when the container sleeps |
| Speech and search | Workers AI over REST (needs `CF_API_TOKEN`) | Workers AI binding, no token |

The memory failures on Daytona came from the 4 GB limit. Big renders measured about 2.6 GB per piece there. On Cloudflare owl gives one render 4.5 GB (`OWL_RENDER_MEMORY_MB` in `worker/index.ts`), so pieces can be bigger and fewer.

The render stalls are a different problem and will happen on Cloudflare too, because both use the same FFmpeg 7 from Debian trixie. FFmpeg sometimes stops exactly one second before the end of a piece, even with 2 GB free. Owl now tells FFmpeg to finish when that happens and keeps the piece if every frame is there. In a test on 2026-10-27, the 1:30 shutter edit (222 cuts) took 263 seconds instead of 571, with no pieces redone. The render notes say "finished cleanly" when this happens.

## Steps

### 1. Get the code onto `main`

Cloudflare deploys the branch it watches, which defaults to `main`. All the work is on `feat/owl-v1` (PR #1).

- Merge PR #1 into `main`. Do not merge the `daytona` branch: it only adds the Daytona deploy script.
- Or, to test before merging, set the watched branch to `feat/owl-v1` in the Worker's **Settings**, then **Build**, after step 3.

### 2. Cloudflare account

1. Subscribe to **Workers Paid** ($5 a month). Containers are not on the free plan.
2. Open **R2 Object Storage**, then **Create bucket**, and name it `owl-media`. The name must match `wrangler.jsonc`.

### 3. Deploy from GitHub

1. Open **Workers & Pages**, then **Create**, then **Import a repository**, and pick `pandacover/owl`.
2. Keep the deploy command `npx wrangler deploy`. It builds the container image from the `Dockerfile` and rolls it out. No Docker on your side. The first deploy takes a few minutes.
3. If the Worker already exists (for example it was made by hand first), open it, then **Settings**, then **Builds**, then **Connect**, and pick `pandacover/owl` with branch `main`. Builds start only on a new push to `main`, so connecting alone does not deploy.

### 4. Secrets

Open the `owl` Worker, then **Settings**, then **Variables and Secrets**, and add:

- `OWL_TOKEN`: a new long random string (40 letters and numbers is good). Use a new one, not the Daytona token. It is the password in your MCP URL and signs download links.
- `ANTHROPIC_API_KEY`: your Anthropic key, for shot descriptions.

Not needed on Cloudflare: `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `OWL_PUBLIC_URL`, `DAYTONA_*`. The Worker passes its own address to the container.

Optional: `OWL_VISION_MODEL` is set to `claude-opus-5-5` in `wrangler.jsonc`. `claude-haiku-5-5` costs much less for big libraries.

### 5. Connect Claude

1. The MCP URL is `https://owl.<your-subdomain>.workers.dev/mcp/<OWL_TOKEN>`. The Worker's page shows the `workers.dev` address.
2. On claude.ai open **Customize**, then **Connectors**, then **+ Add**, then **Add custom connector**. Paste the URL and pick **No sign in**.
3. Remove or turn off the old Daytona connector so chats do not use both.

### 6. Check it works

Do these in a Claude chat with the new connector:

- [ ] `https://owl.<subdomain>.workers.dev/health` shows "owl is running".
- [ ] The first tool call works. It can take a while because the container starts on the first request.
- [ ] Get an upload link, upload a video with speech and a song. Both finish analysis, the video has a transcript (Workers AI) and shot descriptions (Anthropic key).
- [ ] Search by meaning finds a shot.
- [ ] A draft render and a final render both finish, and the download link plays.
- [ ] A long final with many cuts (like the 1:30 shutter edit) finishes. The render notes show each piece's peak memory.
- [ ] After 15 minutes idle, call `project_list`. The container wakes and the projects are still there (they live in R2).

If something fails, look at the Worker's **Logs** tab and the **Containers** page in the Cloudflare dashboard for the container's output.

### 7. Data from Daytona

Nothing moves over on its own. Projects, media and renders on Daytona stay on its disk, and the R2 bucket starts empty.

- Download any renders you want to keep before you delete the sandbox.
- Re-upload the source clips you still need through a new upload link. Old projects point at Daytona media ids, so rebuild them from the new uploads.

### 8. Shut down Daytona (after step 6 passes)

1. Delete the `owl` sandbox in the Daytona dashboard. It runs all the time and uses credit (about $0.17 an hour, around $120 a month if left on). This deletes its files.
2. Turn off the **Deploy to Daytona** workflow in the GitHub **Actions** tab, or delete the `daytona` branch.
3. Remove the GitHub secrets that only Daytona used: `DAYTONA_API_KEY`, `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `OWL_TOKEN`, `ANTHROPIC_API_KEY`. Also delete the `CF_API_TOKEN` itself in the Cloudflare dashboard (**My Profile**, then **API Tokens**).

## Cost

Prices from Cloudflare's docs on 2026-10-27.

Included each month with Workers Paid: 25 GiB-hours of memory, 375 vCPU-minutes and 200 GB-hours of disk. Memory and disk count the whole instance while it is awake. CPU counts only while it is busy.

For standard-4, past the included amount:

- Awake and idle: about $0.11 an hour (12 GiB of memory).
- Busy on all 4 CPUs (rendering): about $0.40 an hour.
- The included amount covers about 2 hours awake and about 1.5 hours of full CPU each month.

Example: 20 hours awake in a month, 5 of them rendering, is about $3 on top of the $5 plan.

Other services, all inside free amounts for normal use:

- R2: 10 GB storage free, then $0.015 per GB a month. Downloads are free.
- Workers AI: 10,000 neurons a day free. Whisper is about 47 neurons per audio minute, so about 200 minutes of speech a day for free.

To spend less, change `instance_type` in `wrangler.jsonc` to `standard-3` (2 vCPU, 8 GiB) and `OWL_RENDER_MEMORY_MB` in `worker/index.ts` to `3000`. Renders get slower.

## Good to know

- One container (`max_instances: 1`) does all the work. It wakes on the first request and sleeps after 15 minutes idle. Renders and analysis keep it awake until they finish.
- Upload and download links go through the Worker straight to R2, so they work while the container sleeps. Uploads are sent in 8 MB parts.
- The container disk is temporary. Owl keeps a cache there (up to 14 GB, `OWL_CACHE_MAX_GB`) and fills it again from R2 after a restart. The first render after a wake can be slower.
- A deploy goes live for the Worker first, then rolls out the new image. For a short time new Worker code can talk to the old container.
- Settings: [`wrangler.jsonc`](../wrangler.jsonc) (instance size, bucket, vision model) and the `envVars` in [`worker/index.ts`](../worker/index.ts) (render memory, sleep time).

## Sources

- [Containers pricing](https://developers.cloudflare.com/containers/pricing/)
- [Containers limits and instance types](https://developers.cloudflare.com/containers/platform-details/limits/)
- [Deploying containers](https://developers.cloudflare.com/containers/deploy/)
- [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
