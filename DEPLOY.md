# MintBot — Full Deployment Guide

Everything you need from zero to live. Follow the steps in order.

---

## Step 1 — Deploy the Smart Contracts

You need two contracts deployed on each chain you support (Ethereum mainnet, Base mainnet).

### What you're deploying

| Contract | Purpose |
|---|---|
| `MintRegistry.sol` | Records mint price per token at mint time. Used to calculate your profit fee. |
| `FeeRouter.sol` | Routes mint transactions, splits the platform fee silently. |

### How to deploy (Remix — no setup needed)

1. Go to [remix.ethereum.org](https://remix.ethereum.org)
2. Create a new file, paste `MintRegistry.sol`
3. Compile: Solidity 0.8.20, Optimization ON (200 runs)
4. Deploy tab → select **Injected Provider** → connect your MetaMask
5. Switch MetaMask to **Ethereum Mainnet**
6. Deploy `MintRegistry` — copy the deployed address → save as `MINT_REGISTRY_ETH`
7. Switch MetaMask to **Base Mainnet**
8. Deploy `MintRegistry` again → save as `MINT_REGISTRY_BASE`
9. Repeat steps 5–8 for `FeeRouter.sol` → save as `FEE_ROUTER_CONTRACT_ETH` and `FEE_ROUTER_CONTRACT_BASE`

> The FeeRouter `owner` is set to the wallet you deploy from. Only that wallet can call `withdraw()`.

### Verify on Etherscan (optional but recommended)

After deploying, verify source code on Etherscan/Basescan so users can see what the contract does. In Remix: Plugins → Etherscan Verifier → paste your Etherscan API key.

---

## Step 2 — Get Your API Keys

| Key | Where to get it | Required? |
|---|---|---|
| Telegram Bot Token | [@BotFather](https://t.me/BotFather) → /newbot | ✅ |
| Ethereum RPC URL | [Alchemy](https://alchemy.com) or [Infura](https://infura.io) — free tier works | ✅ |
| Base RPC URL | [Alchemy](https://alchemy.com) → create Base app | ✅ |
| Etherscan API Key | [etherscan.io/apis](https://etherscan.io/apis) — free | recommended |
| OpenSea API Key | [docs.opensea.io](https://docs.opensea.io/reference/api-keys) — apply | recommended |
| Wallet Encryption Key | Run: `openssl rand -hex 32` | ✅ |

**For 3 RPC fallbacks (strongly recommended):**
- Get 3 separate Alchemy or Infura keys
- Or mix: Alchemy + Infura + Ankr (`https://rpc.ankr.com/eth`)

---

## Step 3 — Configure Environment Variables

Copy `.env.example` to `.env` and fill in:

```env
TELEGRAM_BOT_TOKEN=7123456789:AAF...
WALLET_ENCRYPTION_KEY=abc123...64chars

# Primary RPCs
ETHEREUM_RPC_URL=https://eth-mainnet.alchemyapi.io/v2/YOUR_KEY
BASE_RPC_URL=https://base-mainnet.alchemyapi.io/v2/YOUR_KEY

# Fallback RPCs (highly recommended)
RPC_URL_1=https://eth-mainnet.alchemyapi.io/v2/YOUR_KEY_1
RPC_URL_2=https://mainnet.infura.io/v3/YOUR_KEY_2
RPC_URL_3=https://rpc.ankr.com/eth

ETHERSCAN_API_KEY=...
OPENSEA_API_KEY=...

# Your wallet — receives the 5% profit fee
TREASURY_WALLET=0xYourWalletAddress

# Your Telegram user ID — for /stats admin access
# Get it: message @userinfobot on Telegram
ADMIN_USER_ID=123456789

# Smart contracts you deployed in Step 1
MINT_REGISTRY_ETH=0x...
MINT_REGISTRY_BASE=0x...
FEE_ROUTER_CONTRACT_ETH=0x...
FEE_ROUTER_CONTRACT_BASE=0x...
```

---

## Step 4 — Deploy on Railway

Railway gives you a persistent server that restarts automatically on crashes.

1. Create a free account at [railway.app](https://railway.app)
2. New Project → Deploy from GitHub repo
   - Push your bot folder to a private GitHub repo first
3. Railway auto-detects `package.json` and runs `npm start`
4. Go to **Variables** tab → add every variable from Step 3
5. Go to **Volumes** tab → Add Volume → mount at `/data`
   - This keeps `mintbot.json` (wallets, mints, history) alive across redeploys
   - Railway auto-sets `RAILWAY_VOLUME_MOUNT_PATH=/data` for you
6. Click **Deploy**

Your bot is live. Test it by messaging it on Telegram.

### Costs

Railway Hobby plan is $5/month. The bot uses very little CPU/RAM. A single Railway service handles hundreds of users.

---

## Step 5 — Test Before Going Live

Work through this checklist before sharing the bot:

### Wallet
- [ ] `/start` shows the welcome message with all inline buttons
- [ ] Create a new wallet — confirm private key message appears and deletes after 30s
- [ ] Import a wallet with a private key — confirm it sets active
- [ ] Switch between wallets
- [ ] Receive — shows full wallet address (not shortened)

### Gas
- [ ] Gas panel shows current fees for configured chains
- [ ] Gas War mode toggle works and persists
- [ ] Gas refresh button works

### Track & Mint
- [ ] Paste an OpenSea URL — confirmation card appears
- [ ] All toggles on the card work (Reminders, Auto-mint, Gas War, Flashbots)
- [ ] Gas cap prompt appears on Confirm
- [ ] Setting a target list price saves
- [ ] Setting a profit alert threshold saves
- [ ] Confirm a mint — status panel shows it active

### Send / Receive
- [ ] Send NFT — prompts for contract + token ID then destination address
- [ ] Send Token — prompts for contract, amount, destination
- [ ] Receive — shows full address

### Leaderboard
- [ ] Opens and shows users (or "no data yet" message)
- [ ] Names are clickable Telegram links

### Admin
- [ ] `/stats` returns data when sent from your admin account
- [ ] `/stats` returns "Not authorized" from any other account

---

## Step 6 — Grow Your User Base

**Day 1 things to do:**
1. Set a bot description in BotFather: `/setdescription` → explain what it does
2. Set a bot photo: `/setuserpic`
3. Set a short description: `/setshortdescription`
4. Share in NFT alpha Discord servers and Telegram groups
5. Use `/stats` weekly to see what features users are trying that aren't built yet

**The leaderboard is your growth engine.** Users compete for top spots, share their rank, bring their friends. Make sure it's visible and updated.

---

## How the Fee System Works End-to-End

1. User confirms a mint → card shows: *"Platform fee: 5% of profit only — nothing on losses"*
2. Bot mints → receipt logs scanned for token ID → stored in `mint._mintedTokenIds`
3. Sale watcher starts polling every 10 minutes:
   - Checks OpenSea sale events for that token
   - Falls back to on-chain Transfer event scan
4. When a sale is detected:
   - **Base**: fee deducted immediately from user wallet → sent to `TREASURY_WALLET`
   - **Ethereum**: pending fee stored in DB → user notified → bundled into next mint tx
5. If user transfers the NFT (not a sale), no fee is taken

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Bot not responding | Check Railway logs — probably a missing env variable |
| "RPC is not configured" | Make sure `ETHEREUM_RPC_URL` or `BASE_RPC_URL` is set |
| Auto-mint not firing | Check wallet has enough ETH. Check contract address is correct. |
| Portfolio/Trending empty | Need `OPENSEA_API_KEY` |
| Fee not collected | Sale watcher only detects sales after bot is running. Sales made while bot is down are missed. |
| Gas cap error | User set cap too low. They can retry with a higher cap from the status panel. |

---

## Architecture Notes

Everything runs in a single Node.js process. The data file is a JSON database. This works fine for hundreds of users. If you grow to thousands:

- Move to PostgreSQL (replace `loadDb`/`saveDb` with pg queries)
- Move top offer + sale polling to a separate worker process
- Use Alchemy Notify webhooks instead of interval polling for Transfer events

The code is structured so these upgrades are self-contained — they don't touch the Telegram handler logic.
