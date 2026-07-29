# Deploying the free MCPs (Vercel)

Each service deploys as its own Vercel project, same pattern as x402-services.
The website directory rows are already seeded on Neon pointing at these hosts:

| Service | Vercel root directory | Domain (seeded in DB) |
|---|---|---|
| uniswap | `services/uniswap` | `uniswap-mcp.yeetful.com` |
| snapshot | `services/snapshot` | `snapshot-mcp.yeetful.com` |
| hyperliquid | `services/hyperliquid` | `hyperliquid-mcp.yeetful.com` (not yet deployed/seeded) |
| cow | `services/cow` | `cow-mcp.yeetful.com` (not yet deployed/seeded) |
| aave | `services/aave` | `aave-mcp.yeetful.com` (not yet deployed/seeded) |
| near-intents | `services/near-intents` | `near-intents-mcp.yeetful.com` (not yet deployed/seeded) |
| yeetful-tool-wallet | `services/yeetful-tool-wallet` | `wallet-mcp.yeetful.com` (not yet deployed/seeded) |
| lido | `services/lido` | `lido-mcp.yeetful.com` (not yet deployed/seeded) |
| robinhood | `services/robinhood` | `robinhood-mcp.yeetful.com` (not yet deployed/seeded) |
| opensea | `services/opensea` | `opensea-mcp.yeetful.com` (not yet deployed/seeded) |
| morpho | `services/morpho` | `morpho-mcp.yeetful.com` (not yet deployed/seeded) |

## Steps (per service, ~3 min)

1. Vercel → Add New Project → import `Yeetful/free-mcps`.
2. **Root Directory**: `services/uniswap` (or `services/snapshot`). Framework:
   Next.js (auto). Build command / install: defaults (Vercel detects pnpm
   workspaces from the repo root).
3. Env vars — all optional:
   - `BASE_RPC_URL` (uniswap only, **recommended for prod** — the public Base
     RPC rate-limits; use an Alchemy/QuickNode URL)
   - `NEAR_INTENT_API_KEY` (near-intents only, **recommended for prod** — the
     1Click JWT; without it 1Click adds a 0.2% keyless fee to every swap.
     Same value as `NEAR_INTENT_API_KEY` in website/.env.local.)
   - `ALCHEMY_API_KEY` (yeetful-tool-wallet only, **REQUIRED** — same value as website/.env.local)
   - `ETH_RPC_URL` (lido + robinhood, **recommended for prod** — defaults to
     the public `ethereum-rpc.publicnode.com`; use an Alchemy/QuickNode
     mainnet URL under load. robinhood only uses it for bridge-deposit
     balance checks)
   - `ALCHEMY_API_KEY` (robinhood, **recommended for prod** — upgrades the
     chain-4663 RPC from the rate-limited public endpoint to Alchemy's
     `robinhood-mainnet`; `ROBINHOOD_RPC_URL` overrides both)
   - `ETH_RPC_URL` + `BASE_RPC_URL` (morpho, **recommended for prod** —
     default to the keyless publicnode endpoints; use Alchemy/QuickNode URLs
     under load)
   - `OPENSEA_API_KEY` (opensea, **REQUIRED** — every read + the listing
     relay goes through api.opensea.io; same value as `OPENSEA_API_KEY` in
     website/.env.local. `ETH_RPC_URL`/`BASE_RPC_URL`/`ARBITRUM_RPC_URL`
     optional overrides for the publicnode defaults.)
   - `RATE_LIMIT_PER_MINUTE` (default 60/IP)
4. Deploy, then add the custom domain above (Settings → Domains; DNS CNAME →
   `cname.vercel-dns.com`).
5. Smoke: `curl https://uniswap-mcp.yeetful.com/api/info` → `"gated": false`,
   then a live tools/list:
   ```bash
   curl -s -X POST https://uniswap-mcp.yeetful.com/mcp \
     -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -o '"name":"[a-z_]*"'
   ```

## Local dev against localhost

Both services are DEPLOYED and live (2026-07-03) — prod chat calls them
directly. To develop against local copies instead, in `website/.env.local`:

```
FREE_MCP_URL_OVERRIDES={"uniswap-mcp.yeetful.com":"http://localhost:3261","snapshot-mcp.yeetful.com":"http://localhost:3262","cow-mcp.yeetful.com":"http://localhost:3263","aave-mcp.yeetful.com":"http://localhost:3266","near-intents-mcp.yeetful.com":"http://localhost:3268","wallet-mcp.yeetful.com":"http://localhost:3269","lido-mcp.yeetful.com":"http://localhost:3270","robinhood-mcp.yeetful.com":"http://localhost:3271","opensea-mcp.yeetful.com":"http://localhost:3272","morpho-mcp.yeetful.com":"http://localhost:3274"}
```

and run the services locally (`next start -p 3261` in services/uniswap,
`-p 3262` in services/snapshot, `-p 3263` in services/cow, `-p 3266` in
services/aave, `-p 3268` in services/near-intents, `-p 3269` in
services/yeetful-tool-wallet, `-p 3270` in services/lido, `-p 3271` in
services/robinhood, `-p 3272` in services/opensea, `-p 3274` in
services/morpho), or run the
standing proof: `npx tsx scripts/test-free-mcps-live.ts` (in website/, env as
above).

Note (cow): the searchable docs corpus (`services/cow/lib/docs-data.json`) is
COMMITTED — regenerate with `pnpm build-docs` in services/cow (downloads
github.com/cowprotocol/docs) and commit the result; the deploy needs no
network/build step for it.
