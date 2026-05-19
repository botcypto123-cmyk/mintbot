# MintBot

Telegram NFT mint tracker with controlled setup, inline confirmation, encrypted wallet storage, reminders, phase-specific auto-mint timers, and retry polling.

## What It Does

- Users paste an OpenSea mint URL.
- The bot verifies phase time and price through contract reads when exposed by the mint contract.
- The bot sends a confirmation card with Confirm / Cancel and toggles for reminders and auto-mint.
- Nothing is armed until the user confirms.
- Each user gets a timer for the phase they are eligible for: GTD, OG, WL, or public.
- Auto-mint fires 5 seconds after that phase opens, then the 30-second poller retries during the configured retry window.
- Wallets can be created or imported from Telegram.
- Private keys are encrypted at rest with `WALLET_ENCRYPTION_KEY`.
- Gas, portfolio, trending, status, and mint history menu actions are included.
- Gas caps are approved per mint before confirmation.
- Gas War mode escalates retry gas while respecting the user's cap.
- Instant Mint, Receive, Send NFT, Send Token, leaderboard, and admin stats are included.
- PostgreSQL storage is supported through `DATABASE_URL`; JSON remains a local development fallback.
- A transparent profit-fee disclosure is shown before mint confirmation.

## Security Notes

This bot can submit real blockchain transactions. Use a fresh mint wallet only.

Do not run this with your main wallet. Keep only the ETH needed for the mint and gas in the wallet. The bot deletes private-key Telegram messages after import, but Telegram delivery is still not the same as a hardware wallet or local signer.

Private keys are encrypted in `data/mintbot.json`, but whoever controls the server and `.env` can decrypt them. Treat the server as sensitive infrastructure.

## Setup

```bash
cd /home/khalex/mintbot
npm install
cp .env.example .env
```

Edit `.env`:

```bash
TELEGRAM_BOT_TOKEN=...
ETHEREUM_RPC_URL=...
BASE_RPC_URL=...
WALLET_ENCRYPTION_KEY=...
ETHERSCAN_API_KEY=...
OPENSEA_API_KEY=...
DATABASE_URL=...
ADMIN_USER_ID=...
TREASURY_WALLET=...
```

Generate an encryption key:

```bash
openssl rand -hex 32
```

Start the bot:

```bash
npm start
```

## Deploy To Railway From GitHub

1. Create a GitHub repo and push this `mintbot` folder.
2. In Railway, create a new project from the GitHub repo.
3. Add the environment variables from `.env.example` in Railway Variables.
4. Add a Railway volume if you want wallets/mints/history to survive redeploys.
5. Deploy.

This repo includes:

- `railway.json` with `npm start` as the start command
- `Procfile` with a worker process
- `.dockerignore` so local secrets and installs are not uploaded
- `.gitignore` so `.env`, `node_modules`, and runtime JSON data stay out of GitHub
- `contracts/` with `MintRegistry.sol` and `FeeRouter.sol` sources for Ethereum/Base deployment

For persistent storage, attach a Railway volume to the service. The bot automatically uses `RAILWAY_VOLUME_MOUNT_PATH/mintbot.json` when Railway provides that variable. You can also set `DATA_FILE` manually.

Required Railway variables:

```bash
TELEGRAM_BOT_TOKEN=...
ETHEREUM_RPC_URL=...
BASE_RPC_URL=...
WALLET_ENCRYPTION_KEY=...
ETHERSCAN_API_KEY=...
OPENSEA_API_KEY=...
DATABASE_URL=...
ADMIN_USER_ID=...
TREASURY_WALLET=...
ALCHEMY_WEBHOOK_AUTH_TOKEN=...
```

Generate `WALLET_ENCRYPTION_KEY` locally:

```bash
openssl rand -hex 32
```

## Telegram Flow

Use `/start` to open the menu.

Users can:

- Tap `Wallet` to create/import/switch wallets.
- Tap `Track NFT` and paste an OpenSea mint URL.
- Example:

```text
https://opensea.io/collection/example
```

## Supported Chains

The bot supports Ethereum mainnet and Base mainnet in the same deployment.

- Ethereum uses `ETHEREUM_RPC_URL`
- Base uses `BASE_RPC_URL`
- OpenSea asset URLs with `ethereum` or `base` in the path are routed to the matching chain
- Collection URLs are resolved through OpenSea collection metadata when `OPENSEA_API_KEY` is set

The bot replies with a confirmation card:

- Eligible phase
- Personal mint window
- Full phase schedule
- Contract
- Price
- Quantity
- Active wallet
- Reminder status
- Auto-mint status
- Gas cap approval
- Flashbots/private relay toggle
- Gas War mode toggle
- Target list price and profit alert settings
- Transparent 5% profit-fee disclosure

After Confirm, reminders and auto-mint become active.

## Auto-Mint Behavior

Auto-mint is not GTD-only. It runs for whichever phase the user confirms.

Example:

- GTD user: timer fires at `gtdTime + 5 seconds`
- OG user: timer fires at `ogTime + 5 seconds`
- WL user: timer fires at `wlTime + 5 seconds`
- Public user: timer fires at `publicTime + 5 seconds`

The poller still runs every 30 seconds. It handles reminders, open-window alerts, and backup auto-mint retries if the first timer attempt fails.

## Gas Caps And Gas War

When a user taps Confirm, MintBot estimates a recommended gas cap and shows it as ETH plus a percentage of total mint cost. The user can approve it or reply with a custom ETH cap.

Gas War mode starts at the baseline gas boost and adds `GAS_WAR_STEP_PERCENT` on each retry. The user's gas cap is always the hard stop.

## Profit Fee System

The confirmation card clearly states:

```text
Platform fee: 5% of profit only if this NFT sells above mint price. No fee is taken on a loss or break-even sale.
```

The repo includes `contracts/MintRegistry.sol` and `contracts/FeeRouter.sol`. Deploy them on Ethereum and Base, then set:

```bash
MINT_REGISTRY_ETH=...
MINT_REGISTRY_BASE=...
FEE_ROUTER_CONTRACT_ETH=...
FEE_ROUTER_CONTRACT_BASE=...
```

Alchemy webhooks should POST sale/activity payloads to:

```text
https://YOUR-RAILWAY-DOMAIN/webhooks/alchemy
```

Set `ALCHEMY_WEBHOOK_AUTH_TOKEN` and send it as the `x-mintbot-token` header from your webhook configuration.

On Base, profitable sale fee collection sends 5% of profit to `TREASURY_WALLET` from the user's active wallet and then notifies the user. On Ethereum, profitable fees are stored as pending fees and the user receives this exact notice format:

```text
Your NFT sold for X ETH. Profit: X ETH. Platform fee: X ETH (5% of profit). To save you gas costs on Ethereum this will be bundled into your next mint.
```

## PostgreSQL

Set `DATABASE_URL` to use PostgreSQL-backed storage. Without it, the bot uses the local JSON file so development still works.

For Railway, add the Postgres plugin and copy its `DATABASE_URL` into the bot service variables.

## Mint Function Detection

MintBot tries to fetch the verified ABI through Etherscan V2 and detect common mint functions:

- `mint`
- `publicMint`
- `whitelistMint`
- `allowlistMint`
- `presaleMint`
- `ogMint`
- `gtdMint`
- `claim`
- `purchase`

If the contract requires a custom function, merkle proof, signature, or unusual args, the bot needs those details. It will not invent proofs or signatures.

## Production With PM2

```bash
npm install -g pm2
pm2 start index.js --name mintbot
pm2 save
pm2 startup
```

View logs:

```bash
pm2 logs mintbot
```

Restart after config changes:

```bash
pm2 restart mintbot
```

## Files

- `index.js` - bot implementation
- `.env.example` - required environment variables
- `data/mintbot.json` - runtime database, ignored by git
- `package.json` - dependencies and scripts
