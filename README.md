# MIND sponsor relayer — VPS deploy

The relayer regenerates MIND's reply from the on-chain LM and commits each
exchange to the Backrooms contract, paying gas so wanderers need no wallet.

## What it needs
- Node 18+ (global `fetch`).
- The chainrom signer modules (bundled here under `vendor/` by `pack-relayer.sh`).
- `voice-deploy.json` (written by deploy-voice-rh.mjs — has voice+backrooms addrs, rpc, chainId).
- The sponsor private key, provided ONLY via `--key-file` or `$CHAINROM_KEY` (never commit it).

## Run
    node sponsor.mjs --key-file /root/mindkey.txt

Env:
    PORT=8788            # http port
    MIN_INTERVAL_MS=2500 # min gap between on-chain writes (fund protection)
    MAX_TX=0             # 0 = unlimited; set a cap to bound spend
    MURMUR_MS=0          # >0: MIND murmurs unprompted into "the hum" that often
    MAX_TEXT=240         # max chars accepted per message

## systemd unit (example) — /etc/systemd/system/mind-sponsor.service
    [Unit]
    Description=MIND sponsor relayer
    After=network-online.target

    [Service]
    WorkingDirectory=/opt/mind
    ExecStart=/usr/bin/node sponsor.mjs --key-file /root/mindkey.txt
    Environment=PORT=8788 MIN_INTERVAL_MS=2500
    Restart=always
    RestartSec=3

    [Install]
    WantedBy=multi-user.target

Put it behind TLS (Caddy/nginx) so the site can POST to https://sponsor.<domain>/say,
then set the page's ?relay= (or bake it into CFG.relay) to that URL.
