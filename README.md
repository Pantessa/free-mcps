# free-mcps — Yeetful's free MCP services

Free, **non-gated** MCP servers by [yeetful.com](https://yeetful.com). One
monorepo, many thin services, each deployed to its own subdomain over MCP
Streamable HTTP (`/mcp`) + SSE (`/sse`). No API keys, no payment gate — just
rate limiting.

These are the free siblings of
[x402-services](https://github.com/Pantessa/x402-services) (the x402-paid
fleet). Same architecture, same trust model, minus the 402:

- **Build, don't execute.** Services return quotes, data, and *buildable*
  transactions/typed-data the USER signs with their own wallet. No service
  ever holds a private key or submits value transfers on its own.
- **Clean paths.** `<service>.yeetful.com/mcp` — no `/api/mcp/mcp` doubling.
- **Discovery.** Every service serves free metadata at `/api/info`
  (`gated: false`).

## Services

| Service | What it does | Tools |
|---|---|---|
| `services/uniswap` | Uniswap v3 + v4 on Base, read directly over RPC: live quotes (QuoterV2, every fee tier), spot prices, pool state, deterministic swap-tx building (SwapRouter02 calldata + approve step + dry-run) | `quote`, `price`, `pool_info`, `build_swap`, `build_wrap`, `build_unwrap`, `convert_amount`, `read_contract` |
| `services/snapshot` | Snapshot DAO governance: browse spaces/proposals/votes, build the EIP-712 vote the user signs, relay the signed envelope to the sequencer | `list_proposals`, `get_proposal`, `list_votes`, `get_space`, `list_spaces`, `graphql_query`, `prepare_vote`, `submit_vote` |
| `services/hyperliquid` | Hyperliquid over the public API (read-only): perp + spot markets, orderbooks, candles, funding, per-address portfolio views (positions/balances/orders/fills/PnL), and real-time settlement watching over WebSocket | `markets`, `spot_markets`, `price`, `orderbook`, `candles`, `funding`, `portfolio`, `open_orders`, `fills`, `order_status`, `ledger`, `await_settlement`, `info_query` |
| `services/aave` | Aave v4 over the official AaveKit API (Ethereum hub-and-spoke): markets + reserves with live APYs/caps, per-address portfolio (positions, earned interest, health factor, borrowing power), wallet balances with best yield, activity history, health-factor previews, and construction-only supply/withdraw/borrow/repay/collateral-toggle transactions the USER signs | `markets`, `reserves`, `portfolio`, `balances`, `activities`, `preview`, `build_supply`, `build_withdraw`, `build_borrow`, `build_repay`, `build_collateral_toggle`, `check_transaction`, `graphql_query` |
| `services/cow` | CoW Protocol over the public order-book API (8 chains): swap quotes, EIP-712 order construction (swaps + LIMIT orders the USER signs — no keys held), signed-order submission + gasless cancellation, per-address order/trade/portfolio views, solver competition, and the official CoW docs bundled + searchable offline | `chains`, `quote`, `build_swap_order`, `build_limit_order`, `submit_order`, `cancel_orders`, `order_status`, `user_orders`, `user_trades`, `portfolio`, `native_price`, `solver_competition`, `api_get`, `docs_search`, `docs_page` |
| `services/lido` | Lido liquid staking on Ethereum, read directly over RPC + Lido's public APIs: protocol stats with live APR, per-address position views (stETH/wstETH balances, staked value in ETH + USD), earnings history from Lido's reward backend (lifetime rewards, average APR, daily rebase events), withdrawal-queue tracking with wait estimates, and construction-only stake/wrap/unwrap/withdraw-request/claim transactions the USER signs | `stats`, `position`, `earnings`, `withdrawals`, `convert`, `build_stake`, `build_wrap`, `build_unwrap`, `build_request_withdrawal`, `build_claim` |
| `services/near-intents` | Cross-chain swaps over the official NEAR Intents 1Click API (~190 assets, ~35 chains — USDC Base→Arbitrum, ETH→SOL, USDC→BTC…): dry-run quotes, then ONE unsigned deposit transfer the USER signs on any of 9 EVM origin chains; solvers deliver on the destination chain automatically, tracked to SUCCESS with explorer links. Every response narrates the flow step-by-step | `how_it_works`, `chains`, `tokens`, `quote`, `build_swap`, `submit_deposit_tx`, `check_status`, `await_completion` |
| `services/yeetful-tool-wallet` | **Internal Yeetful tool** (the `yeetful-tool-*` naming marks first-party utility MCPs, vs protocol wrappers): multichain wallet reads via Alchemy (9 top EVM chains — Ethereum, Base, Arbitrum, Optimism, Polygon, BNB, Avalanche, Scroll, Gnosis): USD-priced whole-wallet portfolios (spam filtered, returns a structured payload the Yeetful chat renders as a rich card), gas balances, precise token balances, recent transfers w/ scam-symbol flagging, and tx confirmation status — the fresh-data layer after any swap/transfer settles | `chains`, `portfolio`, `gas_balances`, `token_balance`, `recent_transactions`, `transaction_status` |
| `services/morpho` | Morpho (Blue) lending on Ethereum + Base against the canonical bytecode-verified singleton: market discovery with live supply/borrow APYs via the official Blue API (pinned on-chain fallback when it's down), per-address positions computed from on-chain state (supplied, collateral, debt with accrued interest, health factor), local health-factor previews, and construction-only lend/borrow/repay/withdraw transactions the USER signs — fails closed on balances, borrowing power, liquidity, and thin health factors | `markets`, `market_info`, `position`, `preview`, `build_lend`, `build_supply_collateral`, `build_borrow`, `build_repay`, `build_withdraw`, `build_withdraw_collateral` |

## Develop

```bash
pnpm install
pnpm typecheck && pnpm test        # all services
cd services/uniswap && pnpm dev    # one service on :3000
```

Env (all optional): `BASE_RPC_URL` (uniswap; defaults to viem's public Base
RPC), `SNAPSHOT_HUB_URL` / `SNAPSHOT_SEQUENCER_URL` (snapshot; default to the
public hub/sequencer), `HYPERLIQUID_API_URL` / `HYPERLIQUID_WS_URL`
(hyperliquid; default to mainnet, point at *.hyperliquid-testnet.xyz for
testnet), `COW_API_URL` (cow; defaults to https://api.cow.fi — point at
https://barn.api.cow.fi for staging), `AAVE_API_URL` (aave; defaults to
https://api.v4.aave.com/graphql — the official AaveKit API),
`ETH_RPC_URL` (lido; optional — overrides the default public mainnet RPC) plus
`LIDO_ETH_API_URL` / `LIDO_REWARD_API_URL` / `LIDO_WQ_API_URL` (lido; default
to Lido's public APIs),
`NEAR_INTENT_API_KEY` / `ONECLICK_API_URL` (near-intents; the 1Click JWT —
works without it but 1Click then adds a 0.2% keyless fee per swap — and the
API base, default https://1click.chaindefuser.com),
`ALCHEMY_API_KEY` (yeetful-tool-wallet; REQUIRED — all reads go through Alchemy),
`ETH_RPC_URL` / `BASE_RPC_URL` (morpho; optional — override the keyless
publicnode defaults per chain),
`RATE_LIMIT_PER_MINUTE` (default 60/IP).

## Shared kit

`packages/mcp-kit` (`@yeetful/mcp-kit`): `createCleanMcpHandler` (MCP route on
a clean path) + `createRateLimitProxy` (per-IP sliding-window limit — free
services have no 402 to throttle abuse, so this is the front door).
