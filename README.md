# MOOLANA HQ 🐄

Tokenomics dashboard + holder snapshot tool for **$MOOLANA** airdrops. Built for Railway.

## What it does
- **Live tokenomics** — price, market cap, liquidity, 24h volume (DexScreener), total supply and top-20 holders (Solana RPC), plus a top-10 concentration gauge.
- **Holder snapshots** — scans *every* wallet holding the token and saves a timestamped list.
- **Airdrop exports** — download any snapshot as CSV (`wallet,balance`), with a min-balance filter to cut dust wallets.
- **Compare vs now** — see who still holds since a snapshot (your diamond-hand / loyalty tier), who exited, and how many new wallets joined.

## Deploy on Railway
1. Push this folder to a GitHub repo.
2. In Railway: **New Project → Deploy from GitHub repo** → pick the repo. Railway auto-detects Node and runs `npm start`.
3. Add variables (Project → Variables):

| Variable | Required | Notes |
|---|---|---|
| `MINT_ADDRESS` | no | Defaults to the $MOOLANA CA. Change to track any SPL token. |
| `HELIUS_API_KEY` | **strongly recommended** | Free tier at helius.dev. Public Solana RPC blocks full-holder scans and rate-limits hard; snapshots basically require this. |
| `RPC_URL` | no | Any custom RPC endpoint. Overrides the Helius/public default. |
| `DATA_DIR` | no | Where snapshot JSONs are stored. Point at a mounted volume path. |

4. **Add a Volume** (Railway → service → Volumes) mounted at `/data`, and set `DATA_DIR=/data`.
   Without a volume, snapshots are wiped on every redeploy since Railway's filesystem is ephemeral.
5. Generate a domain (Settings → Networking → Generate Domain). Done.

## Run locally
```bash
npm install
HELIUS_API_KEY=your_key npm start
# open http://localhost:3000
```

## Excluding bundle / dev / LP wallets
Use the **Exclude bundle wallets** panel to keep snipers and pools out of the airdrop:
- Paste addresses into the blocklist (one per line) and **Save** — they're skipped in every CSV export and in the loyalty count of *Compare vs now*. Snapshots themselves stay a raw record, so the list can change anytime.
- **Auto-detect launch bundle** scans the token's earliest slots for wallets that bought at launch and lets you tick which to add. Best-effort (needs `HELIUS_API_KEY`), not a full indexer — cross-check against **trench.bot** / pump.fun's bundled % for the authoritative map.

API: `GET/POST /api/excluded`, `POST /api/excluded/add`, `GET /api/bundle-scan`. CSV honors the blocklist by default; add `?raw=1` to export everyone.

## Airdrop workflow
1. Take a snapshot **before** announcing anything (quiet snapshots stop farm-and-dump).
2. Build your blocklist (auto-detect the launch bundle, add known LP/CEX wallets).
3. Set your min balance (e.g. 1000) and Export CSV — bundle wallets are already filtered out; that's your send list.
4. Later, hit **Compare vs now** — wallets still holding (minus the blocklist) are your loyalty tier for bonus allocations.

## Notes
- Snapshot scan time scales with holder count; thousands of holders can take a minute+.
- Top-holder list includes LP and exchange token accounts — read with context.
