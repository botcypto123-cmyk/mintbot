# MintBot v3

Telegram NFT mint bot. Auto-mints, Gas War mode, Flashbots, multi-wallet blast, mempool watching, multi-RPC fallback, top offer alerts, rarity snipe, sale detection, OpenSea listing, leaderboard, trending, and a transparent 5% profit-only fee system.

## Files in this repo

| File | What it is |
|---|---|
| `index.js` | The entire bot — 1,500+ lines, single process |
| `package.json` | Dependencies |
| `.env.example` | Every environment variable with descriptions |
| `DEPLOY.md` | Full step-by-step deployment guide |
| `MintRegistry.sol` | On-chain mint price recorder (deploy on ETH + Base) |
| `FeeRouter.sol` | Fee splitter contract (deploy on ETH + Base) |

## Quick start (local)

```bash
npm install
cp .env.example .env
# Fill in .env
npm start
```

Generate encryption key:
```bash
openssl rand -hex 32
```

## Deploy to Railway

See `DEPLOY.md` for the complete step-by-step. The short version:

1. Push this repo to GitHub (private)
2. New Railway project → Deploy from GitHub repo
3. Add all variables from `.env.example` in Railway Variables tab
4. Add a Railway Volume mounted at `/data`
5. Deploy

## Smart contracts

Deploy `MintRegistry.sol` and `FeeRouter.sol` on both Ethereum mainnet and Base using [Remix](https://remix.ethereum.org). Paste the four resulting addresses into your Railway env vars. Full instructions in `DEPLOY.md`.

## Keyboard

```
Track  |  Wallet
Status |  Gas  |  History
```

## Start screen inline buttons

⚡ Instant Mint · 📊 Track a Drop
📤 Send NFT · 📥 Receive
🏆 Leaderboard · 🔥 Trending
💣 Blast Mint

## Commands

| Command | What it does |
|---|---|
| `/start` | Dashboard |
| `/track` | Track a drop |
| `/wallet` | Wallet management |
| `/status` | Active mints + instant fire buttons |
| `/gas` | Gas prices + Gas War toggle |
| `/history` | Mint history and P&L |
| `/trending` | Hot collections on OpenSea |
| `/blast` | Fire from all wallets simultaneously |
| `/reset` | Clear any stuck input state |
| `/setwallet` | Import a wallet private key |
| `/stats` | Admin only — usage data and unhandled interactions |

## Mint confirmation card toggles

- Reminders on/off
- Auto-mint on/off  
- Gas War mode on/off (escalates gas per retry)
- Flashbots on/off (private mempool)
- Set gas cap
- Set target list price
- Set profit alert level

## Fee system

Disclosed at every mint confirmation. Bot takes 5% of profit only when an NFT is sold above mint price. Nothing on losses or break-even.

- **Base**: collected automatically after sale is detected
- **Ethereum**: stored as pending, bundled into the next mint transaction to save gas. User is notified with the exact amount.

## Supported chains

Ethereum mainnet and Base mainnet. Set both `ETHEREUM_RPC_URL` and `BASE_RPC_URL` to run dual-chain.

## Required env vars

```
TELEGRAM_BOT_TOKEN
WALLET_ENCRYPTION_KEY
ETHEREUM_RPC_URL
BASE_RPC_URL
```

## Recommended env vars

```
ETHERSCAN_API_KEY     — ABI resolution for mint function detection
OPENSEA_API_KEY       — Collection lookup, trending, top offer, rarity, listings
TREASURY_WALLET       — Your wallet address to receive the 5% fee
ADMIN_USER_ID         — Your Telegram user ID for /stats access
```

See `.env.example` for the full list including fallback RPCs, smart contract addresses, and tuning parameters.
