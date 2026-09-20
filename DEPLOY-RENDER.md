# Deploy the MIND sponsor to Render (free, automatic HTTPS)

The relayer regenerates MIND's reply from the on-chain LM and writes each
exchange to the Backrooms, paying gas. On Render it gets an https URL the
public site can POST to, and the private key stays an encrypted secret.

## Steps
1. Go to https://render.com and sign up (GitHub login is easiest).
2. **New +  →  Blueprint**. Connect the `Bubbleduck10/mind-sponsor` repo.
   Render reads `render.yaml` and proposes a web service called `mind-sponsor`.
3. It will ask for the value of **CHAINROM_KEY** (marked "sync: false" = secret).
   Paste the sponsor private key (the 0xe301… wallet). It is stored encrypted,
   never shown in logs, never in the repo.
4. Click **Apply / Create**. First build takes ~2 min.
5. When it's live, copy the service URL — looks like
   `https://mind-sponsor.onrender.com`. Test it: open `<url>/health` in a browser,
   you should see `{"ok":true,...}`.
6. Tell me that URL and I'll wire the site's `relay` to it + push. Done — the
   backrooms starts remembering.

## Notes
- **Free tier sleeps** after ~15 min idle and cold-starts (~30–60s) on the next
  message. Fine for a novelty; upgrade to Starter ($7/mo) for always-on + the
  unprompted "murmur" loop (set MURMUR_MS to e.g. 3600000).
- The service listens on Render's injected `$PORT` automatically.
- To rotate the key later: Render dashboard → Environment → edit CHAINROM_KEY → redeploy.
