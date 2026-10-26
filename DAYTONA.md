# Test owl on Daytona

This branch can run owl in a [Daytona](https://www.daytona.io) sandbox, for trying the editor while Cloudflare is not set up. Cloudflare stays the main host.

A GitHub Action does the deploy, so everything works from a phone browser.

## Setup

1. **Get a Daytona API key.** Sign up at [app.daytona.io](https://app.daytona.io) (new accounts get free credit, no card needed). Open **API Keys** and create a key.
2. **Add secrets to this repository.** On GitHub open **Settings**, then **Secrets and variables**, then **Actions**, then **New repository secret**, and add:
   - `DAYTONA_API_KEY`: the key from step 1.
   - `OWL_TOKEN`: a long random string of letters and numbers (at least 16). It is part of your MCP URL, so treat it like a password.
   - `ANTHROPIC_API_KEY`: optional, for shot descriptions.
   - `CF_ACCOUNT_ID` and `CF_API_TOKEN`: optional, for speech transcripts and search by meaning (Workers AI). The token needs the Workers AI permission.
3. **Deploy.** Open the **Actions** tab, pick **Deploy to Daytona**, open the latest run and tap **Re-run all jobs**. The first deploy builds the sandbox with FFmpeg and takes a few minutes. Later pushes to the `daytona` branch deploy on their own.
4. **Get the MCP URL.** The run's summary shows it: `https://8080-<sandbox>.<daytona-domain>/mcp/<OWL_TOKEN>`.
5. **Connect Claude.** On claude.ai open **Customize**, then **Connectors**, then **+ Add**, then **Add custom connector**. Paste the MCP URL and pick **No sign in**.

## Good to know

- The sandbox stays on (auto-stop is off) so Claude can always reach it. It uses credit while on: about $0.17 an hour at the default 2 CPUs and 4 GB. Stop or delete it in the Daytona dashboard when you are done testing.
- Files are stored on the sandbox disk (10 GB). They survive redeploys. To start fresh, delete the sandbox in the Daytona dashboard and re-run the workflow.
- The first time you open an upload or download link in a browser, Daytona shows a preview warning page. Continue past it once.
- Daytona's lower tiers only allow some outside sites. Claude and Cloudflare are allowed. Google Drive and Dropbox links may not import, so use the upload link instead.
- To change settings later, update the secrets and re-run the workflow.
