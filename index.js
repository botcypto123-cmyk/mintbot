require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const EventEmitter = require("events");
const { ethers } = require("ethers");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const LEGACY_RPC_URL = process.env.RPC_URL;
const LEGACY_CHAIN_ID = Number(process.env.CHAIN_ID || 1);
const DEFAULT_DATA_FILE = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "mintbot.json")
  : "./data/mintbot.json";
const DATA_FILE = path.resolve(__dirname, process.env.DATA_FILE || DEFAULT_DATA_FILE);
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || "UTC";
const AUTO_MINT_DELAY_MS = Number(process.env.AUTO_MINT_DELAY_MS || 5000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30000);
const AUTO_MINT_RETRY_WINDOW_MS = Number(process.env.AUTO_MINT_RETRY_WINDOW_MS || 300000);
const AUTO_MINT_MAX_ATTEMPTS = Number(process.env.AUTO_MINT_MAX_ATTEMPTS || 10);
const GAS_BOOST_PERCENT = BigInt(process.env.GAS_BOOST_PERCENT || process.env.BASELINE_GAS_BOOST_PERCENT || 110);
const GAS_WAR_STEP_PERCENT = BigInt(process.env.GAS_WAR_STEP_PERCENT || 10);
const DEFAULT_GAS_LIMIT = BigInt(process.env.DEFAULT_GAS_LIMIT || 300000);
const DEFAULT_GAS_CAP_MULTIPLIER_PERCENT = BigInt(process.env.DEFAULT_GAS_CAP_MULTIPLIER_PERCENT || 150);
const WALLET_ENCRYPTION_KEY = process.env.WALLET_ENCRYPTION_KEY || "";
const ADMIN_USER_ID = process.env.ADMIN_USER_ID ? String(process.env.ADMIN_USER_ID) : "";
const PLATFORM_PROFIT_FEE_BPS = BigInt(process.env.PLATFORM_PROFIT_FEE_BPS || 500);
const TREASURY_WALLET = process.env.TREASURY_WALLET || "";
const WEBHOOK_PORT = Number(process.env.PORT || process.env.WEBHOOK_PORT || 3000);
const ALCHEMY_WEBHOOK_AUTH_TOKEN = process.env.ALCHEMY_WEBHOOK_AUTH_TOKEN || "";
const MINT_REGISTRY_BY_CHAIN = {
  1: process.env.MINT_REGISTRY_ETH || "",
  8453: process.env.MINT_REGISTRY_BASE || ""
};
const FEE_ROUTER_BY_CHAIN = {
  1: process.env.FEE_ROUTER_CONTRACT_ETH || "",
  8453: process.env.FEE_ROUTER_CONTRACT_BASE || ""
};

const CHAIN_CONFIGS = {
  ethereum: {
    key: "ethereum",
    chainId: 1,
    chainName: "Ethereum",
    openSeaChain: "ethereum",
    rpcUrls: rpcUrlsFor("ETHEREUM", LEGACY_CHAIN_ID === 1 ? LEGACY_RPC_URL : null)
  },
  base: {
    key: "base",
    chainId: 8453,
    chainName: "Base",
    openSeaChain: "base",
    rpcUrls: rpcUrlsFor("BASE", LEGACY_CHAIN_ID === 8453 ? LEGACY_RPC_URL : null)
  }
};

for (const chain of Object.values(CHAIN_CONFIGS)) {
  chain.rpcUrl = chain.rpcUrls[0] || null;
}

const OPENSEA_CHAIN_TO_CHAIN_ID = Object.fromEntries(
  Object.values(CHAIN_CONFIGS).map((chain) => [chain.openSeaChain, chain.chainId])
);

const REMINDERS = [
  { key: "r_86400", seconds: 86400, label: "24h" },
  { key: "r_43200", seconds: 43200, label: "12h" },
  { key: "r_21600", seconds: 21600, label: "6h" },
  { key: "r_10800", seconds: 10800, label: "3h" },
  { key: "r_3600", seconds: 3600, label: "1h" },
  { key: "r_1800", seconds: 1800, label: "30m" },
  { key: "r_900", seconds: 900, label: "15m" },
  { key: "r_300", seconds: 300, label: "5m" }
];

const RISK_MODES = {
  safe: {
    key: "safe",
    label: "Safe",
    gasWarMode: false,
    flashbotsEnabled: true,
    gasCapMultiplierPercent: 125n,
    gasBoostPercent: 105n
  },
  fast: {
    key: "fast",
    label: "Fast",
    gasWarMode: false,
    flashbotsEnabled: false,
    gasCapMultiplierPercent: 150n,
    gasBoostPercent: 110n
  },
  degenerate: {
    key: "degenerate",
    label: "Degenerate",
    gasWarMode: true,
    flashbotsEnabled: true,
    gasCapMultiplierPercent: 200n,
    gasBoostPercent: 125n
  }
};

const MAIN_MENU_KEYBOARD = {
  reply_markup: {
    keyboard: [
      ["Wallet", "Track Mint"],
      ["Instant Mint", "Receive"],
      ["Fund Wallet", "Ready Check"],
      ["Send NFT", "Send Token"],
      ["Auto-Buy", "Reminders"],
      ["Gas", "Portfolio"],
      ["Buy History", "Trending"],
      ["PnL", "Menu"],
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  }
};

const COMMON_MINT_ABI = [
  "function mint() payable",
  "function mint(uint256 quantity) payable",
  "function mint(address to, uint256 quantity) payable",
  "function publicMint() payable",
  "function publicMint(uint256 quantity) payable",
  "function publicMint(address to, uint256 quantity) payable",
  "function whitelistMint(uint256 quantity) payable",
  "function allowlistMint(uint256 quantity) payable",
  "function presaleMint(uint256 quantity) payable",
  "function claim(uint256 quantity) payable",
  "function purchase(uint256 quantity) payable"
];

const MINT_FUNCTION_PRIORITY = [
  "mint",
  "publicMint",
  "publicSaleMint",
  "whitelistMint",
  "allowlistMint",
  "presaleMint",
  "ogMint",
  "gtdMint",
  "claim",
  "purchase"
];

const PHASE_TIME_READS = {
  gtd: [
    "gtdStartTime",
    "gtdMintStartTime",
    "guaranteedStartTime",
    "guaranteedMintStartTime",
    "guaranteedSaleStartTime",
    "earlyAccessStartTime",
    "startGTD"
  ],
  og: [
    "ogStartTime",
    "ogMintStartTime",
    "ogSaleStartTime",
    "earlyAccessStartTime",
    "presaleStartTime",
    "privateSaleStartTime",
    "startOG"
  ],
  wl: [
    "wlStartTime",
    "wlMintStartTime",
    "whitelistStartTime",
    "whitelistMintStartTime",
    "allowlistStartTime",
    "allowlistMintStartTime",
    "presaleStartTime",
    "preSaleStartTime",
    "privateSaleStartTime",
    "startWhitelist"
  ],
  public: [
    "publicStartTime",
    "publicMintStartTime",
    "publicSaleStartTime",
    "saleStartTime",
    "mintStartTime",
    "startTime",
    "saleStart",
    "mintStart",
    "publicSaleStart",
    "startPublic"
  ]
};

const PRICE_READS = [
  "mintPrice",
  "price",
  "cost",
  "publicPrice",
  "publicSalePrice",
  "salePrice",
  "tokenPrice",
  "MINT_PRICE",
  "PUBLIC_PRICE",
  "PRICE"
];

const PHASE_PRICE_READS = {
  gtd: ["gtdPrice", "guaranteedPrice", "guaranteedMintPrice"],
  og: ["ogPrice", "ogMintPrice", "presalePrice"],
  wl: ["wlPrice", "whitelistPrice", "allowlistPrice", "presalePrice"],
  public: ["publicPrice", "publicSalePrice", "mintPrice", "price", "cost"]
};

const READ_ONLY_ABI = [
  ...new Set([
    ...Object.values(PHASE_TIME_READS).flat(),
    ...PRICE_READS,
    ...Object.values(PHASE_PRICE_READS).flat()
  ])
].map((name) => `function ${name}() view returns (uint256)`);

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

const ERC721_ABI = [
  "function transferFrom(address from, address to, uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)"
];

const FEE_ROUTER_ABI = [
  "function routeMint(address nftContract, bytes mintCallData, uint256 mintValueWei, uint256 platformFeeWei, uint256 expectedTokenId, address userWallet) payable returns (bytes)"
];

if (!TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN in .env");
  process.exit(1);
}

class TelegramBot extends EventEmitter {
  constructor(token, options = {}) {
    super();
    this.token = token;
    this.offset = 0;
    this.textHandlers = [];
    this.polling = Boolean(options.polling);
    this.pollingStopped = false;

    if (this.polling) {
      this.pollLoop();
    }
  }

  onText(regex, callback) {
    this.textHandlers.push({ regex, callback });
  }

  async api(method, payload = {}) {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !data || !data.ok) {
      const description = data && data.description ? data.description : response.statusText;
      throw new Error(`Telegram ${method} failed: ${description}`);
    }

    return data.result;
  }

  async setMyCommands(commands) {
    return this.api("setMyCommands", { commands });
  }

  async sendMessage(chatId, text, options = {}) {
    return this.api("sendMessage", { chat_id: chatId, text, ...options });
  }

  async sendPhoto(chatId, photo, options = {}) {
    return this.api("sendPhoto", { chat_id: chatId, photo, ...options });
  }

  async editMessageText(text, options = {}) {
    return this.api("editMessageText", { text, ...options });
  }

  async deleteMessage(chatId, messageId) {
    return this.api("deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  async answerCallbackQuery(callbackQueryId, options = {}) {
    return this.api("answerCallbackQuery", { callback_query_id: callbackQueryId, ...options });
  }

  async pollLoop() {
    while (!this.pollingStopped) {
      try {
        const updates = await this.api("getUpdates", {
          offset: this.offset,
          timeout: 25,
          allowed_updates: ["message", "callback_query"]
        });

        for (const update of updates) {
          this.offset = update.update_id + 1;
          this.handleUpdate(update);
        }
      } catch (err) {
        this.emit("polling_error", err);
        await sleep(3000);
      }
    }
  }

  handleUpdate(update) {
    if (update.message) {
      const message = update.message;
      if (message.text) {
        for (const handler of this.textHandlers) {
          handler.regex.lastIndex = 0;
          const match = message.text.match(handler.regex);
          if (match) {
            Promise.resolve(handler.callback(message, match)).catch((err) => {
              this.emit("polling_error", err);
            });
          }
        }
      }

      this.dispatch("message", message);
    }

    if (update.callback_query) {
      this.dispatch("callback_query", update.callback_query);
    }
  }

  dispatch(eventName, ...args) {
    for (const listener of this.listeners(eventName)) {
      try {
        Promise.resolve(listener(...args)).catch((err) => {
          this.emit("polling_error", err);
        });
      } catch (err) {
        this.emit("polling_error", err);
      }
    }
  }
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const providersByChainId = new Map(
  Object.values(CHAIN_CONFIGS)
    .filter((chain) => chain.rpcUrls.length)
    .map((chain) => [chain.chainId, makeProvider(chain)])
);
const activeAutoMintTimers = new Map();

let db = loadDb();
let pgPool = null;
let pgSaveInFlight = false;
let pgSaveQueued = false;

ensureDataDir();
initRuntime().catch((err) => {
  console.error("runtime init failed:", err);
  armAllAutoMintTimers();
  setInterval(checkConfirmedMints, POLL_INTERVAL_MS);
});

bot.setMyCommands([
  { command: "start", description: "Open the home screen" },
  { command: "track", description: "Track a mint" },
  { command: "wallet", description: "Open wallet tools" },
  { command: "ready", description: "Run ready check" },
  { command: "pnl", description: "Open PnL" },
  { command: "status", description: "Check active mints" },
  { command: "gas", description: "Check gas" },
  { command: "history", description: "See past buys" },
  { command: "stats", description: "Admin only" },
  { command: "clear", description: "Clear active mints" },
  { command: "setwallet", description: "Add a wallet secret" }
]).catch((err) => console.error("setMyCommands failed:", err.message));

bot.onText(/^\/start\b/, async (msg) => {
  await sendMainMenu(msg.chat.id);
});

bot.onText(/^\/menu\b/, async (msg) => {
  await sendMainMenu(msg.chat.id);
});

bot.onText(/^\/track\b/, async (msg) => {
  await startTrackFlow(msg.chat.id);
});

bot.onText(/^\/wallet\b/, async (msg) => {
  await sendWalletMenu(msg.chat.id);
});

bot.onText(/^\/ready\b/, async (msg) => {
  await sendReadyCheck(msg.chat.id);
});

bot.onText(/^\/pnl\b/, async (msg) => {
  await sendPnlDashboard(msg.chat.id);
});

bot.onText(/^\/gas\b/, async (msg) => {
  await sendGas(msg.chat.id);
});

bot.onText(/^\/status\b/, async (msg) => {
  await sendStatus(msg.chat.id);
});

bot.onText(/^\/history\b/, async (msg) => {
  await sendMintHistory(msg.chat.id);
});

bot.onText(/^\/stats\b/, async (msg) => {
  await sendAdminStats(msg);
});

bot.onText(/^\/clear\b/, async (msg) => {
  await clearMints(msg.chat.id);
});

bot.onText(/^\/setwallet(?:\s+(.+))?$/s, async (msg, match) => {
  const chatId = msg.chat.id;
  await safeDelete(chatId, msg.message_id);
  const privateKey = (match && match[1] ? match[1] : "").trim();

  if (!privateKey) {
    const user = getUser(chatId);
    user.state = { mode: "awaiting_import_wallet" };
    saveDb();
    await safeSend(chatId, "Send your wallet secret now. Use a fresh mint wallet only. I will delete the message after import.");
    return;
  }

  await importWallet(chatId, privateKey, { deleteMessageId: msg.message_id });
});

bot.on("callback_query", async (query) => {
  try {
    await handleCallback(query);
  } catch (err) {
    console.error("callback_query error:", err);
    if (query.message) {
      await safeSend(query.message.chat.id, userFriendlyError(err));
    }
  }
});

bot.on("message", async (msg) => {
  if (!msg.text) return;
  const text = msg.text.trim();
  const chatId = msg.chat.id;
  touchUser(chatId, msg.from);

  if (text.startsWith("/")) return;

  try {
    if (await handleMenuText(chatId, text)) return;

    const user = getUser(chatId);
    if (user.state && user.state.mode === "awaiting_import_wallet") {
      await safeDelete(chatId, msg.message_id);
      await importWallet(chatId, text, { deleteMessageId: msg.message_id });
      return;
    }

    if (user.state && user.state.mode === "awaiting_track_input") {
      await handleTrackInput(chatId, text);
      return;
    }

    if (user.state && user.state.mode === "awaiting_instant_target") {
      await handleInstantMintInput(chatId, text);
      return;
    }

    if (user.state && user.state.mode === "awaiting_send_token") {
      await handleSendTokenDetails(chatId, text);
      return;
    }

    if (user.state && user.state.mode === "awaiting_send_token_destination") {
      await handleSendTokenDestination(chatId, text);
      return;
    }

    if (user.state && user.state.mode === "awaiting_send_nft_destination") {
      await handleSendNftDestination(chatId, text);
      return;
    }

    if (user.state && user.state.mode === "awaiting_gas_cap_custom") {
      await handleCustomGasCap(chatId, text);
      return;
    }

    if (user.state && user.state.mode === "awaiting_target_list_price") {
      await handleTargetListPrice(chatId, text);
      return;
    }

    if (user.state && user.state.mode === "awaiting_list_price") {
      await handleListPrice(chatId, text);
      return;
    }

    if (user.state && user.state.mode === "awaiting_profit_threshold") {
      await handleProfitThreshold(chatId, text);
      return;
    }

    if (looksLikeMintMessage(text)) {
      await handleTrackInput(chatId, text);
      return;
    }

    logUnhandled(chatId, "unrecognized_input", text);
    await safeSend(
      chatId,
      "Send a mint page or use Track Mint from the menu.",
      MAIN_MENU_KEYBOARD
    );
  } catch (err) {
    console.error("message handler error:", err);
    await safeSend(chatId, userFriendlyError(err, "I could not process that. Try again from the menu."));
  }
});

bot.on("polling_error", (err) => {
  console.error("polling_error:", err.message);
});

process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
});

async function initRuntime() {
  await initPostgresStorage();
  armAllAutoMintTimers();
  setInterval(checkConfirmedMints, POLL_INTERVAL_MS);
  startWebhookServer();
  console.log("MintBot running.");
}

async function initPostgresStorage() {
  if (!process.env.DATABASE_URL) return;

  let Pool;
  try {
    ({ Pool } = require("pg"));
  } catch (err) {
    console.error("DATABASE_URL is set but pg is not installed. Run npm install.");
    return;
  }

  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }
  });

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS mintbot_state (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const result = await pgPool.query("SELECT data FROM mintbot_state WHERE id = $1", ["default"]);
  if (result.rows[0] && result.rows[0].data) {
    db = result.rows[0].data;
    db.users = db.users || {};
  } else {
    await persistDbToPostgres();
  }
  console.log("PostgreSQL storage active.");
}

function startWebhookServer() {
  if (!process.env.ENABLE_WEBHOOK_SERVER && !process.env.DATABASE_URL) return;

  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method !== "POST" || !String(req.url || "").startsWith("/webhooks/alchemy")) {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    if (ALCHEMY_WEBHOOK_AUTH_TOKEN && req.headers["x-mintbot-token"] !== ALCHEMY_WEBHOOK_AUTH_TOKEN) {
      res.writeHead(401);
      res.end("unauthorized");
      return;
    }

    try {
      const payload = await readRequestJson(req);
      await handleAlchemyWebhook(payload);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error("webhook error:", err);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: shortError(err) }));
    }
  });

  server.listen(WEBHOOK_PORT, () => {
    console.log(`Webhook server listening on ${WEBHOOK_PORT}`);
  });
}

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        req.destroy();
        reject(new Error("Webhook payload too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error("Invalid webhook JSON"));
      }
    });
    req.on("error", reject);
  });
}

async function handleMenuText(chatId, text) {
  const normalized = text.toLowerCase();

  if (normalized === "menu") {
    await sendMainMenu(chatId);
    return true;
  }
  if (normalized === "wallet") {
    await sendWalletMenu(chatId);
    return true;
  }
  if (normalized === "fund wallet") {
    await sendFundWallet(chatId);
    return true;
  }
  if (normalized === "ready check") {
    await sendReadyCheck(chatId);
    return true;
  }
  if (normalized === "pnl") {
    await sendPnlDashboard(chatId);
    return true;
  }
  if (normalized === "track nft" || normalized === "track mint") {
    await startTrackFlow(chatId);
    return true;
  }
  if (normalized === "instant mint") {
    await startInstantMintFlow(chatId);
    return true;
  }
  if (normalized === "receive") {
    await sendReceiveAddress(chatId);
    return true;
  }
  if (normalized === "send nft") {
    await startSendNftFlow(chatId);
    return true;
  }
  if (normalized === "send token") {
    await startSendTokenFlow(chatId);
    return true;
  }
  if (normalized === "auto-mint" || normalized === "auto-buy") {
    await sendAutoMintPanel(chatId);
    return true;
  }
  if (normalized === "reminders") {
    await sendRemindersPanel(chatId);
    return true;
  }
  if (normalized === "gas") {
    await sendGas(chatId);
    return true;
  }
  if (normalized === "trending") {
    await sendTrending(chatId);
    return true;
  }
  if (normalized === "portfolio") {
    await sendPortfolio(chatId);
    return true;
  }
  if (normalized === "status") {
    await sendStatus(chatId);
    return true;
  }
  if (normalized === "mint history" || normalized === "buy history") {
    await sendMintHistory(chatId);
    return true;
  }

  return false;
}

async function handleCallback(query) {
  const data = query.data || "";
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const user = getUser(chatId);
  touchUser(chatId, query.from);
  logFeature(user, data.split(":")[0] || "callback");

  await bot.answerCallbackQuery(query.id).catch(() => {});

  if (data === "menu") {
    await sendMainMenu(chatId);
    return;
  }

  if (data === "track:start") {
    await startTrackFlow(chatId);
    return;
  }

  if (data === "leaderboard") {
    await sendLeaderboard(chatId);
    return;
  }

  if (data === "status:open") {
    await sendStatus(chatId);
    return;
  }

  if (data === "instant:start") {
    await startInstantMintFlow(chatId);
    return;
  }

  if (data === "receive") {
    await sendReceiveAddress(chatId);
    return;
  }

  if (data === "fund:wallet") {
    await sendFundWallet(chatId);
    return;
  }

  if (data === "ready:check") {
    await sendReadyCheck(chatId);
    return;
  }

  if (data === "pnl:show") {
    await sendPnlDashboard(chatId);
    return;
  }

  if (data === "riskmode:panel") {
    await sendRiskModePanel(chatId);
    return;
  }

  if (data.startsWith("riskmode:set:")) {
    const mode = data.split(":")[2];
    await setRiskMode(chatId, mode);
    return;
  }

  if (data === "sendtoken:start") {
    await startSendTokenFlow(chatId);
    return;
  }

  if (data === "sendnft:start") {
    await startSendNftFlow(chatId);
    return;
  }

  if (data === "wallet:menu") {
    await sendWalletMenu(chatId);
    return;
  }

  if (data === "wallet:create") {
    await createWallet(chatId);
    return;
  }

  if (data === "wallet:import") {
    user.state = { mode: "awaiting_import_wallet" };
    saveDb();
    await safeSend(chatId, "Send your wallet secret to import. Use a fresh mint wallet only. I will delete the message after import.");
    return;
  }

  if (data === "wallet:list") {
    await sendWalletList(chatId);
    return;
  }

  if (data === "wallet:export") {
    await sendExportWalletMenu(chatId);
    return;
  }

  if (data.startsWith("wallet:switch:")) {
    const walletId = data.split(":")[2];
    await switchWallet(chatId, walletId);
    return;
  }

  if (data.startsWith("wallet:export_warn:")) {
    const walletId = data.split(":")[2];
    await sendExportWalletWarning(chatId, walletId);
    return;
  }

  if (data.startsWith("wallet:export_confirm:")) {
    const walletId = data.split(":")[2];
    await exportWallet(chatId, walletId);
    return;
  }

  if (data === "gas:refresh") {
    await sendGas(chatId, { editMessageId: messageId });
    return;
  }

  if (data === "gaswar:toggle") {
    user.gasWarMode = !user.gasWarMode;
    user.updatedAt = Date.now();
    saveDb();
    await sendGas(chatId, { editMessageId: messageId });
    return;
  }

  if (data.startsWith("stage:")) {
    const tier = data.split(":")[1];
    await verifyAndCreatePendingMint(chatId, {
      ...(user.state && user.state.draft ? user.state.draft : {}),
      userTier: tier
    });
    return;
  }

  if (data.startsWith("confirm:")) {
    const mintId = data.split(":")[1];
    await askGasCapApproval(chatId, mintId);
    return;
  }

  if (data.startsWith("gascap:approve:")) {
    const mintId = data.split(":")[2];
    await approveRecommendedGasCap(chatId, mintId);
    return;
  }

  if (data.startsWith("gascap:custom:")) {
    const mintId = data.split(":")[2];
    user.state = { mode: "awaiting_gas_cap_custom", mintId };
    saveDb();
    await safeSend(chatId, "Reply with the most you want this bot to spend on gas for this buy. Example: 0.012 ETH");
    return;
  }

  if (data.startsWith("cancel:")) {
    const mintId = data.split(":")[1];
    if (user.pendingMint && user.pendingMint.id === mintId) {
      user.pendingMint = null;
      user.state = {};
      saveDb();
    }
    await safeEdit(chatId, messageId, "That setup is cancelled. Send a new mint page when you want to try again.");
    return;
  }

  if (data.startsWith("toggle:")) {
    const [, field, mintId] = data.split(":");
    if (!user.pendingMint || user.pendingMint.id !== mintId) {
      await safeSend(chatId, "That setup expired. Start again with a fresh mint page.");
      return;
    }

    if (field === "reminders") {
      user.pendingMint.remindersEnabled = !user.pendingMint.remindersEnabled;
    } else if (field === "auto") {
      user.pendingMint.autoMintEnabled = !user.pendingMint.autoMintEnabled;
    } else if (field === "flashbots") {
      user.pendingMint.flashbotsEnabled = !user.pendingMint.flashbotsEnabled;
    } else if (field === "gaswar") {
      user.gasWarMode = !user.gasWarMode;
      user.pendingMint.gasWarMode = user.gasWarMode;
    }

    user.pendingMint.updatedAt = Date.now();
    saveDb();
    await safeEdit(chatId, messageId, formatMintCard(chatId, user.pendingMint), {
      reply_markup: mintConfirmKeyboard(user.pendingMint)
    });
    return;
  }

  if (data.startsWith("mint_toggle:")) {
    const [, field, mintId] = data.split(":");
    await toggleConfirmedMintSetting(chatId, field, mintId);
    return;
  }

  if (data.startsWith("status_instant:")) {
    const mintId = data.split(":")[1];
    await instantMintExisting(chatId, mintId);
    return;
  }

  if (data.startsWith("mint_cancel:")) {
    const mintId = data.split(":")[1];
    await cancelConfirmedMint(chatId, mintId);
    return;
  }

  if (data.startsWith("sendnft:pick:")) {
    const nftId = data.split(":")[2];
    await pickNftToSend(chatId, nftId);
    return;
  }

  if (data.startsWith("target_list:")) {
    const mintId = data.split(":")[1];
    user.state = { mode: "awaiting_target_list_price", mintId };
    saveDb();
    await safeSend(chatId, "Reply with the sell price you want if this runs. Example: 0.25 ETH");
    return;
  }

  if (data.startsWith("token_rarity:")) {
    const tokenRecordId = data.split(":")[1];
    await sendMintedTokenMarketCard(chatId, tokenRecordId, { refresh: true });
    return;
  }

  if (data.startsWith("token_list:")) {
    const tokenRecordId = data.split(":")[1];
    const token = findMintedToken(user, tokenRecordId);
    if (!token) {
      await safeSend(chatId, "That item is not available in this chat anymore. Open your wallet or buy history and try again.");
      return;
    }
    user.state = { mode: "awaiting_list_price", tokenRecordId };
    saveDb();
    await safeSend(
      chatId,
      [
        "List for Sale",
        `Item: ${displayMintedTokenName(token)}`,
        "",
        "Reply with the sell price you want.",
        "Example: 0.25 ETH"
      ].join("\n")
    );
    return;
  }

  if (data.startsWith("profit_threshold:")) {
    const mintId = data.split(":")[1];
    user.state = { mode: "awaiting_profit_threshold", mintId };
    saveDb();
    await safeSend(chatId, "Reply with when you want the bot to ping you for profit. Example: 2 for 2x or 3 for 3x.");
    return;
  }

  if (data.startsWith("track_collection:")) {
    const slug = data.replace("track_collection:", "");
    await handleTrackInput(chatId, `https://opensea.io/collection/${slug}`);
    return;
  }
}

async function sendMainMenu(chatId) {
  const user = getUser(chatId);
  const wallet = getActiveWallet(user);
  const activeWalletLine = wallet ? `Live wallet: ${shortAddress(wallet.address)}` : "Live wallet: not set";
  const activeMints = (user.mints || []).filter((mint) => mint.confirmed && !mint.completedAt).length;
  const riskMode = riskModeForUser(user);

  await safeSend(
    chatId,
    [
      "MintBot",
      activeWalletLine,
      `Live mints: ${activeMints}`,
      `Mode: ${riskMode.label}`,
      "",
      "Best way to use this:",
      "1. Add a wallet",
      "2. Drop an OpenSea mint page",
      "3. Confirm the details",
      "4. Let the bot handle the timing",
      "",
      "Example: https://opensea.io/collection/example"
    ].join("\n"),
    MAIN_MENU_KEYBOARD
  );

  await safeSend(
    chatId,
    [
      "Quick Actions",
      "Instant Mint buys right now from your live wallet.",
      "Fund Wallet shows your address, QR, and how short you are for the next buy.",
      "Ready Check tells you if you're actually set.",
      "Receive shows where people should send you funds or NFTs.",
      "Send NFT and Send Token move things out of your live wallet.",
      "Winners shows who is actually winning."
    ].join("\n"),
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Instant Mint", callback_data: "instant:start" },
            { text: "Receive", callback_data: "receive" }
          ],
          [
            { text: "Fund Wallet", callback_data: "fund:wallet" },
            { text: "Ready Check", callback_data: "ready:check" }
          ],
          [
            { text: "Send NFT", callback_data: "sendnft:start" },
            { text: "Send Token", callback_data: "sendtoken:start" }
          ],
          [
            { text: "PnL", callback_data: "pnl:show" },
            { text: `Mode: ${riskMode.label}`, callback_data: "riskmode:panel" }
          ],
          [{ text: "Winners", callback_data: "leaderboard" }]
        ]
      }
    }
  );
}

async function sendWalletMenu(chatId) {
  const user = getUser(chatId);
  const wallet = getActiveWallet(user);
  const lines = [
    "Wallet",
    wallet ? `Live: ${shortAddress(wallet.address)}` : "Live: not set",
    `Saved wallets: ${(user.wallets || []).length}`,
    "",
    "Use a dedicated mint wallet. Keep only what you need inside it."
  ];

  await safeSend(chatId, lines.join("\n"), {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Create Wallet", callback_data: "wallet:create" }],
        [{ text: "Import Wallet", callback_data: "wallet:import" }],
        [{ text: "Switch Wallet", callback_data: "wallet:list" }],
        [{ text: "Export Wallet", callback_data: "wallet:export" }],
        [{ text: "Fund Wallet", callback_data: "fund:wallet" }],
        [
          { text: "Receive", callback_data: "receive" },
          { text: "Send NFT", callback_data: "sendnft:start" }
        ],
        [{ text: "Send Token", callback_data: "sendtoken:start" }]
      ]
    }
  });
}

async function createWallet(chatId) {
  if (!walletEncryptionReady()) {
    await safeSend(chatId, "Wallet creation is down right now. Try again in a moment.");
    return;
  }

  const user = getUser(chatId);
  const wallet = ethers.Wallet.createRandom();
  const walletRecord = {
    id: randomId(8),
    name: `Wallet ${(user.wallets || []).length + 1}`,
    address: wallet.address,
    encryptedPrivateKey: encryptPrivateKey(wallet.privateKey),
    createdAt: Date.now()
  };

  user.wallets = user.wallets || [];
  user.wallets.push(walletRecord);
  user.activeWalletId = walletRecord.id;
  saveDb();

  const privateKeyMsg = await safeSend(
    chatId,
    [
      "New wallet ready.",
      `Address: ${wallet.address}`,
      "",
      "Secret key below. Save it now. This message will disappear in 30 seconds.",
      wallet.privateKey
    ].join("\n")
  );

  if (privateKeyMsg && privateKeyMsg.message_id) {
    setTimeout(() => safeDelete(chatId, privateKeyMsg.message_id), 30000);
  }

  await safeSend(chatId, `Done. Your live wallet is now ${shortAddress(wallet.address)}.`, MAIN_MENU_KEYBOARD);
  armAllAutoMintTimers();
}

async function importWallet(chatId, privateKey) {
  if (!walletEncryptionReady()) {
    await safeSend(chatId, "Wallet import is down right now. Try again in a moment.");
    return;
  }

  const user = getUser(chatId);
  user.state = {};

  let wallet;
  try {
    const normalizedKey = normalizePrivateKey(privateKey);
    wallet = new ethers.Wallet(normalizedKey);
    privateKey = normalizedKey;
  } catch (err) {
    saveDb();
    await safeSend(chatId, "That secret key does not look right. Try again.");
    return;
  }

  user.wallets = user.wallets || [];
  const existing = user.wallets.find((item) => item.address.toLowerCase() === wallet.address.toLowerCase());
  if (existing) {
    existing.encryptedPrivateKey = encryptPrivateKey(privateKey);
    existing.updatedAt = Date.now();
    user.activeWalletId = existing.id;
  } else {
    user.wallets.push({
      id: randomId(8),
      name: `Wallet ${user.wallets.length + 1}`,
      address: wallet.address,
      encryptedPrivateKey: encryptPrivateKey(privateKey),
      createdAt: Date.now()
    });
    user.activeWalletId = user.wallets[user.wallets.length - 1].id;
  }

  saveDb();
  await safeSend(chatId, `Wallet added. You are now using ${shortAddress(wallet.address)}.`, MAIN_MENU_KEYBOARD);
  armAllAutoMintTimers();
}

async function sendWalletList(chatId) {
  const user = getUser(chatId);
  const wallets = user.wallets || [];

  if (!wallets.length) {
    await safeSend(chatId, "You do not have any saved wallets yet.", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Create New Wallet", callback_data: "wallet:create" }],
          [{ text: "Import Wallet", callback_data: "wallet:import" }]
        ]
      }
    });
    return;
  }

  const buttons = wallets.map((wallet) => [{
    text: `${wallet.id === user.activeWalletId ? "[active] " : ""}${shortAddress(wallet.address)}`,
    callback_data: `wallet:switch:${wallet.id}`
  }]);

  await safeSend(chatId, "Pick the wallet you want to use right now:", {
    reply_markup: { inline_keyboard: buttons }
  });
}

async function sendExportWalletMenu(chatId) {
  const user = getUser(chatId);
  const wallets = user.wallets || [];

  if (!wallets.length) {
    await safeSend(chatId, "You do not have any saved wallets yet.", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Create New Wallet", callback_data: "wallet:create" }],
          [{ text: "Import Wallet", callback_data: "wallet:import" }]
        ]
      }
    });
    return;
  }

  const buttons = wallets.map((wallet) => [{
    text: `${wallet.id === user.activeWalletId ? "[active] " : ""}${shortAddress(wallet.address)}`,
    callback_data: `wallet:export_warn:${wallet.id}`
  }]);

  await safeSend(chatId, "Pick the wallet you want to reveal:", {
    reply_markup: { inline_keyboard: buttons }
  });
}

async function sendExportWalletWarning(chatId, walletId) {
  const user = getUser(chatId);
  const wallet = (user.wallets || []).find((item) => item.id === walletId);

  if (!wallet) {
    await safeSend(chatId, "I couldn't find that wallet.");
    return;
  }

  await safeSend(
    chatId,
    [
      "Reveal Wallet",
      `Address: ${wallet.address}`,
      "",
      "This reveals the secret key. Anyone with it can drain the wallet.",
      "The key message disappears in 30 seconds."
    ].join("\n"),
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Reveal Secret Key", callback_data: `wallet:export_confirm:${wallet.id}` }],
          [{ text: "Cancel", callback_data: "wallet:menu" }]
        ]
      }
    }
  );
}

async function exportWallet(chatId, walletId) {
  const user = getUser(chatId);
  const wallet = (user.wallets || []).find((item) => item.id === walletId);

  if (!wallet) {
    await safeSend(chatId, "I couldn't find that wallet.");
    return;
  }

  if (!wallet.encryptedPrivateKey) {
    await safeSend(chatId, "This wallet cannot be exported.");
    return;
  }

  let privateKey;
  try {
    privateKey = decryptPrivateKey(wallet.encryptedPrivateKey);
  } catch (err) {
    await safeSend(chatId, "Export failed. Try again from the wallet menu.");
    return;
  }

  const msg = await safeSend(
    chatId,
    [
      "Secret key",
      `Address: ${wallet.address}`,
      "",
      privateKey,
      "",
      "This message disappears in 30 seconds."
    ].join("\n")
  );

  if (msg && msg.message_id) {
    setTimeout(() => safeDelete(chatId, msg.message_id), 30000);
  }
}

async function switchWallet(chatId, walletId) {
  const user = getUser(chatId);
  const wallet = (user.wallets || []).find((item) => item.id === walletId);

  if (!wallet) {
    await safeSend(chatId, "I couldn't find that wallet.");
    return;
  }

  user.activeWalletId = wallet.id;
  saveDb();
  await safeSend(chatId, `Done. You are now using ${shortAddress(wallet.address)}.`, MAIN_MENU_KEYBOARD);
  armAllAutoMintTimers();
}

async function sendReceiveAddress(chatId) {
  const user = getUser(chatId);
  const wallet = getActiveWallet(user);

  if (!wallet) {
    await safeSend(chatId, "Add a wallet first.", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Create New Wallet", callback_data: "wallet:create" }],
          [{ text: "Import Wallet", callback_data: "wallet:import" }]
        ]
      }
    });
    return;
  }

  await safeSend(
    chatId,
    [
      "Receive",
      "Use this wallet address to receive ETH, coins, or NFTs.",
      "",
      wallet.address
    ].join("\n"),
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Fund Wallet", callback_data: "fund:wallet" }],
          [{ text: "Ready Check", callback_data: "ready:check" }]
        ]
      }
    }
  );
}

async function sendFundWallet(chatId) {
  const user = getUser(chatId);
  const wallet = getActiveWallet(user);

  if (!wallet) {
    await safeSend(chatId, "Add a wallet first, then come back here to fund it.");
    return;
  }

  const funding = await fundingSnapshot(user).catch(() => null);
  const qrUrl = qrCodeUrl(wallet.address);
  const lines = [
    "Fund Wallet",
    `Wallet: ${wallet.address}`,
    funding && funding.network ? `For next mint on: ${funding.network}` : "",
    funding && funding.targetEth ? `Target for next mint: ${funding.targetEth} ETH` : "Target for next mint: not available yet",
    funding && funding.balanceEth ? `Current wallet balance: ${funding.balanceEth} ETH` : "",
    funding && funding.shortfallEth ? `Still short: ${funding.shortfallEth} ETH` : funding && funding.targetEth ? "Still short: 0 ETH" : "",
    "",
    "Scan the QR or copy the wallet address above."
  ].filter(Boolean).join("\n");

  await safeSendPhoto(chatId, qrUrl, {
    caption: lines,
    reply_markup: {
      inline_keyboard: [
        [{ text: "Receive", callback_data: "receive" }],
        [{ text: "Ready Check", callback_data: "ready:check" }]
      ]
    }
  });
}

async function sendReadyCheck(chatId) {
  const user = getUser(chatId);
  const wallet = getActiveWallet(user);
  const nextMint = nextLiveMint(user);
  const funding = await fundingSnapshot(user).catch(() => null);
  const riskMode = riskModeForUser(user);

  const lines = [
    "Ready Check",
    `Wallet loaded: ${wallet ? "yes" : "no"}`,
    `Live mint tracked: ${nextMint ? "yes" : "no"}`,
    `Gas cap set: ${nextMint && (nextMint.gasCapEth || nextMint.recommendedGasCapEth) ? "yes" : "no"}`,
    `Mode: ${riskMode.label}`,
    nextMint ? `Next mint: ${nextMint.mintName}` : "Next mint: not set",
    nextMint ? `Next buy time: ${formatDateTime(nextMint.mintTime)}` : "",
    funding && funding.targetEth ? `Enough ETH: ${Number(funding.shortfallEth || 0) > 0 ? "no" : "yes"}` : "Enough ETH: unknown",
    funding && funding.targetEth ? `Target: ${funding.targetEth} ETH` : "",
    funding && funding.balanceEth ? `Wallet balance: ${funding.balanceEth} ETH` : "",
    funding && funding.shortfallEth && Number(funding.shortfallEth) > 0 ? `Still short: ${funding.shortfallEth} ETH` : ""
  ].filter(Boolean).join("\n");

  await safeSend(chatId, lines, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Fund Wallet", callback_data: "fund:wallet" },
          { text: `Mode: ${riskMode.label}`, callback_data: "riskmode:panel" }
        ],
        nextMint ? [{ text: "Open Live Status", callback_data: "status:open" }] : []
      ].filter((row) => row.length)
    }
  });
}

async function sendPnlDashboard(chatId) {
  const user = getUser(chatId);
  const pnl = await buildPnlDashboard(user);

  await safeSend(
    chatId,
    [
      "PnL",
      `Total spent: ${pnl.totalSpentEth} ETH`,
      `Total wins: ${pnl.totalWins}`,
      `Total realized profit: ${pnl.totalRealizedProfitEth} ETH`,
      `Unrealized profit: ${pnl.totalUnrealizedProfitEth} ETH`,
      `Best hit: ${pnl.bestHit}`,
      `Worst hit: ${pnl.worstHit}`
    ].join("\n"),
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Winners", callback_data: "leaderboard" }],
          [{ text: "Open Live Status", callback_data: "status:open" }]
        ]
      }
    }
  );
}

async function sendRiskModePanel(chatId) {
  const user = getUser(chatId);
  const active = riskModeForUser(user);
  await safeSend(
    chatId,
    [
      "Risk Mode",
      `Current mode: ${active.label}`,
      "",
      "Safe keeps gas tighter.",
      "Fast is the default balance.",
      "Degenerate pushes harder when gas starts moving."
    ].join("\n"),
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Safe", callback_data: "riskmode:set:safe" }],
          [{ text: "Fast", callback_data: "riskmode:set:fast" }],
          [{ text: "Degenerate", callback_data: "riskmode:set:degenerate" }]
        ]
      }
    }
  );
}

async function setRiskMode(chatId, mode) {
  const user = getUser(chatId);
  const riskMode = RISK_MODES[normalizeRiskMode(mode)] || RISK_MODES.fast;
  user.riskMode = riskMode.key;
  user.gasWarMode = riskMode.gasWarMode;

  if (user.pendingMint) {
    user.pendingMint.riskMode = riskMode.key;
    user.pendingMint.gasWarMode = riskMode.gasWarMode;
    user.pendingMint.flashbotsEnabled = riskMode.flashbotsEnabled;
    user.pendingMint.updatedAt = Date.now();
  }

  for (const mint of user.mints || []) {
    if (mint.completedAt) continue;
    mint.riskMode = riskMode.key;
    mint.gasWarMode = riskMode.gasWarMode;
    mint.flashbotsEnabled = riskMode.flashbotsEnabled;
    mint.updatedAt = Date.now();
  }

  saveDb();
  await safeSend(
    chatId,
    [
      `Mode set: ${riskMode.label}`,
      riskMode.key === "safe"
        ? "This keeps gas tighter and calmer."
        : riskMode.key === "degenerate"
          ? "This pushes harder when things get crowded."
          : "This keeps you balanced between cost and speed."
    ].join("\n")
  );
}

async function startInstantMintFlow(chatId) {
  const user = getUser(chatId);
  const wallet = getActiveWallet(user);

  if (!wallet) {
    await safeSend(chatId, "Add a wallet first. Instant Mint uses your live wallet.");
    return;
  }

  user.state = { mode: "awaiting_instant_target" };
  saveDb();
  await safeSend(
    chatId,
    [
      "Instant Mint",
      "Paste a mint page or collection address.",
      "The bot will try to buy right away from your live wallet and then show you what happened."
    ].join("\n")
  );
}

async function handleInstantMintInput(chatId, text) {
  const user = getUser(chatId);
  const wallet = getActiveWallet(user);

  if (!wallet) {
    user.state = {};
    saveDb();
    await safeSend(chatId, "No active wallet yet. Add one first.");
    return;
  }

  const draft = await draftFromMintInput(text, "public");
  if (!draft.contractAddress) {
    logUnhandled(chatId, "instant_mint_bad_target", text);
    await safeSend(chatId, "I couldn't read that mint page. Paste the OpenSea link again.");
    return;
  }

  user.state = {};
  const verified = await verifyMintDetailsFromContract(draft).catch(() => draft);
  const mint = buildMintRecord({ ...verified, mintTime: Date.now() - AUTO_MINT_DELAY_MS }, draft);
  mint.confirmed = true;
  mint.confirmedAt = Date.now();
  mint.instant = true;
  mint.autoMintEnabled = true;
  mint.remindersEnabled = false;
  mint.riskMode = riskModeForUser(user).key;
  mint.gasWarMode = riskModeForUser(user).gasWarMode;
  mint.flashbotsEnabled = riskModeForUser(user).flashbotsEnabled;
  user.mints = user.mints || [];
  user.mints.push(mint);
  saveDb();

  await safeSend(chatId, `Buying ${mint.mintName} now... stay ready.`);
  await maybeAttemptAutoMint(chatId, mint.id, "instant");
}

async function startSendTokenFlow(chatId) {
  const user = getUser(chatId);
  const wallet = getActiveWallet(user);

  if (!wallet) {
    await safeSend(chatId, "Add a wallet first. Send Token uses your live wallet.");
    return;
  }

  user.state = { mode: "awaiting_send_token" };
  saveDb();
  await safeSend(
    chatId,
    [
      "Send Token",
      "Reply with the coin address, the amount, and the network if needed.",
      "Example: 0xTokenAddress 25 base"
    ].join("\n")
  );
}

async function handleSendTokenDetails(chatId, text) {
  const user = getUser(chatId);
  const tokenAddress = extractAddress(text);
  const amountMatch = text.match(/(?:^|\s)(\d+(?:\.\d+)?)(?:\s|$)/);
  const chain = text.toLowerCase().includes("base") ? CHAIN_CONFIGS.base : getDefaultChainConfig();

  if (!tokenAddress || !amountMatch) {
    await safeSend(chatId, "Send the coin address and amount. Example: 0xTokenAddress 25 base");
    return;
  }

  user.state = {
    mode: "awaiting_send_token_destination",
    tokenAddress,
    amount: amountMatch[1],
    chainId: chain.chainId
  };
  saveDb();
  await safeSend(chatId, "Now send the wallet address you want this sent to.");
}

async function handleSendTokenDestination(chatId, text) {
  const user = getUser(chatId);
  const walletRecord = getActiveWallet(user);
  const destination = extractAddress(text);
  const state = user.state || {};

  if (!destination) {
    await safeSend(chatId, "Send a valid destination wallet address.");
    return;
  }

  user.state = {};
  saveDb();

  try {
    const result = await executeTokenTransfer(user, walletRecord, {
      tokenAddress: state.tokenAddress,
      amount: state.amount,
      destination,
      chainId: state.chainId
    });
    await sendTxResult(chatId, "Token transfer submitted.", result.hash, state.chainId);
  } catch (err) {
    await safeSend(chatId, userFriendlyError(err, "That send did not go through. Check your balance and try again."));
  }
}

async function startSendNftFlow(chatId) {
  const user = getUser(chatId);
  const wallet = getActiveWallet(user);

  if (!wallet) {
    await safeSend(chatId, "Add a wallet first. Send NFT uses your live wallet.");
    return;
  }

  const nfts = await fetchWalletNfts(wallet.address, 12);
  if (!nfts.length) {
    await safeSend(chatId, "I couldn't find any NFTs in your live wallet right now.");
    return;
  }

  user.nftSelections = {};
  const buttons = nfts.map((nft) => {
    const id = randomId(4);
    user.nftSelections[id] = nft;
    return [{
      text: `${nft.name || nft.tokenId || "NFT"} (${nft.chainName})`.slice(0, 60),
      callback_data: `sendnft:pick:${id}`
    }];
  });
  saveDb();

  await safeSend(
    chatId,
    "Send NFT\nPick the NFT you want to send. After that, send the wallet address you want it sent to.",
    { reply_markup: { inline_keyboard: buttons } }
  );
}

async function pickNftToSend(chatId, nftId) {
  const user = getUser(chatId);
  const nft = user.nftSelections && user.nftSelections[nftId];

  if (!nft) {
    await safeSend(chatId, "That pick expired. Open Send NFT again.");
    return;
  }

  user.state = { mode: "awaiting_send_nft_destination", nft };
  saveDb();
  await safeSend(chatId, `Picked ${nft.name || nft.tokenId}. Now send the wallet address you want it sent to.`);
}

async function handleSendNftDestination(chatId, text) {
  const user = getUser(chatId);
  const walletRecord = getActiveWallet(user);
  const destination = extractAddress(text);
  const nft = user.state && user.state.nft;

  if (!destination) {
    await safeSend(chatId, "Send a valid destination wallet address.");
    return;
  }

  user.state = {};
  saveDb();

  try {
    const result = await executeNftTransfer(user, walletRecord, nft, destination);
    await sendTxResult(chatId, "NFT transfer submitted.", result.hash, nft.chainId);
  } catch (err) {
    await safeSend(chatId, userFriendlyError(err, "That send did not go through. Check the item and try again."));
  }
}

async function startTrackFlow(chatId) {
  const user = getUser(chatId);
  user.state = { mode: "awaiting_track_input" };
  saveDb();

  await safeSend(
    chatId,
    [
      "Track Mint",
      "Paste the OpenSea mint page.",
      "",
      "Example:",
      "https://opensea.io/collection/example"
    ].join("\n")
  );
}

async function handleTrackInput(chatId, text) {
  const user = getUser(chatId);
  const draft = await draftFromMintInput(text, extractTier(text));

  const openSea = parseOpenSeaInput(text);
  const directAddress = extractAddress(text);

  if (openSea.isOpenSea || openSea.slug || openSea.contractAddress || directAddress) {
    if (openSea.isOpenSea) {
      draft.sourceUrl = text;
      draft.openSeaPath = openSea.path || null;
      draft.chainId = openSea.chainId || null;
    }

    if (openSea.slug) {
      draft.sourceUrl = text;
      draft.openSeaSlug = openSea.slug;

      try {
        const collection = await fetchOpenSeaCollection(openSea.slug, draft.chainId);
        draft.mintName = collection.name || openSea.slug;
        draft.contractAddress = collection.contractAddress || null;
        draft.chainId = collection.chainId || draft.chainId;
        draft.chainName = collection.chainName || null;
        draft.metadata = collection;
      } catch (err) {
        draft.mintName = openSea.slug;
        draft.metadataError = shortError(err);
      }
    }

    if (openSea.contractAddress || directAddress) {
      draft.contractAddress = openSea.contractAddress || directAddress;
      draft.sourceUrl = openSea.contractAddress ? text : draft.sourceUrl || null;
      draft.chainId = openSea.chainId || draft.chainId || getDefaultChainConfig().chainId;
    }

    if (!draft.contractAddress) {
      user.state = { mode: "awaiting_track_input" };
      saveDb();
      await safeSend(chatId, "I couldn't read that mint page. Paste the OpenSea link again.");
      return;
    }

    if (draft.userTier) {
      await verifyAndCreatePendingMint(chatId, draft);
      return;
    }

    user.state = { mode: "awaiting_stage", draft };
    saveDb();
    await safeSend(chatId, "Which access do you have for this drop?", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "GTD", callback_data: "stage:gtd" },
            { text: "OG", callback_data: "stage:og" }
          ],
          [
            { text: "WL", callback_data: "stage:wl" },
            { text: "Public", callback_data: "stage:public" }
          ]
        ]
      }
    });
    return;
  }

  await safeSend(chatId, "I couldn't read that mint page. Paste the OpenSea link again.");
}

async function draftFromMintInput(text, tier = null) {
  const draft = {
    quantity: extractQuantity(text) || 1,
    userTier: tier || extractTier(text),
    chainId: null
  };

  const openSea = parseOpenSeaInput(text);
  const directAddress = extractAddress(text);

  if (openSea.isOpenSea) {
    draft.sourceUrl = text;
    draft.openSeaPath = openSea.path || null;
    draft.chainId = openSea.chainId || null;
  }

  if (openSea.slug) {
    draft.sourceUrl = text;
    draft.openSeaSlug = openSea.slug;

    try {
      const collection = await fetchOpenSeaCollection(openSea.slug, draft.chainId);
      draft.mintName = collection.name || openSea.slug;
      draft.contractAddress = collection.contractAddress || null;
      draft.chainId = collection.chainId || draft.chainId;
      draft.chainName = collection.chainName || null;
      draft.metadata = collection;
    } catch (err) {
      draft.mintName = openSea.slug;
      draft.metadataError = shortError(err);
    }
  }

  if (openSea.contractAddress || directAddress) {
    draft.contractAddress = openSea.contractAddress || directAddress;
    draft.sourceUrl = openSea.contractAddress ? text : draft.sourceUrl || null;
    draft.chainId = openSea.chainId || draft.chainId || getDefaultChainConfig().chainId;
  }

  if (!draft.mintName) {
    draft.mintName = draft.openSeaSlug || (draft.contractAddress ? shortAddress(draft.contractAddress) : "NFT Mint");
  }

  return draft;
}

async function verifyAndCreatePendingMint(chatId, draft) {
  const user = getUser(chatId);
  await safeSend(chatId, "Checking the mint details now...");

  let verified;
  try {
    verified = await verifyMintDetailsFromContract(draft);
  } catch (err) {
    user.state = { mode: "awaiting_track_input" };
    saveDb();
    await safeSend(chatId, userFriendlyError(err, "I couldn't lock this one in. Try another page or use Instant Mint."));
    return;
  }

  const mint = buildMintRecord(verified, draft);
  const riskMode = riskModeForUser(user);
  mint.riskMode = riskMode.key;
  mint.gasWarMode = riskMode.gasWarMode;
  mint.flashbotsEnabled = riskMode.flashbotsEnabled;
  if (!mint.mintTime) {
    user.state = { mode: "awaiting_track_input" };
    saveDb();
    await safeSend(chatId, "I couldn't find your mint time from that page. Paste the OpenSea link again.");
    return;
  }

  user.pendingMint = mint;
  user.state = {};
  saveDb();

  await safeSend(chatId, formatMintCard(chatId, mint), {
    reply_markup: mintConfirmKeyboard(mint)
  });
}

async function verifyMintDetailsFromContract(draft) {
  if (!draft.contractAddress || !ethers.isAddress(draft.contractAddress)) {
    throw new Error("Contract address is missing");
  }

  const chainId = await resolveMintChainId(draft.contractAddress, draft.chainId);
  const chain = getChainConfig(chainId);
  const provider = getProvider(chain.chainId);
  const abi = await resolveContractAbi({
    contractAddress: draft.contractAddress,
    chainId: chain.chainId
  });
  const readAbi = mergeAbi(abi, READ_ONLY_ABI);
  const contract = new ethers.Contract(draft.contractAddress, readAbi, provider);
  const phaseTimes = await readPhaseTimes(contract);
  const priceEth = await readMintPrice(contract, draft.userTier);
  const mintFunction = detectMintFunctionName(new ethers.Interface(abi), draft.userTier);
  const userTier = normalizeTier(draft.userTier) || "public";
  const phaseKey = `${userTier}Time`;

  return {
    ...draft,
    ...phaseTimes,
    chainId: chain.chainId,
    chainName: chain.chainName,
    userTier,
    mintTime: phaseTimes[phaseKey] || null,
    priceEth: priceEth || draft.priceEth || null,
    mintFunction: mintFunction || draft.mintFunction || null
  };
}

async function readPhaseTimes(contract) {
  const result = {};

  for (const [tier, names] of Object.entries(PHASE_TIME_READS)) {
    for (const name of names) {
      const timestamp = await tryReadTimestamp(contract, name);
      if (timestamp) {
        result[`${tier}Time`] = timestamp;
        break;
      }
    }
  }

  return result;
}

async function resolveMintChainId(contractAddress, preferredChainId) {
  const preferred = getChainConfig(preferredChainId);

  if (preferred && providersByChainId.has(preferred.chainId)) {
    const code = await providersByChainId.get(preferred.chainId).getCode(contractAddress).catch(() => "0x");
    if (code && code !== "0x") return preferred.chainId;
  }

  for (const chain of configuredChains()) {
    if (preferred && chain.chainId === preferred.chainId) continue;
    const code = await providersByChainId.get(chain.chainId).getCode(contractAddress).catch(() => "0x");
    if (code && code !== "0x") return chain.chainId;
  }

  if (preferred) return preferred.chainId;
  return getDefaultChainConfig().chainId;
}

async function readMintPrice(contract, tier) {
  const names = [
    ...(PHASE_PRICE_READS[normalizeTier(tier)] || []),
    ...PRICE_READS
  ];

  for (const name of [...new Set(names)]) {
    const value = await tryReadUint(contract, name);
    if (value != null) {
      return ethers.formatEther(value);
    }
  }

  return null;
}

async function tryReadTimestamp(contract, name) {
  const value = await tryReadUint(contract, name);
  if (value == null) return null;

  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return timestamp > 100000000000 ? timestamp : timestamp * 1000;
}

async function tryReadUint(contract, name) {
  try {
    if (typeof contract[name] !== "function") return null;
    const value = await contract[name]();
    if (typeof value === "bigint") return value;
    if (value && typeof value.toString === "function") return BigInt(value.toString());
    return BigInt(value);
  } catch (err) {
    return null;
  }
}

function detectMintFunctionName(iface, tier) {
  const fragments = iface.fragments
    .filter((fragment) => fragment.type === "function")
    .filter((fragment) => ["payable", "nonpayable"].includes(fragment.stateMutability));
  const tierName = normalizeTier(tier);
  const tierHints = {
    gtd: ["gtd", "guaranteed"],
    og: ["og", "presale", "private"],
    wl: ["wl", "white", "allow", "pre"],
    public: ["public", "mint"]
  }[tierName] || [];

  const tierMatch = fragments.find((fragment) => {
    const lower = fragment.name.toLowerCase();
    return tierHints.some((hint) => lower.includes(hint)) && MINT_FUNCTION_PRIORITY.includes(fragment.name);
  });

  if (tierMatch) return tierMatch.name;

  const fallback = fragments.find((fragment) => MINT_FUNCTION_PRIORITY.includes(fragment.name));
  return fallback ? fallback.name : null;
}

function mergeAbi(primaryAbi, extraAbi) {
  const values = [];
  const seen = new Set();

  for (const item of [...primaryAbi, ...extraAbi]) {
    const key = typeof item === "string" ? item : JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(item);
  }

  return values;
}

function rpcUrlsFor(prefix, legacyUrl = null) {
  const urls = [
    process.env[`${prefix}_RPC_URL_1`],
    process.env[`${prefix}_RPC_URL_2`],
    process.env[`${prefix}_RPC_URL_3`],
    process.env[`${prefix}_RPC_URL`],
    legacyUrl,
    prefix === "ETHEREUM" && LEGACY_CHAIN_ID === 1 ? process.env.RPC_URL_1 : null,
    prefix === "ETHEREUM" && LEGACY_CHAIN_ID === 1 ? process.env.RPC_URL_2 : null,
    prefix === "ETHEREUM" && LEGACY_CHAIN_ID === 1 ? process.env.RPC_URL_3 : null,
    prefix === "BASE" && LEGACY_CHAIN_ID === 8453 ? process.env.RPC_URL_1 : null,
    prefix === "BASE" && LEGACY_CHAIN_ID === 8453 ? process.env.RPC_URL_2 : null,
    prefix === "BASE" && LEGACY_CHAIN_ID === 8453 ? process.env.RPC_URL_3 : null
  ].filter(Boolean);

  return [...new Set(urls)];
}

function makeProvider(chain) {
  const providers = chain.rpcUrls.map((url) => new ethers.JsonRpcProvider(url, chain.chainId));

  if (providers.length === 1) {
    return providers[0];
  }

  return new ethers.FallbackProvider(
    providers.map((provider, index) => ({
      provider,
      priority: index + 1,
      weight: 1,
      stallTimeout: 1000
    })),
    1
  );
}

function getChainConfig(chainIdOrKey) {
  if (!chainIdOrKey) {
    return CHAIN_CONFIGS.ethereum;
  }

  const normalized = String(chainIdOrKey).toLowerCase();
  return Object.values(CHAIN_CONFIGS).find((chain) => (
    String(chain.chainId) === normalized
      || chain.key === normalized
      || chain.openSeaChain === normalized
      || chain.chainName.toLowerCase() === normalized
  )) || null;
}

function getDefaultChainConfig() {
  return getChainConfig(LEGACY_CHAIN_ID) || CHAIN_CONFIGS.ethereum;
}

function getProvider(chainIdOrKey) {
  const chain = getChainConfig(chainIdOrKey) || getDefaultChainConfig();
  const provider = providersByChainId.get(chain.chainId);

  if (!provider) {
    throw new Error(`${chain.chainName} RPC is not configured`);
  }

  return provider;
}

function configuredChains() {
  return Object.values(CHAIN_CONFIGS).filter((chain) => providersByChainId.has(chain.chainId));
}

function buildMintRecord(parsed, draft) {
  const merged = { ...(draft || {}), ...(parsed || {}) };
  const userTier = normalizeTier(merged.userTier) || "public";
  const phaseKey = `${userTier}Time`;
  const phaseTime = normalizeTimestamp(merged[phaseKey]);
  const mintTime = normalizeTimestamp(merged.mintTime) || phaseTime || firstKnownPhaseTime(merged);
  const chain = getChainConfig(merged.chainId || merged.chainName) || getDefaultChainConfig();

  const mint = {
    id: randomId(10),
    mintName: merged.mintName || merged.openSeaSlug || "NFT Mint",
    userTier,
    gtdTime: normalizeTimestamp(merged.gtdTime),
    ogTime: normalizeTimestamp(merged.ogTime),
    wlTime: normalizeTimestamp(merged.wlTime),
    publicTime: normalizeTimestamp(merged.publicTime),
    mintTime,
    contractAddress: merged.contractAddress && ethers.isAddress(merged.contractAddress)
      ? ethers.getAddress(merged.contractAddress)
      : null,
    chainId: chain.chainId,
    chainName: chain.chainName,
    priceEth: merged.priceEth != null ? String(merged.priceEth) : null,
    totalValueEth: merged.totalValueEth != null ? String(merged.totalValueEth) : null,
    quantity: Math.max(1, Number(merged.quantity || 1)),
    mintFunction: merged.mintFunction || null,
    mintArgs: Array.isArray(merged.mintArgs) ? merged.mintArgs : null,
    sourceUrl: merged.sourceUrl || null,
    openSeaSlug: merged.openSeaSlug || null,
    metadata: merged.metadata || null,
    riskMode: normalizeRiskMode(merged.riskMode),
    confirmed: false,
    remindersEnabled: merged.remindersEnabled !== false,
    autoMintEnabled: merged.autoMintEnabled !== false,
    flashbotsEnabled: Boolean(merged.flashbotsEnabled),
    gasWarMode: Boolean(merged.gasWarMode),
    gasCapEth: merged.gasCapEth || null,
    recommendedGasCapEth: merged.recommendedGasCapEth || null,
    targetListPriceEth: merged.targetListPriceEth || null,
    profitAlertMultiple: merged.profitAlertMultiple || null,
    firedReminders: [],
    openAlertSent: false,
    autoMint: {
      scheduled: false,
      attempts: 0,
      success: false,
      inFlight: false,
      txHash: null,
      lastError: null,
      lastAttemptAt: null
    },
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  if (!mint[phaseKey] && mint.mintTime) {
    mint[phaseKey] = mint.mintTime;
  }

  return mint;
}

function mintConfirmKeyboard(mint) {
  return {
    inline_keyboard: [
      [
        { text: "Lock It In", callback_data: `confirm:${mint.id}` },
        { text: "Cancel", callback_data: `cancel:${mint.id}` }
      ],
      [
        {
          text: `Reminders ${mint.remindersEnabled ? "On" : "Off"}`,
          callback_data: `toggle:reminders:${mint.id}`
        },
        {
          text: `Auto-Buy ${mint.autoMintEnabled ? "On" : "Off"}`,
          callback_data: `toggle:auto:${mint.id}`
        }
      ],
      [
        {
          text: `Private Send ${mint.flashbotsEnabled ? "On" : "Off"}`,
          callback_data: `toggle:flashbots:${mint.id}`
        },
        {
          text: `Gas War ${mint.gasWarMode ? "On" : "Off"}`,
          callback_data: `toggle:gaswar:${mint.id}`
        }
      ],
      [
        { text: "Sell Target", callback_data: `target_list:${mint.id}` }
      ],
      [
        { text: "Profit Ping", callback_data: `profit_threshold:${mint.id}` }
      ]
    ]
  };
}

function formatMintCard(chatId, mint) {
  const user = getUser(chatId);
  const wallet = getActiveWallet(user);
  const pendingFeeEth = pendingFeeForChain(user, mint.chainId);
  const riskMode = riskModeForMint(user, mint);
  const autoMode = mint.autoMintEnabled
    ? `Auto-buy fires ${AUTO_MINT_DELAY_MS / 1000}s after your window opens and keeps trying every ${POLL_INTERVAL_MS / 1000}s during the retry window.`
    : "Auto-buy is off. The bot will only remind you and ping when the window opens.";

  return [
    `${mint.mintName}`,
    "",
    `Your lane: ${mint.userTier.toUpperCase()}`,
    `Your time: ${formatDateTime(mint.mintTime)}`,
    `Countdown: ${formatDuration(mint.mintTime - Date.now())}`,
    "",
    "Full drop schedule:",
    `GTD: ${formatOptionalTime(mint.gtdTime)}`,
    `OG: ${formatOptionalTime(mint.ogTime)}`,
    `WL: ${formatOptionalTime(mint.wlTime)}`,
    `Public: ${formatOptionalTime(mint.publicTime)}`,
    "",
    "Your setup:",
    `Network: ${mint.chainName}`,
    `Mint page: ${mint.contractAddress ? "ready" : "not ready"}`,
    `Buy price: ${mint.priceEth || mint.totalValueEth || "not set"} ETH`,
    `Quantity: ${mint.quantity}`,
    `Wallet: ${wallet ? shortAddress(wallet.address) : "not set"}`,
    `Mode: ${riskMode.label}`,
    `Max gas spend: ${mint.gasCapEth || mint.recommendedGasCapEth || "set after lock-in"} ETH`,
    `Gas War: ${mint.gasWarMode ? "on" : "off"}`,
    `Private send: ${mint.flashbotsEnabled ? "on" : "off"}`,
    pendingProfitAgreementLine(user, mint.chainId),
    "",
    "What happens next:",
    autoMode,
    "",
    "Platform fee: 5% of profit only if this NFT sells above mint price. No fee is taken on a loss or break-even sale.",
    "",
    `Reminders: ${mint.remindersEnabled ? "on" : "off"}`,
    `Auto-buy: ${mint.autoMintEnabled ? "on" : "off"}`,
    "",
    "Lock this in only if it all looks right."
  ].filter((line) => line !== "").join("\n");
}

async function confirmMint(chatId, mintId) {
  const user = getUser(chatId);
  const mint = user.pendingMint;

  if (!mint || mint.id !== mintId) {
    await safeSend(chatId, "That setup is gone. Start again with a fresh mint page.");
    return;
  }

  mint.confirmed = true;
  mint.confirmedAt = Date.now();
  mint.updatedAt = Date.now();
  user.mints = user.mints || [];
  user.mints.push(mint);
  user.pendingMint = null;
  user.state = {};
  saveDb();

  await safeSend(
    chatId,
    [
      `${mint.mintName} locked in.`,
      `Your ${mint.userTier.toUpperCase()} lane opens at ${formatDateTime(mint.mintTime)}.`,
      "",
      mint.autoMintEnabled
        ? "Auto-buy is on. You are set."
        : "Auto-buy is off. You will still get reminders if they are on.",
      "",
      `Reminders: ${REMINDERS.map((item) => item.label).join(", ")}`
    ].join("\n"),
    MAIN_MENU_KEYBOARD
  );

  scheduleAutoMint(chatId, mint);
}

async function askGasCapApproval(chatId, mintId) {
  const user = getUser(chatId);
  const mint = user.pendingMint;

  if (!mint || mint.id !== mintId) {
    await safeSend(chatId, "That setup is gone. Start again with a fresh mint page.");
    return;
  }

  const estimate = await estimateGasCap(chatId, user, mint).catch((err) => ({
    gasCapEth: ethers.formatEther(DEFAULT_GAS_LIMIT * ethers.parseUnits("30", "gwei")),
    gasPercent: "unknown",
    note: "Using a safe default because live estimation is unavailable."
  }));

  mint.recommendedGasCapEth = estimate.gasCapEth;
  mint.gasCapEth = mint.gasCapEth || estimate.gasCapEth;
  mint.gasEstimateNote = estimate.note || null;
  user.state = { mode: "awaiting_gas_cap_custom", mintId };
  saveDb();

  await safeSend(
    chatId,
    [
      `${mint.mintName} gas check`,
      "",
      `Suggested max gas spend: ${estimate.gasCapEth} ETH`,
      `Share of your total spend: ${estimate.gasPercent}`,
      estimate.note ? `Note: ${estimate.note}` : "",
      "",
      "Use this amount, or reply with your own number like 0.015.",
      "If gas goes above this amount at mint time, the bot will skip the buy instead of overpaying."
    ].filter(Boolean).join("\n"),
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: `Use ${estimate.gasCapEth} ETH`, callback_data: `gascap:approve:${mint.id}` }],
          [{ text: "Set My Own", callback_data: `gascap:custom:${mint.id}` }]
        ]
      }
    }
  );
}

async function approveRecommendedGasCap(chatId, mintId) {
  const user = getUser(chatId);
  const mint = user.pendingMint;

  if (!mint || mint.id !== mintId) {
    await safeSend(chatId, "That setup is gone. Start again with a fresh mint page.");
    return;
  }

  mint.gasCapEth = mint.recommendedGasCapEth || mint.gasCapEth;
  user.state = {};
  saveDb();
  await confirmMint(chatId, mintId);
}

async function handleCustomGasCap(chatId, text) {
  const user = getUser(chatId);
  const mintId = user.state && user.state.mintId;
  const mint = user.pendingMint && user.pendingMint.id === mintId
    ? user.pendingMint
    : (user.mints || []).find((item) => item.id === mintId);
  const value = parseEthAmount(text);

  if (!mint || !value || value <= 0) {
    await safeSend(chatId, "Send a clean amount like 0.015");
    return;
  }

  mint.gasCapEth = String(value);
  mint.updatedAt = Date.now();
  user.state = {};
  saveDb();

  if (user.pendingMint && user.pendingMint.id === mintId) {
    await confirmMint(chatId, mintId);
  } else {
    await safeSend(chatId, `Saved. Max gas spend is now ${value} ETH for ${mint.mintName}.`);
  }
}

async function handleTargetListPrice(chatId, text) {
  const user = getUser(chatId);
  const mintId = user.state && user.state.mintId;
  const mint = findMintById(user, mintId) || user.pendingMint;
  const value = parseEthAmount(text);

  if (!mint || !value || value <= 0) {
    await safeSend(chatId, "Send a clean sell price like 0.25");
    return;
  }

  mint.targetListPriceEth = String(value);
  mint.updatedAt = Date.now();
  user.state = {};
  saveDb();
  await safeSend(chatId, `Saved. Sell target is now ${value} ETH for ${mint.mintName}.`);
}

async function handleListPrice(chatId, text) {
  const user = getUser(chatId);
  const tokenRecordId = user.state && user.state.tokenRecordId;
  const token = findMintedToken(user, tokenRecordId);
  const value = parseEthAmount(text);

  if (!token || !value || value <= 0) {
    await safeSend(chatId, "Send a clean sell price like 0.25");
    return;
  }

  user.state = {};
  saveDb();

  try {
    await safeSend(
      chatId,
      [
        "Listing your item now.",
        `Item: ${displayMintedTokenName(token)}`,
        `Sell price: ${value} ETH`
      ].join("\n")
    );

    const result = await createOpenSeaListing(user, token, value);
    token.lastListedAt = Date.now();
    token.lastListPriceEth = String(value);
    token.lastListingOrderHash = result.orderHash || null;
    token.updatedAt = Date.now();
    saveDb();

    await safeSend(
      chatId,
      [
        "Your item is now listed.",
        `Item: ${displayMintedTokenName(token)}`,
        `Sell price: ${value} ETH`,
        result.marketplace ? `Marketplace: ${result.marketplace}` : ""
      ].filter(Boolean).join("\n"),
      result.assetUrl
        ? {
            reply_markup: {
              inline_keyboard: [[{ text: "View Listing", url: result.assetUrl }]]
            }
          }
        : {}
    );
  } catch (err) {
    await safeSend(chatId, userFriendlyError(err, "I could not finish the listing. Try again in a moment."));
  }
}

async function handleProfitThreshold(chatId, text) {
  const user = getUser(chatId);
  const mintId = user.state && user.state.mintId;
  const mint = findMintById(user, mintId) || user.pendingMint;
  const value = Number(String(text).trim());

  if (!mint || !Number.isFinite(value) || value <= 1) {
    await safeSend(chatId, "Send a clean alert level above 1. Example: 2");
    return;
  }

  mint.profitAlertMultiple = value;
  mint.updatedAt = Date.now();
  user.state = {};
  saveDb();
  await safeSend(chatId, `Saved. Profit ping is now ${value}x for ${mint.mintName}.`);
}

async function clearMints(chatId) {
  const user = getUser(chatId);
  for (const mint of user.mints || []) {
    clearAutoMintTimer(chatId, mint.id);
  }
  user.mints = [];
  user.pendingMint = null;
  user.state = {};
  saveDb();
  await safeSend(chatId, "All live mints were cleared. Your wallets stayed exactly where they are.", MAIN_MENU_KEYBOARD);
}

function scheduleAutoMint(chatId, mint) {
  if (!mint || !mint.confirmed || !mint.autoMintEnabled || !mint.mintTime) return;
  if (mint.autoMint && mint.autoMint.success) return;
  if (!mint.contractAddress) return;

  const user = getUser(chatId);
  const wallet = getActiveWallet(user);
  if (!wallet) return;

  const fireAt = Number(mint.mintTime) + AUTO_MINT_DELAY_MS;
  const now = Date.now();
  const retryUntil = Number(mint.mintTime) + AUTO_MINT_RETRY_WINDOW_MS;

  if (now > retryUntil) return;

  const timerKey = timerKeyFor(chatId, mint.id);
  if (activeAutoMintTimers.has(timerKey)) return;

  const delay = Math.max(1000, fireAt - now);
  const timer = setTimeout(async () => {
    activeAutoMintTimers.delete(timerKey);
    await maybeAttemptAutoMint(chatId, mint.id, "timer");
  }, delay);

  activeAutoMintTimers.set(timerKey, timer);
  mint.autoMint = mint.autoMint || {};
  mint.autoMint.scheduled = true;
  saveDb();
}

function clearAutoMintTimer(chatId, mintId) {
  const key = timerKeyFor(chatId, mintId);
  const timer = activeAutoMintTimers.get(key);
  if (timer) clearTimeout(timer);
  activeAutoMintTimers.delete(key);
}

function armAllAutoMintTimers() {
  for (const [chatId, user] of Object.entries(db.users || {})) {
    for (const mint of user.mints || []) {
      scheduleAutoMint(chatId, mint);
    }
  }
}

async function checkConfirmedMints() {
  const now = Date.now();

  for (const [chatId, user] of Object.entries(db.users || {})) {
    for (const mint of user.mints || []) {
      if (!mint.confirmed || !mint.mintTime) continue;

      if (mint.remindersEnabled) {
        for (const reminder of REMINDERS) {
          const dueAt = mint.mintTime - reminder.seconds * 1000;
          const notTooLate = now < mint.mintTime + 60 * 60 * 1000;

          if (now >= dueAt && notTooLate && !mint.firedReminders.includes(reminder.key)) {
            mint.firedReminders.push(reminder.key);
            mint.updatedAt = now;
            saveDb();
            await safeSend(
              chatId,
              `${reminder.label} reminder: ${mint.mintName} opens for you at ${formatDateTime(mint.mintTime)}.`
            );
          }
        }
      }

      if (now >= mint.mintTime && !mint.openAlertSent) {
        mint.openAlertSent = true;
        mint.updatedAt = now;
        saveDb();
        await safeSend(chatId, `${mint.mintName} is live for you now.`);
      }

      if (mint.autoMintEnabled) {
        await maybeAttemptAutoMint(chatId, mint.id, "poll");
      }
    }
  }
}

async function maybeAttemptAutoMint(chatId, mintId, source) {
  const user = getUser(chatId);
  const mint = (user.mints || []).find((item) => item.id === mintId);
  if (!mint || !mint.confirmed || !mint.autoMintEnabled) return;

  const autoMint = mint.autoMint || {};
  mint.autoMint = autoMint;

  if (autoMint.success || autoMint.inFlight) return;
  if (Date.now() < mint.mintTime + AUTO_MINT_DELAY_MS) return;
  if (Date.now() > mint.mintTime + AUTO_MINT_RETRY_WINDOW_MS) return;
  if ((autoMint.attempts || 0) >= AUTO_MINT_MAX_ATTEMPTS) return;

  const wallet = getActiveWallet(user);
  if (!wallet || !mint.contractAddress) return;

  autoMint.inFlight = true;
  autoMint.attempts = (autoMint.attempts || 0) + 1;
  autoMint.lastAttemptAt = Date.now();
  autoMint.lastSource = source;
  saveDb();

  try {
    const result = await executeAutoMint(chatId, user, mint, wallet);
    autoMint.success = true;
    autoMint.inFlight = false;
    autoMint.txHash = result.hash;
    autoMint.confirmedAt = Date.now();
    mint.completedAt = Date.now();
    user.mintHistory = user.mintHistory || [];
    user.mintHistory.unshift({
      mintId: mint.id,
      mintName: mint.mintName,
      userTier: mint.userTier,
      txHash: result.hash,
      valueEth: result.valueEth || mint.priceEth || "0",
      gasCostEth: result.gasCostEth || "0",
      totalCostEth: String(Number(result.valueEth || mint.priceEth || 0) + Number(result.gasCostEth || 0)),
      contractAddress: mint.contractAddress,
      chainId: mint.chainId,
      status: "confirmed",
      timestamp: Date.now()
    });
    saveDb();
    await sendTxResult(chatId, `Buy landed: ${mint.mintName}`, result.hash, mint.chainId);
    await watchMintedReceipt(chatId, user, mint, result.receipt);
  } catch (err) {
    autoMint.inFlight = false;
    autoMint.lastError = shortError(err);
    mint.updatedAt = Date.now();
    saveDb();

    const attemptsLeft = AUTO_MINT_MAX_ATTEMPTS - autoMint.attempts;
    const finalAttempt = attemptsLeft <= 0 || Date.now() > mint.mintTime + AUTO_MINT_RETRY_WINDOW_MS;
    await safeSend(
      chatId,
      [
        `Auto-buy attempt ${autoMint.attempts} did not land for ${mint.mintName}.`,
        userFriendlyError(err),
        finalAttempt ? "The retry window is over. Buy manually if you still want in." : `Attempts left: ${attemptsLeft}`
      ].join("\n")
    );
  }
}

async function executeAutoMint(chatId, user, mint, walletRecord) {
  if (!mint.contractAddress) {
    throw new Error("Contract address is missing");
  }
  if (!walletRecord.encryptedPrivateKey) {
    throw new Error("Active wallet has no encrypted private key");
  }

  const provider = getProvider(mint.chainId);
  const privateKey = decryptPrivateKey(walletRecord.encryptedPrivateKey);
  const wallet = new ethers.Wallet(privateKey, provider);
  const abi = await resolveContractAbi(mint);
  const contract = new ethers.Contract(mint.contractAddress, abi, wallet);
  const candidate = selectMintFunction(contract.interface, mint, wallet.address);

  if (!candidate) {
    throw new Error("No compatible mint function found. Add mintFunction/mintArgs manually.");
  }

  const value = resolveMintValue(mint);
  const feeOverrides = await buildFeeOverrides(mint.chainId, {
    riskMode: riskModeForMint(user, mint).key,
    gasWarMode: Boolean(mint.gasWarMode || user.gasWarMode),
    attempt: Number(mint.autoMint && mint.autoMint.attempts ? mint.autoMint.attempts : 1)
  });
  const gasLimit = await resolveGasLimit(contract, candidate, value);
  const balance = await provider.getBalance(wallet.address);
  const maxGasCost = feeOverrides.maxFeePerGas
    ? gasLimit * feeOverrides.maxFeePerGas
    : gasLimit * (feeOverrides.gasPrice || 0n);
  const gasCap = mint.gasCapEth ? ethers.parseEther(String(mint.gasCapEth)) : null;
  if (gasCap && maxGasCost > gasCap) {
    throw new Error(`Gas cap exceeded. Current max gas ${ethers.formatEther(maxGasCost)} ETH is above your cap ${mint.gasCapEth} ETH.`);
  }
  const required = value + maxGasCost;

  if (balance < required) {
    throw new Error(`Insufficient ETH. Need about ${ethers.formatEther(required)} ETH, wallet has ${ethers.formatEther(balance)} ETH.`);
  }

  const overrides = { ...feeOverrides, gasLimit, value };
  const fn = contract[candidate.functionKey];
  if (!fn) {
    throw new Error(`Function ${candidate.functionKey} is not available on contract`);
  }

  if (mint.flashbotsEnabled) {
    const relayUrl = privateRelayUrl(mint.chainId);
    if (!relayUrl) {
      throw new Error("Private relay is enabled but no relay URL is configured for this chain");
    }
    const populated = await fn.populateTransaction(...candidate.args, overrides);
    const txRequest = {
      ...populated,
      chainId: mint.chainId,
      nonce: await wallet.getNonce("pending")
    };
    const rawTx = await wallet.signTransaction(txRequest);
    const hash = await sendPrivateRawTransaction(relayUrl, rawTx);
    await sendTxResult(chatId, `Private auto-mint submitted: ${mint.mintName}`, hash, mint.chainId);
    const receipt = await provider.waitForTransaction(hash, 1, 180000);
    if (!receipt || receipt.status !== 1) {
      throw new Error(`Private transaction not confirmed: ${hash}`);
    }
    return { hash, receipt, valueEth: ethers.formatEther(value), gasCostEth: ethers.formatEther(maxGasCost) };
  }

  const pendingFeeWei = pendingFeeWeiForChain(user, mint.chainId);
  const canBundlePendingFee = pendingFeeWei > 0n && canRouteMintWithFee(mint, candidate);
  if (canBundlePendingFee) {
    const routed = await executeRoutedMint({
      chatId,
      user,
      mint,
      wallet,
      provider,
      contract,
      candidate,
      mintValue: value,
      pendingFeeWei,
      feeOverrides,
      gasCap
    });
    clearPendingFeesForChain(user, mint.chainId);
    return routed;
  }

  const tx = await fn(...candidate.args, overrides);
    await sendTxResult(chatId, `Buy sent: ${mint.mintName}`, tx.hash, mint.chainId);
  const receipt = await tx.wait(1);

  if (!receipt || receipt.status !== 1) {
    throw new Error(`Transaction reverted: ${tx.hash}`);
  }

  if (pendingFeeWei > 0n && Number(mint.chainId) === 1 && !canBundlePendingFee) {
    await settlePendingProfitAgreementsAfterMint(chatId, user, mint, wallet, pendingFeeWei).catch(async (err) => {
      await safeSend(
        chatId,
        [
          `${mint.mintName} landed.`,
          "Your pending profit agreement is still waiting.",
          "The bot will try again after your next Ethereum buy."
        ].join("\n")
      );
      console.error("pending profit agreement settle failed:", err);
    });
  }

  return { hash: tx.hash, receipt, valueEth: ethers.formatEther(value), gasCostEth: ethers.formatEther(maxGasCost) };
}

function privateRelayUrl(chainId) {
  if (Number(chainId) === 1) {
    return process.env.FLASHBOTS_RELAY_ETH
      || process.env.FLASHBOTS_PROTECT_ETH
      || process.env.PRIVATE_TX_RPC_ETH
      || "https://rpc.flashbots.net";
  }
  if (Number(chainId) === 8453) {
    return process.env.FLASHBOTS_PROTECT_BASE
      || process.env.PRIVATE_TX_RPC_BASE
      || "";
  }
  return "";
}

async function sendPrivateRawTransaction(relayUrl, rawTx) {
  const payload = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "eth_sendRawTransaction",
    params: [rawTx]
  };
  const response = await fetch(relayUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.error) {
    throw new Error(data && data.error ? data.error.message || JSON.stringify(data.error) : `Private relay HTTP ${response.status}`);
  }
  return data.result;
}

function canRouteMintWithFee(mint, candidate) {
  if (!hasFeeRouter(mint.chainId)) return false;
  return candidate.fragment.inputs.some((input) => input.type === "address");
}

function hasMintRegistry(chainId) {
  const registryAddress = MINT_REGISTRY_BY_CHAIN[Number(chainId)];
  return Boolean(registryAddress && ethers.isAddress(registryAddress));
}

function hasFeeRouter(chainId) {
  const routerAddress = FEE_ROUTER_BY_CHAIN[Number(chainId)];
  return Boolean(routerAddress && ethers.isAddress(routerAddress));
}

async function executeRoutedMint({
  chatId,
  user,
  mint,
  wallet,
  provider,
  contract,
  candidate,
  mintValue,
  pendingFeeWei,
  feeOverrides,
  gasCap
}) {
  const routerAddress = FEE_ROUTER_BY_CHAIN[Number(mint.chainId)];
  const router = new ethers.Contract(routerAddress, FEE_ROUTER_ABI, wallet);
  const mintCallData = contract.interface.encodeFunctionData(candidate.fragment, candidate.args);
  const totalValue = mintValue + pendingFeeWei;
  let gasLimit = DEFAULT_GAS_LIMIT + 150000n;

  try {
    const estimated = await router.routeMint.estimateGas(
      mint.contractAddress,
      mintCallData,
      mintValue,
      pendingFeeWei,
      0,
      wallet.address,
      { value: totalValue }
    );
    gasLimit = (estimated * 130n) / 100n;
  } catch (err) {
    // Use conservative fallback.
  }

  const maxGasCost = feeOverrides.maxFeePerGas
    ? gasLimit * feeOverrides.maxFeePerGas
    : gasLimit * (feeOverrides.gasPrice || 0n);

  if (gasCap && maxGasCost > gasCap) {
    throw new Error(`Gas cap exceeded. Current max gas ${ethers.formatEther(maxGasCost)} ETH is above your cap ${mint.gasCapEth} ETH.`);
  }

  const balance = await provider.getBalance(wallet.address);
  if (balance < totalValue + maxGasCost) {
    throw new Error(`Insufficient ETH. Need about ${ethers.formatEther(totalValue + maxGasCost)} ETH, wallet has ${ethers.formatEther(balance)} ETH.`);
  }

  const tx = await router.routeMint(
    mint.contractAddress,
    mintCallData,
    mintValue,
    pendingFeeWei,
    0,
    wallet.address,
    { ...feeOverrides, gasLimit, value: totalValue }
  );
  await sendTxResult(chatId, `Buy sent: ${mint.mintName}`, tx.hash, mint.chainId);
  const receipt = await tx.wait(1);

  if (!receipt || receipt.status !== 1) {
    throw new Error(`Transaction reverted: ${tx.hash}`);
  }

  db.totalFeesCollectedEth = String(Number(db.totalFeesCollectedEth || 0) + Number(ethers.formatEther(pendingFeeWei)));

  return {
    hash: tx.hash,
    receipt,
    valueEth: ethers.formatEther(totalValue),
    gasCostEth: ethers.formatEther(maxGasCost)
  };
}

async function watchMintedReceipt(chatId, user, mint, receipt) {
  const transferTopic = ethers.id("Transfer(address,address,uint256)");
  const zeroTopic = ethers.zeroPadValue("0x", 32).toLowerCase();
  const activeWallet = getActiveWallet(user);
  const walletTopic = activeWallet
    ? ethers.zeroPadValue(activeWallet.address, 32).toLowerCase()
    : null;

  user.mintedTokens = user.mintedTokens || [];
  for (const log of receipt.logs || []) {
    if (!log.topics || log.topics[0] !== transferTopic) continue;
    if (log.address.toLowerCase() !== String(mint.contractAddress || "").toLowerCase()) continue;
    if (log.topics[1] && log.topics[1].toLowerCase() !== zeroTopic) continue;
    if (walletTopic && log.topics[2] && log.topics[2].toLowerCase() !== walletTopic) continue;

    const tokenId = BigInt(log.topics[3]).toString();
    const tokenRecord = {
      id: randomId(8),
      mintId: mint.id,
      mintName: mint.mintName,
      contractAddress: ethers.getAddress(log.address),
      chainId: mint.chainId,
      tokenId,
      ownerWalletAddress: activeWallet ? activeWallet.address : null,
      sourceUrl: mint.sourceUrl || null,
      openSeaSlug: mint.openSeaSlug || (mint.metadata && mint.metadata.slug) || null,
      mintPriceEth: mint.priceEth || mint.totalValueEth || "0",
      mintedAt: Date.now(),
      txHash: receipt.hash,
      watchingSale: true,
      profitAlertsSent: [],
      lossAlertsSent: []
    };
    user.mintedTokens.push(tokenRecord);
    saveDb();
    await sendMintedTokenMarketCard(chatId, tokenRecord.id, { refresh: true, source: "post_mint" });
  }
}

async function sendMintedTokenMarketCard(chatId, tokenRecordId, options = {}) {
  const user = getUser(chatId);
  const token = findMintedToken(user, tokenRecordId);

  if (!token) {
    await safeSend(chatId, "I could not find that item anymore.");
    return;
  }

  const details = await fetchOpenSeaNftDetails(token).catch(() => null);
  if (details) {
    hydrateMintedToken(token, details);
    saveDb();
  }

  const lines = [
    `${options.source === "post_mint" ? "Mint landed" : "Market Card"}`,
    `Item: ${displayMintedTokenName(token)}`,
    token.collectionName ? `Collection: ${token.collectionName}` : "",
    token.rarityRank
      ? `Rarity: #${token.rarityRank}${token.rarityMaxRank ? ` of ${token.rarityMaxRank}` : ""}`
      : "Rarity: not available yet",
    rarityPositionLine(token),
    rarityRecommendationLine(token),
    "",
    "Use the buttons below to view rarity again or list this item."
  ].filter(Boolean);

  const buttons = [];
  if (token.assetUrl) {
    buttons.push([{ text: "Open Item", url: token.assetUrl }]);
  }
  buttons.push([
    { text: "View Rarity", callback_data: `token_rarity:${token.id}` },
    { text: "List for Sale", callback_data: `token_list:${token.id}` }
  ]);

  await safeSend(chatId, lines.join("\n"), {
    reply_markup: { inline_keyboard: buttons }
  });
}

async function handleSaleDetected(event) {
  const chainId = Number(event.chainId || event.chain_id || getDefaultChainConfig().chainId);
  const contractAddress = event.contractAddress || event.contract_address || event.nftContract || event.address;
  const tokenId = event.tokenId || event.token_id || event.identifier;
  const salePriceEth = event.salePriceEth || event.priceEth || event.price;

  if (!contractAddress || tokenId == null || salePriceEth == null) return;

  for (const [chatId, user] of Object.entries(db.users || {})) {
    const token = (user.mintedTokens || []).find((item) => (
      item.chainId === chainId
      && String(item.contractAddress).toLowerCase() === String(contractAddress).toLowerCase()
      && String(item.tokenId) === String(tokenId)
    ));
    if (!token) continue;

    const mintPriceRecord = await resolveMintPriceSource(chainId, contractAddress, token).catch(() => null);
    if (!mintPriceRecord || mintPriceRecord.mintPriceEth == null) {
      token.lastSalePriceEth = String(salePriceEth);
      token.soldAt = Date.now();
      token.feeCollectionError = "Mint price not verified";
      await safeSend(
        chatId,
        [
          `Your NFT sold for ${salePriceEth} ETH.`,
          "The bot could not verify the original buy price, so no profit agreement was created."
        ].join("\n")
      );
      continue;
    }

    const mintPrice = Number(mintPriceRecord.mintPriceEth);
    const salePrice = Number(salePriceEth || 0);
    const profit = salePrice - mintPrice;
    const fee = profit > 0 ? (profit * Number(PLATFORM_PROFIT_FEE_BPS)) / 10000 : 0;

    token.mintPriceSource = mintPriceRecord && mintPriceRecord.source ? mintPriceRecord.source : "database";
    token.lastSalePriceEth = String(salePrice);
    token.soldAt = Date.now();
    token.platformFeeEth = String(Math.max(0, fee));

    if (fee > 0 && chainId === 8453) {
      await collectBaseProfitFee(chatId, user, token, fee).catch((err) => {
        token.feeCollectionError = shortError(err);
      });
      await safeSend(
        chatId,
        [
          `Your NFT sold for ${salePrice} ETH.`,
          `Mint price: ${mintPrice} ETH.`,
          `Profit: ${profit} ETH.`,
          `Platform fee collected: ${fee} ETH (5% of profit).`
        ].join("\n")
      );
    } else if (fee > 0 && chainId === 1) {
      user.pendingFees = user.pendingFees || [];
      user.pendingFees.push({
        chainId,
        contractAddress: token.contractAddress,
        tokenId: token.tokenId,
        nftName: displayMintedTokenName(token),
        salePriceEth: String(salePrice),
        mintPriceEth: String(mintPrice),
        profitEth: String(profit),
        feeEth: String(fee),
        createdAt: Date.now()
      });
      await safeSend(
        chatId,
        `Your NFT sold for ${salePrice} ETH. Profit: ${profit} ETH. Pending profit agreement from ${displayMintedTokenName(token)} NFT: ${fee} ETH (5% of profit). To save gas on Ethereum, this will carry into your next mint.`
      );
    } else {
      await safeSend(
        chatId,
        [
          `Your NFT sold for ${salePrice} ETH.`,
          `Mint price: ${mintPrice} ETH.`,
          "No platform fee because this sale was break-even or a loss."
        ].join("\n")
      );
    }
  }

  saveDb();
}

async function readMintRegistryRecord(chainId, contractAddress, tokenId) {
  if (!hasMintRegistry(chainId)) return null;
  const registryAddress = MINT_REGISTRY_BY_CHAIN[Number(chainId)];

  const provider = getProvider(chainId);
  const registry = new ethers.Contract(
    registryAddress,
    ["function getMint(address nftContract, uint256 tokenId) view returns (address minter, uint256 mintPriceWei, uint256 recordedAt)"],
    provider
  );
  const [minter, mintPriceWei, recordedAt] = await registry.getMint(contractAddress, BigInt(tokenId));
  if (!minter || minter === ethers.ZeroAddress || !mintPriceWei) return null;
  return {
    minter,
    mintPriceEth: ethers.formatEther(mintPriceWei),
    recordedAt: Number(recordedAt)
  };
}

async function resolveMintPriceSource(chainId, contractAddress, token) {
  const dbRecord = token && token.mintPriceEth != null
    ? {
        mintPriceEth: token.mintPriceEth,
        source: "database"
      }
    : null;

  if (!hasMintRegistry(chainId)) {
    return dbRecord;
  }

  const registryRecord = await readMintRegistryRecord(chainId, contractAddress, token.tokenId).catch(() => null);
  if (registryRecord && registryRecord.mintPriceEth != null) {
    return {
      mintPriceEth: registryRecord.mintPriceEth,
      source: "registry"
    };
  }

  return dbRecord;
}

async function settlePendingProfitAgreementsAfterMint(chatId, user, mint, wallet, pendingFeeWei) {
  if (!TREASURY_WALLET || !ethers.isAddress(TREASURY_WALLET)) {
    throw new Error("TREASURY_WALLET is not configured");
  }
  if (pendingFeeWei <= 0n) return null;

  const balance = await wallet.provider.getBalance(wallet.address);
  const feeData = await wallet.provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas || feeData.gasPrice || ethers.parseUnits("8", "gwei");
  const gasLimit = 21000n;
  const gasCost = gasLimit * gasPrice;

  if (balance < pendingFeeWei + gasCost) {
    throw new Error("Not enough ETH left to settle pending profit agreement");
  }

  const tx = await wallet.sendTransaction({
    to: TREASURY_WALLET,
    value: pendingFeeWei,
    gasLimit,
    ...(feeData.maxFeePerGas && feeData.maxPriorityFeePerGas
      ? {
          maxFeePerGas: feeData.maxFeePerGas,
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
        }
      : feeData.gasPrice
        ? { gasPrice: feeData.gasPrice }
        : {})
  });
  const receipt = await tx.wait(1);

  if (!receipt || receipt.status !== 1) {
    throw new Error("Pending profit agreement transfer did not confirm");
  }

  const settledEth = trimEth(ethers.formatEther(pendingFeeWei));
  clearPendingFeesForChain(user, mint.chainId);
  db.totalFeesCollectedEth = String(Number(db.totalFeesCollectedEth || 0) + Number(settledEth));
  saveDb();

  await safeSend(
    chatId,
    [
      `${mint.mintName} landed.`,
      `Pending profit agreement settled: ${settledEth} ETH`
    ].join("\n"),
    explorerTxUrl(mint.chainId, tx.hash)
      ? {
          reply_markup: {
            inline_keyboard: [[{ text: "View Settlement", url: explorerTxUrl(mint.chainId, tx.hash) }]]
          }
        }
      : {}
  );

  return receipt;
}

async function collectBaseProfitFee(chatId, user, token, feeEth) {
  if (!TREASURY_WALLET || !ethers.isAddress(TREASURY_WALLET)) {
    throw new Error("TREASURY_WALLET is not configured");
  }
  const walletRecord = getActiveWallet(user);
  if (!walletRecord || !walletRecord.encryptedPrivateKey) {
    throw new Error("No active wallet to collect fee from");
  }

  const provider = getProvider(8453);
  const wallet = new ethers.Wallet(decryptPrivateKey(walletRecord.encryptedPrivateKey), provider);
  const value = ethers.parseEther(String(feeEth));
  const tx = await wallet.sendTransaction({ to: TREASURY_WALLET, value });
  const receipt = await tx.wait(1);
  token.feeTxHash = tx.hash;
  db.totalFeesCollectedEth = String(Number(db.totalFeesCollectedEth || 0) + Number(feeEth));
  return receipt;
}

async function handleAlchemyWebhook(payload) {
  const events = extractAlchemyEvents(payload);
  for (const event of events) {
    if (event.type === "sale") {
      await handleSaleDetected(event);
    }
  }
}

function extractAlchemyEvents(payload) {
  const events = [];
  const activity = payload.event && Array.isArray(payload.event.activity)
    ? payload.event.activity
    : Array.isArray(payload.activity)
      ? payload.activity
      : [];

  for (const item of activity) {
    const category = String(item.category || item.type || "").toLowerCase();
    const contractAddress = item.contractAddress || item.rawContract && item.rawContract.address;
    const tokenId = item.tokenId || item.erc721TokenId || item.token_id;
    const chainId = normalizeWebhookChainId(item.network || item.chain || item.chainId || payload.network);

    if (category.includes("sale") || item.eventType === "OrderFulfilled") {
      events.push({
        type: "sale",
        chainId,
        contractAddress,
        tokenId,
        salePriceEth: item.price || item.salePrice || item.value || item.ethValue
      });
    }
  }

  const logs = payload.event && Array.isArray(payload.event.logs)
    ? payload.event.logs
    : Array.isArray(payload.logs)
      ? payload.logs
      : [];

  for (const log of logs) {
    const topic0 = Array.isArray(log.topics) ? log.topics[0] : null;
    if (topic0 !== ethers.id("OrderFulfilled(bytes32,address,address,address,(uint8,address,uint256,uint256)[],(uint8,address,uint256,uint256,address)[])")) {
      continue;
    }
    events.push({
      type: "sale",
      chainId: normalizeWebhookChainId(log.network || payload.network || payload.chainId),
      contractAddress: log.contractAddress || log.address,
      tokenId: log.tokenId,
      salePriceEth: log.salePriceEth || log.priceEth
    });
  }

  return events.filter((event) => event.contractAddress && event.tokenId != null && event.salePriceEth != null);
}

function normalizeWebhookChainId(value) {
  if (!value) return getDefaultChainConfig().chainId;
  if (Number.isFinite(Number(value))) return Number(value);
  const normalized = String(value).toLowerCase();
  if (normalized.includes("base")) return 8453;
  if (normalized.includes("eth")) return 1;
  return getDefaultChainConfig().chainId;
}

async function resolveContractAbi(mint) {
  if (!process.env.ETHERSCAN_API_KEY) {
    return COMMON_MINT_ABI;
  }

  try {
    const url = new URL("https://api.etherscan.io/v2/api");
    url.searchParams.set("chainid", String(mint.chainId || getDefaultChainConfig().chainId));
    url.searchParams.set("module", "contract");
    url.searchParams.set("action", "getabi");
    url.searchParams.set("address", mint.contractAddress);
    url.searchParams.set("apikey", process.env.ETHERSCAN_API_KEY);

    const data = await fetchJson(url.toString());
    if (data.status !== "1") {
      return COMMON_MINT_ABI;
    }

    return JSON.parse(data.result);
  } catch (err) {
    return COMMON_MINT_ABI;
  }
}

function selectMintFunction(iface, mint, walletAddress) {
  const fragments = iface.fragments
    .filter((fragment) => fragment.type === "function")
    .filter((fragment) => ["payable", "nonpayable"].includes(fragment.stateMutability));

  const explicit = mint.mintFunction
    ? fragments.filter((fragment) => fragment.name.toLowerCase() === mint.mintFunction.toLowerCase())
    : [];

  const common = fragments
    .filter((fragment) => MINT_FUNCTION_PRIORITY.includes(fragment.name))
    .sort((a, b) => MINT_FUNCTION_PRIORITY.indexOf(a.name) - MINT_FUNCTION_PRIORITY.indexOf(b.name));

  const candidates = [...explicit, ...common];
  const seen = new Set();

  for (const fragment of candidates) {
    const functionKey = fragment.format("sighash");
    if (seen.has(functionKey)) continue;
    seen.add(functionKey);

    const args = buildMintArgs(fragment, mint, walletAddress);
    if (!args) continue;

    return { fragment, functionKey, args };
  }

  return null;
}

function buildMintArgs(fragment, mint, walletAddress) {
  if (Array.isArray(mint.mintArgs)) {
    return mint.mintArgs;
  }

  const args = [];
  for (const input of fragment.inputs) {
    const type = input.type;

    if (/^uint/.test(type)) {
      args.push(BigInt(mint.quantity || 1));
      continue;
    }

    if (type === "address") {
      args.push(walletAddress);
      continue;
    }

    if (type === "bytes32[]" || type === "bytes[]") {
      if (Array.isArray(mint.merkleProof)) {
        args.push(mint.merkleProof);
        continue;
      }
      return null;
    }

    if (type === "bytes32" || type === "bytes") {
      if (mint.proof) {
        args.push(mint.proof);
        continue;
      }
      return null;
    }

    if (type === "bool") {
      args.push(true);
      continue;
    }

    return null;
  }

  return args;
}

function resolveMintValue(mint) {
  if (mint.totalValueEth) {
    return ethers.parseEther(String(mint.totalValueEth));
  }

  if (!mint.priceEth) {
    return 0n;
  }

  const unitPrice = ethers.parseEther(String(mint.priceEth));
  return unitPrice * BigInt(mint.quantity || 1);
}

async function buildFeeOverrides(chainId, options = {}) {
  const provider = getProvider(chainId);
  const feeData = await provider.getFeeData();
  const boostPercent = gasBoostPercent(options);

  if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
    return {
      maxFeePerGas: boostWei(feeData.maxFeePerGas, boostPercent),
      maxPriorityFeePerGas: boostWei(feeData.maxPriorityFeePerGas, boostPercent)
    };
  }

  if (feeData.gasPrice) {
    return { gasPrice: boostWei(feeData.gasPrice, boostPercent) };
  }

  return {};
}

async function resolveGasLimit(contract, candidate, value) {
  const overrides = { value };
  const fn = contract[candidate.functionKey];

  try {
    const estimated = await fn.estimateGas(...candidate.args, overrides);
    return (estimated * 130n) / 100n;
  } catch (err) {
    return DEFAULT_GAS_LIMIT;
  }
}

async function estimateGasCap(chatId, user, mint) {
  const provider = getProvider(mint.chainId);
  const walletRecord = getActiveWallet(user);
  const value = resolveMintValue(mint);
  let gasLimit = DEFAULT_GAS_LIMIT;
  let note = "";

  if (walletRecord && walletRecord.encryptedPrivateKey && mint.contractAddress) {
    try {
      const privateKey = decryptPrivateKey(walletRecord.encryptedPrivateKey);
      const wallet = new ethers.Wallet(privateKey, provider);
      const abi = await resolveContractAbi(mint);
      const contract = new ethers.Contract(mint.contractAddress, abi, wallet);
      const candidate = selectMintFunction(contract.interface, mint, wallet.address);
      if (candidate) {
        gasLimit = await resolveGasLimit(contract, candidate, value);
      }
    } catch (err) {
      note = "Using a safe default because live estimation is unavailable.";
    }
  } else {
    note = "Used a default gas estimate because no live wallet is connected.";
  }

  const feeOverrides = await buildFeeOverrides(mint.chainId, {
    riskMode: riskModeForMint(user, mint).key,
    gasWarMode: Boolean(mint.gasWarMode || user.gasWarMode),
    attempt: 1
  });
  const maxFee = feeOverrides.maxFeePerGas || feeOverrides.gasPrice || ethers.parseUnits("30", "gwei");
  const estimatedMaxGas = gasLimit * maxFee;
  const gasCap = (estimatedMaxGas * gasCapMultiplierPercent(user, mint)) / 100n;
  const mintValue = value;
  const totalCost = mintValue + gasCap;
  const gasPercent = totalCost > 0n
    ? `${Number((gasCap * 10000n) / totalCost) / 100}%`
    : "100%";

  return {
    gasCapEth: trimEth(ethers.formatEther(gasCap)),
    gasPercent,
    note
  };
}

function gasBoostPercent(options = {}) {
  const riskMode = RISK_MODES[normalizeRiskMode(options.riskMode)] || RISK_MODES.fast;
  const attempt = BigInt(Math.max(0, Number(options.attempt || 1) - 1));
  const baseBoost = riskMode.gasBoostPercent || GAS_BOOST_PERCENT;
  return baseBoost + (options.gasWarMode ? GAS_WAR_STEP_PERCENT * attempt : 0n);
}

function boostWei(value, boostPercent = GAS_BOOST_PERCENT) {
  return (BigInt(value) * BigInt(boostPercent)) / 100n;
}

async function sendStatus(chatId) {
  const user = getUser(chatId);
  const mints = (user.mints || []).filter((mint) => mint.confirmed && !mint.completedAt);
  const wallet = getActiveWallet(user);

  if (!mints.length) {
    await safeSend(
      chatId,
      wallet ? `No live mints right now.\nLive wallet: ${shortAddress(wallet.address)}` : "No live mints right now, and no wallet is set.",
      MAIN_MENU_KEYBOARD
    );
    return;
  }

  const lines = [
    "Live Status",
    wallet ? `Wallet: ${shortAddress(wallet.address)}` : "Wallet: not set",
    ""
  ];
  const buttons = [];

  for (const mint of mints) {
    const auto = mint.autoMint || {};
    lines.push(
      `${mint.mintName} (${mint.userTier.toUpperCase()})`,
      `Buy time: ${formatDateTime(mint.mintTime)}`,
      `Countdown: ${formatDuration(mint.mintTime - Date.now())}`,
      `Network: ${mint.chainName || "unknown"}`,
      `Mint page: ${mint.contractAddress ? "ready" : "not ready"}`,
      `Reminders: ${REMINDERS.map((item) => `${item.label}:${mint.firedReminders.includes(item.key) ? "sent" : "waiting"}`).join(" ")}`,
      `Auto-buy: ${mint.autoMintEnabled ? "on" : "off"} | tries ${auto.attempts || 0}/${AUTO_MINT_MAX_ATTEMPTS} | ${auto.success ? "done" : "waiting"}`,
      auto.lastError ? "Last issue: the buy did not go through." : "",
      ""
    );
    buttons.push([
      { text: `Buy Now - ${mint.mintName}`.slice(0, 60), callback_data: `status_instant:${mint.id}` }
    ]);
    buttons.push([
      { text: `Stop Tracking - ${mint.mintName}`.slice(0, 60), callback_data: `mint_cancel:${mint.id}` }
    ]);
  }

  await safeSend(chatId, lines.filter(Boolean).join("\n"), {
    reply_markup: { inline_keyboard: buttons }
  });
}

async function instantMintExisting(chatId, mintId) {
  const user = getUser(chatId);
  const mint = (user.mints || []).find((item) => item.id === mintId);

  if (!mint) {
    await safeSend(chatId, "I couldn't find that mint anymore.");
    return;
  }

  mint.mintTime = Date.now() - AUTO_MINT_DELAY_MS;
  mint.autoMintEnabled = true;
  mint.autoMint = mint.autoMint || {};
  mint.autoMint.success = false;
  mint.autoMint.inFlight = false;
  mint.updatedAt = Date.now();
  saveDb();
  await safeSend(chatId, `Trying a buy right now for ${mint.mintName}.`);
  await maybeAttemptAutoMint(chatId, mint.id, "manual_instant");
}

async function cancelConfirmedMint(chatId, mintId) {
  const user = getUser(chatId);
  const mint = (user.mints || []).find((item) => item.id === mintId);

  if (!mint) {
    await safeSend(chatId, "I couldn't find that mint anymore.");
    return;
  }

  mint.completedAt = Date.now();
  mint.cancelledAt = Date.now();
  mint.updatedAt = Date.now();
  clearAutoMintTimer(chatId, mint.id);
  saveDb();
  await safeSend(chatId, `Stopped tracking ${mint.mintName}.`, MAIN_MENU_KEYBOARD);
}

async function sendMintHistory(chatId) {
  const user = getUser(chatId);
  const history = user.mintHistory || [];

  if (!history.length) {
    await safeSend(chatId, "No buys yet.", MAIN_MENU_KEYBOARD);
    return;
  }

  const lines = ["Buy History", ""];
  for (const item of history.slice(0, 10)) {
    lines.push(
      `${item.mintName} (${String(item.userTier || "").toUpperCase()})`,
      `Result: ${item.status}`,
      item.txHash ? "Receipt: open it from the buy alert" : "Receipt: not available",
      `Time: ${formatDateTime(item.timestamp)}`,
      ""
    );
  }

  await safeSend(chatId, lines.join("\n"), MAIN_MENU_KEYBOARD);
}

async function sendAutoMintPanel(chatId) {
  const user = getUser(chatId);
  const mints = (user.mints || []).filter((mint) => mint.confirmed && !mint.completedAt);

  if (!mints.length) {
    await safeSend(chatId, "No live mints right now.", MAIN_MENU_KEYBOARD);
    return;
  }

  const lines = ["Auto-Buy", "This is where the bot handles the timing for you.", ""];
  const buttons = [];

  for (const mint of mints) {
    const auto = mint.autoMint || {};
    lines.push(
      `${mint.mintName} (${mint.userTier.toUpperCase()})`,
      `Mode: ${mint.autoMintEnabled ? "on" : "off"} | tries ${auto.attempts || 0}/${AUTO_MINT_MAX_ATTEMPTS}`,
      `Buy time: ${formatDateTime(mint.mintTime)}`,
      ""
    );
    buttons.push([{
      text: `${mint.autoMintEnabled ? "Turn Off" : "Turn On"} Auto-Buy - ${mint.mintName}`.slice(0, 60),
      callback_data: `mint_toggle:auto:${mint.id}`
    }]);
  }

  await safeSend(chatId, lines.join("\n"), {
    reply_markup: { inline_keyboard: buttons }
  });
}

async function sendRemindersPanel(chatId) {
  const user = getUser(chatId);
  const mints = (user.mints || []).filter((mint) => mint.confirmed && !mint.completedAt);

  if (!mints.length) {
    await safeSend(chatId, "No live mints right now.", MAIN_MENU_KEYBOARD);
    return;
  }

  const lines = ["Reminders", "This is where the bot keeps you early, not late.", ""];
  const buttons = [];

  for (const mint of mints) {
    lines.push(
      `${mint.mintName} (${mint.userTier.toUpperCase()})`,
      `Mode: ${mint.remindersEnabled ? "on" : "off"}`,
      `Sent: ${mint.firedReminders.length}/${REMINDERS.length}`,
      ""
    );
    buttons.push([{
      text: `${mint.remindersEnabled ? "Turn Off" : "Turn On"} Reminders - ${mint.mintName}`.slice(0, 60),
      callback_data: `mint_toggle:reminders:${mint.id}`
    }]);
  }

  await safeSend(chatId, lines.join("\n"), {
    reply_markup: { inline_keyboard: buttons }
  });
}

async function toggleConfirmedMintSetting(chatId, field, mintId) {
  const user = getUser(chatId);
  const mint = (user.mints || []).find((item) => item.id === mintId);

  if (!mint) {
    await safeSend(chatId, "I couldn't find that mint anymore.");
    return;
  }

  if (field === "auto") {
    mint.autoMintEnabled = !mint.autoMintEnabled;
    if (mint.autoMintEnabled) {
      scheduleAutoMint(chatId, mint);
    } else {
      clearAutoMintTimer(chatId, mint.id);
    }
  } else if (field === "reminders") {
    mint.remindersEnabled = !mint.remindersEnabled;
  } else if (field === "flashbots") {
    mint.flashbotsEnabled = !mint.flashbotsEnabled;
  } else if (field === "gaswar") {
    mint.gasWarMode = !mint.gasWarMode;
  } else {
    await safeSend(chatId, "I couldn't change that setting.");
    return;
  }

  mint.updatedAt = Date.now();
  saveDb();

  if (field === "auto") {
    await sendAutoMintPanel(chatId);
  } else {
    await sendRemindersPanel(chatId);
  }
}

async function sendGas(chatId, options = {}) {
  const chains = configuredChains();
  const user = getUser(chatId);
  const riskMode = riskModeForUser(user);
  if (!chains.length) {
    await safeSend(chatId, "Gas is down right now.");
    return;
  }

  try {
    const lines = ["Gas", "Use this to decide how aggressive you want the bot to be.", ""];

    for (const chain of chains) {
      const provider = getProvider(chain.chainId);
      const [block, feeData] = await Promise.all([
        provider.getBlock("latest"),
        provider.getFeeData()
      ]);

      lines.push(
        `${chain.chainName}`,
        block && block.baseFeePerGas ? `Base fee: ${formatGwei(block.baseFeePerGas)} gwei` : "Base fee: n/a",
        feeData.gasPrice ? `Gas price: ${formatGwei(feeData.gasPrice)} gwei` : "",
        feeData.maxPriorityFeePerGas ? `Priority: ${formatGwei(feeData.maxPriorityFeePerGas)} gwei` : "",
        feeData.maxFeePerGas ? `Max fee: ${formatGwei(feeData.maxFeePerGas)} gwei` : "",
        ""
      );
    }

    lines.push(`Mode: ${riskMode.label}`);
    lines.push(`Auto-buy push: ${riskMode.gasBoostPercent.toString()}%`);
    lines.push(`Gas War: ${user.gasWarMode ? "on" : "off"}`);

    const markup = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Refresh", callback_data: "gas:refresh" },
            { text: `Gas War: ${user.gasWarMode ? "On" : "Off"}`, callback_data: "gaswar:toggle" }
          ],
          [
            { text: "Safe", callback_data: "riskmode:set:safe" },
            { text: "Fast", callback_data: "riskmode:set:fast" },
            { text: "Degenerate", callback_data: "riskmode:set:degenerate" }
          ]
        ]
      }
    };

    if (options.editMessageId) {
      await safeEdit(chatId, options.editMessageId, lines.join("\n"), markup);
    } else {
      await safeSend(chatId, lines.join("\n"), markup);
    }
  } catch (err) {
    await safeSend(chatId, "Gas is down right now. Try again in a moment.");
  }
}

async function sendTrending(chatId) {
  if (!process.env.OPENSEA_API_KEY) {
    await safeSend(chatId, "Trending is down right now.");
    return;
  }

  try {
    const lines = ["Trending Collections", ""];
    const buttons = [];

    for (const chain of Object.values(CHAIN_CONFIGS)) {
      const url = new URL("https://api.opensea.io/api/v2/collections");
      url.searchParams.set("chain", chain.openSeaChain);
      url.searchParams.set("limit", "3");
      const data = await fetchJson(url.toString(), openSeaHeaders());
      const collections = data.collections || [];

      if (collections.length) {
        lines.push(chain.chainName);
      }

      for (const collection of collections.slice(0, 3)) {
        const slug = collection.collection || collection.slug || collection.collection_slug;
        const name = collection.name || slug || "Unknown";
        lines.push(`${name}${slug ? ` (${slug})` : ""}`);
        if (slug) buttons.push([{ text: `Track ${name}`.slice(0, 60), callback_data: `track_collection:${slug}` }]);
      }

      if (collections.length) {
        lines.push("");
      }
    }

    if (!buttons.length) {
      await safeSend(chatId, "No trending collections returned.");
      return;
    }

    await safeSend(chatId, lines.join("\n"), {
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (err) {
    await safeSend(chatId, "Trending is down right now. Try again in a moment.");
  }
}

async function sendPortfolio(chatId) {
  const user = getUser(chatId);
  const wallet = getActiveWallet(user);

  if (!wallet) {
    await safeSend(chatId, "Set or create a wallet first.", MAIN_MENU_KEYBOARD);
    return;
  }

  if (!process.env.OPENSEA_API_KEY) {
    await safeSend(chatId, "Portfolio is down right now.");
    return;
  }

  try {
    const allNfts = [];
    for (const chain of Object.values(CHAIN_CONFIGS)) {
      const url = `https://api.opensea.io/api/v2/chain/${chain.openSeaChain}/account/${wallet.address}/nfts?limit=5`;
      const data = await fetchJson(url, openSeaHeaders()).catch(() => ({ nfts: [] }));
      for (const nft of data.nfts || []) {
        allNfts.push({ ...nft, chainName: chain.chainName });
      }
    }

    if (!allNfts.length) {
      await safeSend(chatId, `No NFTs found for ${shortAddress(wallet.address)} right now.`);
      return;
    }

    const lines = [`Portfolio - ${shortAddress(wallet.address)}`, ""];
    for (const nft of allNfts.slice(0, 10)) {
      lines.push(`${nft.name || nft.identifier || "Unnamed NFT"} - ${nft.collection || ""} (${nft.chainName})`.trim());
    }
    await safeSend(chatId, lines.join("\n"), MAIN_MENU_KEYBOARD);
  } catch (err) {
    await safeSend(chatId, "Portfolio is down right now. Try again in a moment.");
  }
}

async function fetchWalletNfts(address, limit = 10) {
  if (!process.env.OPENSEA_API_KEY) return [];

  const allNfts = [];
  for (const chain of Object.values(CHAIN_CONFIGS)) {
    const url = `https://api.opensea.io/api/v2/chain/${chain.openSeaChain}/account/${address}/nfts?limit=${limit}`;
    const data = await fetchJson(url, openSeaHeaders()).catch(() => ({ nfts: [] }));
    for (const nft of data.nfts || []) {
      const contractAddress = nft.contract || nft.contract_address || nft.asset_contract_address;
      const tokenId = nft.identifier || nft.token_id || nft.tokenId;
      if (!contractAddress || !tokenId || !ethers.isAddress(contractAddress)) continue;
      allNfts.push({
        name: nft.name || nft.identifier || "NFT",
        contractAddress: ethers.getAddress(contractAddress),
        tokenId: String(tokenId),
        chainId: chain.chainId,
        chainName: chain.chainName,
        collection: nft.collection || nft.collection_slug || null
      });
    }
  }
  return allNfts.slice(0, limit);
}

async function fetchOpenSeaNftDetails(token) {
  if (!process.env.OPENSEA_API_KEY) {
    throw new Error("OpenSea is unavailable right now");
  }

  const chain = getChainConfig(token.chainId);
  if (!chain) {
    throw new Error("Unsupported network");
  }

  const url = `https://api.opensea.io/api/v2/chain/${chain.openSeaChain}/contract/${token.contractAddress}/nfts/${token.tokenId}`;
  const data = await fetchJson(url, openSeaHeaders());
  const nft = data.nft || data;
  const collection = nft.collection || data.collection || {};
  const rarity = nft.rarity || data.rarity || {};

  return {
    name: nft.name || data.name || `Token #${token.tokenId}`,
    imageUrl: nft.image_url || nft.imageUrl || data.image_url || data.imageUrl || null,
    assetUrl: nft.opensea_url || nft.openseaUrl || data.opensea_url || data.openseaUrl || openSeaAssetUrl(token.chainId, token.contractAddress, token.tokenId),
    collectionName: collection.name || data.collection_name || token.mintName || null,
    openSeaSlug: collection.collection || collection.slug || nft.collection_slug || token.openSeaSlug || null,
    rarityRank: firstFiniteNumber(
      rarity.rank,
      rarity.rank_value,
      rarity.ranking,
      nft.rarity_rank,
      data.rarity_rank
    ),
    rarityMaxRank: firstFiniteNumber(
      rarity.max_rank,
      rarity.maxRank,
      collection.total_supply,
      collection.totalSupply,
      data.total_supply
    ),
    rarityScore: firstFiniteNumber(
      rarity.score,
      rarity.rarity_score,
      nft.rarity_score,
      data.rarity_score
    )
  };
}

async function createOpenSeaListing(user, token, priceEth) {
  if (!process.env.OPENSEA_API_KEY) {
    throw new Error("OpenSea listing is unavailable right now");
  }

  const walletRecord = findWalletForToken(user, token);
  if (!walletRecord || !walletRecord.encryptedPrivateKey) {
    throw new Error("No wallet is saved for this item");
  }

  let sdkModule;
  try {
    sdkModule = require("@opensea/sdk");
  } catch (err) {
    throw new Error("Listing support is not installed on this bot yet");
  }

  const provider = getProvider(token.chainId);
  const signer = new ethers.Wallet(decryptPrivateKey(walletRecord.encryptedPrivateKey), provider);
  const sdk = new sdkModule.OpenSeaSDK(
    signer,
    {
      chain: openSeaSdkChain(token.chainId, sdkModule.Chain),
      apiKey: process.env.OPENSEA_API_KEY
    },
    (arg) => console.log(arg)
  );

  const listing = await sdk.createListing({
    asset: {
      tokenAddress: token.contractAddress,
      tokenId: String(token.tokenId)
    },
    accountAddress: signer.address,
    amount: String(priceEth)
  });

  return {
    orderHash: listing && (listing.order_hash || listing.orderHash || listing.hash) || null,
    assetUrl: token.assetUrl || openSeaAssetUrl(token.chainId, token.contractAddress, token.tokenId),
    marketplace: "OpenSea"
  };
}

async function executeTokenTransfer(user, walletRecord, transfer) {
  if (!walletRecord || !walletRecord.encryptedPrivateKey) {
    throw new Error("Active wallet has no private key");
  }

  const provider = getProvider(transfer.chainId);
  const wallet = new ethers.Wallet(decryptPrivateKey(walletRecord.encryptedPrivateKey), provider);
  const token = new ethers.Contract(transfer.tokenAddress, ERC20_ABI, wallet);
  const decimals = await token.decimals().catch(() => 18);
  const amount = ethers.parseUnits(String(transfer.amount), Number(decimals));
  const tx = await token.transfer(transfer.destination, amount);
  return { hash: tx.hash, receipt: await tx.wait(1) };
}

async function executeNftTransfer(user, walletRecord, nft, destination) {
  if (!walletRecord || !walletRecord.encryptedPrivateKey) {
    throw new Error("Active wallet has no private key");
  }
  if (!nft || !nft.contractAddress || nft.tokenId == null) {
    throw new Error("NFT details are missing");
  }

  const provider = getProvider(nft.chainId);
  const wallet = new ethers.Wallet(decryptPrivateKey(walletRecord.encryptedPrivateKey), provider);
  const token = new ethers.Contract(nft.contractAddress, ERC721_ABI, wallet);
  const tx = await token.transferFrom(wallet.address, destination, BigInt(nft.tokenId));
  return { hash: tx.hash, receipt: await tx.wait(1) };
}

async function fetchOpenSeaCollection(slug, preferredChainId = null) {
  if (!process.env.OPENSEA_API_KEY) {
    return { name: slug, slug };
  }

  const collectionUrl = `https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}`;
  const statsUrl = `https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}/stats`;
  const [collection, stats] = await Promise.allSettled([
    fetchJson(collectionUrl, openSeaHeaders()),
    fetchJson(statsUrl, openSeaHeaders())
  ]);

  const collectionData = collection.status === "fulfilled" ? collection.value : {};
  const statsData = stats.status === "fulfilled" ? stats.value : {};
  const contracts = collectionData.contracts || collectionData.primary_asset_contracts || [];
  const selectedContract = selectOpenSeaContract(contracts, preferredChainId);
  const contractAddress = selectedContract && (selectedContract.address || selectedContract);
  const chain = selectedContract && selectedContract.chainId
    ? getChainConfig(selectedContract.chainId)
    : getChainConfig(preferredChainId);

  return {
    slug,
    name: collectionData.name || collectionData.collection || slug,
    description: collectionData.description || null,
    imageUrl: collectionData.image_url || collectionData.imageUrl || null,
    contractAddress: contractAddress && ethers.isAddress(contractAddress) ? ethers.getAddress(contractAddress) : null,
    chainId: chain ? chain.chainId : null,
    chainName: chain ? chain.chainName : null,
    stats: statsData
  };
}

function selectOpenSeaContract(contracts, preferredChainId = null) {
  const normalized = (contracts || []).map((contract) => {
    const address = typeof contract === "string" ? contract : contract.address;
    const chainId = typeof contract === "object"
      ? normalizeOpenSeaChain(contract.chain || contract.blockchain || contract.network)
      : null;
    return { address, chainId };
  }).filter((contract) => contract.address && ethers.isAddress(contract.address));

  if (!normalized.length) return null;

  const preferred = getChainConfig(preferredChainId);
  if (preferred) {
    const match = normalized.find((contract) => contract.chainId === preferred.chainId);
    if (match) return match;
  }

  return normalized.find((contract) => getChainConfig(contract.chainId)) || normalized[0];
}

function parseOpenSeaInput(text) {
  try {
    const url = new URL(text);
    if (!/opensea\.io$/i.test(url.hostname.replace(/^www\./, ""))) return {};
    const parts = url.pathname.split("/").filter(Boolean);
    const chainId = parts.map(normalizeOpenSeaChain).find(Boolean) || null;
    const output = { isOpenSea: true, path: url.pathname, chainId };

    if (parts[0] === "collection" && parts[1]) {
      return { ...output, slug: parts[1] };
    }

    if (parts[0] === "drop" && parts[1]) {
      return { ...output, slug: parts[1], dropSlug: parts[1] };
    }

    if (parts[0] === "mint" && parts[1]) {
      const contractAddress = parts.find((part) => ethers.isAddress(part));
      const slug = chainId && parts[2] ? parts[2] : parts[1];
      return contractAddress
        ? { ...output, contractAddress: ethers.getAddress(contractAddress) }
        : { ...output, slug, dropSlug: slug };
    }

    if (parts[0] === "assets" && parts.length >= 3) {
      const contractAddress = parts.find((part) => ethers.isAddress(part));
      return { ...output, contractAddress: contractAddress ? ethers.getAddress(contractAddress) : null };
    }

    const contractAddress = parts.find((part) => ethers.isAddress(part));
    return { ...output, contractAddress: contractAddress ? ethers.getAddress(contractAddress) : null };
  } catch (err) {
    return {};
  }

  return {};
}

function normalizeOpenSeaChain(value) {
  if (!value) return null;
  const normalized = String(value).toLowerCase();
  return OPENSEA_CHAIN_TO_CHAIN_ID[normalized] || null;
}

function openSeaHeaders() {
  return process.env.OPENSEA_API_KEY ? { "x-api-key": process.env.OPENSEA_API_KEY } : {};
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${response.status}: ${text.slice(0, 200)}`);
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON from ${url}`);
  }
}

function looksLikeMintMessage(text) {
  return /\b(mint|drop|wl|whitelist|allowlist|gtd|guaranteed|og|public|presale|contract|0x[a-fA-F0-9]{40})\b/i.test(text);
}

function getUser(chatId) {
  const key = String(chatId);
  db.users = db.users || {};
  if (!db.users[key]) {
    db.users[key] = {
      wallets: [],
      activeWalletId: null,
      riskMode: "fast",
      mints: [],
      pendingMint: null,
      mintHistory: [],
      state: {},
      history: [],
      createdAt: Date.now()
    };
    saveDb();
  }
  return db.users[key];
}

function touchUser(chatId, from = null) {
  const user = getUser(chatId);
  user.telegramUserId = from && from.id ? String(from.id) : user.telegramUserId || String(chatId);
  user.firstName = from && from.first_name ? from.first_name : user.firstName || "User";
  user.username = from && from.username ? from.username : user.username || null;
  user.lastActiveAt = Date.now();
  saveDb();
  return user;
}

function findMintById(user, mintId) {
  if (!mintId) return null;
  if (user.pendingMint && user.pendingMint.id === mintId) return user.pendingMint;
  return (user.mints || []).find((item) => item.id === mintId) || null;
}

function nextLiveMint(user) {
  return (user.mints || [])
    .filter((mint) => mint.confirmed && !mint.completedAt)
    .sort((a, b) => Number(a.mintTime || 0) - Number(b.mintTime || 0))[0] || null;
}

function findMintedToken(user, tokenRecordId) {
  if (!user || !tokenRecordId) return null;
  return (user.mintedTokens || []).find((item) => item.id === tokenRecordId) || null;
}

function findWalletForToken(user, token) {
  if (!user) return null;
  if (token && token.ownerWalletAddress) {
    const match = (user.wallets || []).find((wallet) => (
      String(wallet.address || "").toLowerCase() === String(token.ownerWalletAddress || "").toLowerCase()
    ));
    if (match) return match;
  }
  return getActiveWallet(user);
}

function hydrateMintedToken(token, details = {}) {
  if (!token || !details) return token;
  token.name = details.name || token.name || null;
  token.imageUrl = details.imageUrl || token.imageUrl || null;
  token.assetUrl = details.assetUrl || token.assetUrl || null;
  token.collectionName = details.collectionName || token.collectionName || null;
  token.openSeaSlug = details.openSeaSlug || token.openSeaSlug || null;
  token.rarityRank = details.rarityRank || token.rarityRank || null;
  token.rarityMaxRank = details.rarityMaxRank || token.rarityMaxRank || null;
  token.rarityScore = details.rarityScore || token.rarityScore || null;
  token.rarityCheckedAt = Date.now();
  token.updatedAt = Date.now();
  return token;
}

function displayMintedTokenName(token) {
  if (!token) return "NFT";
  return token.name || `${token.mintName || "NFT"} #${token.tokenId}`;
}

function rarityPositionLine(token) {
  const rank = Number(token && token.rarityRank);
  const maxRank = Number(token && token.rarityMaxRank);
  if (!Number.isFinite(rank) || !Number.isFinite(maxRank) || maxRank <= 0) return "";
  const topPercent = ((rank / maxRank) * 100);
  return `Position: top ${topPercent.toFixed(topPercent < 10 ? 1 : 0)}%`;
}

function rarityRecommendationLine(token) {
  const rank = Number(token && token.rarityRank);
  const maxRank = Number(token && token.rarityMaxRank);
  if (!Number.isFinite(rank) || !Number.isFinite(maxRank) || maxRank <= 0) {
    return "Read: rarity is still loading. Check again in a moment.";
  }

  const ratio = rank / maxRank;
  if (ratio <= 0.1) {
    return "Read: this looks strong. Holding probably makes more sense than rushing a sale.";
  }
  if (ratio >= 0.5) {
    return "Read: this looks like a weaker rank. Listing sooner probably makes more sense.";
  }
  return "Read: this is mid-pack. Wait for price action and decide from there.";
}

function logFeature(user, feature) {
  if (!user || !feature) return;
  user.featureUsage = user.featureUsage || {};
  user.featureUsage[feature] = (user.featureUsage[feature] || 0) + 1;
}

function logUnhandled(chatId, type, rawInput) {
  const user = getUser(chatId);
  db.analytics = db.analytics || { unhandled: [] };
  db.analytics.unhandled.push({
    userId: String(chatId),
    type,
    rawInput: redactSensitive(String(rawInput || "")).slice(0, 500),
    timestamp: Date.now()
  });
  db.analytics.unhandled = db.analytics.unhandled.slice(-1000);
  user.updatedAt = Date.now();
  saveDb();
}

async function sendLeaderboard(chatId) {
  const rows = Object.entries(db.users || {}).map(([id, user]) => {
    const history = user.mintHistory || [];
    const confirmed = history.filter((item) => item.status === "confirmed");
    const totalEthSpent = confirmed.reduce((sum, item) => sum + Number(item.totalCostEth || item.valueEth || 0), 0);
    const totalProfit = confirmed.reduce((sum, item) => sum + Number(item.profitEth || 0), 0);
    const bestReturn = confirmed.reduce((max, item) => Math.max(max, Number(item.returnMultiple || 0)), 0);
    return {
      id,
      user,
      totalMints: confirmed.length,
      totalEthSpent,
      totalProfit,
      bestReturn
    };
  }).filter((row) => row.totalMints > 0 || row.totalEthSpent > 0);

  rows.sort((a, b) => (
    b.totalMints - a.totalMints
    || b.totalProfit - a.totalProfit
    || b.bestReturn - a.bestReturn
  ));

  if (!rows.length) {
    await safeSend(chatId, "Winners board is empty until the first buy lands.");
    return;
  }

  const lines = ["Winners", ""];
  for (const [index, row] of rows.slice(0, 20).entries()) {
    lines.push(
      `${index + 1}. ${telegramProfileLink(row.user)} - mints ${row.totalMints}, spent ${row.totalEthSpent.toFixed(4)} ETH, profit ${row.totalProfit.toFixed(4)} ETH, best ${row.bestReturn.toFixed(2)}x`
    );
  }

  await safeSend(chatId, lines.join("\n"), { parse_mode: "HTML" });
}

async function sendAdminStats(msg) {
  const chatId = msg.chat.id;
  const senderId = msg.from && msg.from.id ? String(msg.from.id) : "";

  if (!ADMIN_USER_ID || senderId !== ADMIN_USER_ID) {
    await safeSend(chatId, "Stats are admin-only.");
    return;
  }

  const users = Object.entries(db.users || {});
  const now = Date.now();
  const totalMints = users.reduce((sum, [, user]) => sum + (user.mintHistory || []).filter((item) => item.status === "confirmed").length, 0);
  const active24h = users.filter(([, user]) => user.lastActiveAt && now - user.lastActiveAt <= 86400000).length;
  const featureCounts = {};
  for (const [, user] of users) {
    for (const [feature, count] of Object.entries(user.featureUsage || {})) {
      featureCounts[feature] = (featureCounts[feature] || 0) + count;
    }
  }
  const unhandled = groupUnhandledInteractions();

  const lines = [
    "Admin Stats",
    `Registered users: ${users.length}`,
    `Active 24h: ${active24h}`,
    `Total confirmed mints: ${totalMints}`,
    `Total fees collected: ${db.totalFeesCollectedEth || 0} ETH`,
    "",
    "Most used features:",
    ...topEntries(featureCounts, 8).map(([name, count]) => `${name}: ${count}`),
    "",
    "Most active users:",
    ...users
      .map(([id, user]) => [telegramName(user), (user.mintHistory || []).length + Object.values(user.featureUsage || {}).reduce((a, b) => a + b, 0)])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, score]) => `${name}: ${score}`),
    "",
    "Unhandled interactions:",
    ...unhandled.slice(0, 10).map((item) => `${item.type}: ${item.uniqueUsers} users, ${item.count} hits`)
  ];

  await safeSend(chatId, lines.join("\n"));
}

function getActiveWallet(user) {
  if (!user || !Array.isArray(user.wallets) || !user.wallets.length) return null;
  return user.wallets.find((wallet) => wallet.id === user.activeWalletId) || user.wallets[0];
}

function loadDb() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return { version: 1, users: {} };
    }

    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    parsed.users = parsed.users || {};
    return parsed;
  } catch (err) {
    console.error("Failed to load database:", err);
    return { version: 1, users: {} };
  }
}

function saveDb() {
  if (pgPool) {
    queuePostgresSave();
    return;
  }

  ensureDataDir();
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function queuePostgresSave() {
  if (pgSaveInFlight) {
    pgSaveQueued = true;
    return;
  }

  pgSaveInFlight = true;
  persistDbToPostgres()
    .catch((err) => {
      console.error("PostgreSQL save failed:", err.message);
    })
    .finally(() => {
      pgSaveInFlight = false;
      if (pgSaveQueued) {
        pgSaveQueued = false;
        queuePostgresSave();
      }
    });
}

async function persistDbToPostgres() {
  if (!pgPool) return;
  await pgPool.query(
    `
      INSERT INTO mintbot_state (id, data, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
    `,
    ["default", db]
  );
}

function ensureDataDir() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
}

function walletEncryptionReady() {
  return WALLET_ENCRYPTION_KEY && WALLET_ENCRYPTION_KEY.length >= 16;
}

function encryptionKey() {
  return crypto.createHash("sha256").update(WALLET_ENCRYPTION_KEY).digest();
}

function encryptPrivateKey(privateKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptPrivateKey(payload) {
  const [ivHex, tagHex, encryptedHex] = payload.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final()
  ]);
  return decrypted.toString("utf8");
}

function normalizePrivateKey(privateKey) {
  const cleaned = privateKey.trim();
  return cleaned.startsWith("0x") ? cleaned : `0x${cleaned}`;
}

function normalizeTier(tier) {
  if (!tier) return null;
  const value = String(tier).toLowerCase();
  if (["gtd", "guaranteed", "guaranteed allocation"].includes(value)) return "gtd";
  if (["og", "early", "early access"].includes(value)) return "og";
  if (["wl", "whitelist", "allowlist", "al"].includes(value)) return "wl";
  if (["public", "pub"].includes(value)) return "public";
  return null;
}

function normalizeRiskMode(mode) {
  const value = String(mode || "").toLowerCase();
  if (value === "safe") return "safe";
  if (value === "degenerate" || value === "degen") return "degenerate";
  return "fast";
}

function riskModeForUser(user) {
  return RISK_MODES[normalizeRiskMode(user && user.riskMode)] || RISK_MODES.fast;
}

function riskModeForMint(user, mint = null) {
  const key = normalizeRiskMode((mint && mint.riskMode) || (user && user.riskMode));
  return RISK_MODES[key] || RISK_MODES.fast;
}

function gasCapMultiplierPercent(user, mint = null) {
  return riskModeForMint(user, mint).gasCapMultiplierPercent || DEFAULT_GAS_CAP_MULTIPLIER_PERCENT;
}

function extractTier(text) {
  const match = text.match(/\b(gtd|guaranteed|og|wl|whitelist|allowlist|public)\b/i);
  return match ? normalizeTier(match[1]) : null;
}

function extractQuantity(text) {
  const match = text.match(/\b(?:qty|quantity|x)\s*(\d+)\b/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function normalizeTimestamp(value) {
  if (!value) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric > 100000000000 ? numeric : numeric * 1000;
}

function firstKnownPhaseTime(value) {
  return normalizeTimestamp(value.gtdTime)
    || normalizeTimestamp(value.ogTime)
    || normalizeTimestamp(value.wlTime)
    || normalizeTimestamp(value.publicTime)
    || null;
}

function extractAddress(text) {
  const match = text.match(/0x[a-fA-F0-9]{40}/);
  return match && ethers.isAddress(match[0]) ? ethers.getAddress(match[0]) : null;
}

function formatDateTime(timestamp) {
  if (!timestamp) return "not set";
  const date = new Date(Number(timestamp));

  try {
    const local = new Intl.DateTimeFormat("en-US", {
      timeZone: DEFAULT_TIMEZONE,
      month: "short",
      day: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true
    }).format(date);
    const utc = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date);
    return `${local} ${DEFAULT_TIMEZONE} (${utc} UTC)`;
  } catch (err) {
    return date.toISOString();
  }
}

function formatOptionalTime(timestamp) {
  return timestamp ? formatDateTime(timestamp) : "not set";
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "unknown";
  if (ms <= 0) return "open now";

  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatGwei(value) {
  return Number(ethers.formatUnits(value, "gwei")).toFixed(2);
}

function parseEthAmount(text) {
  const match = String(text).trim().match(/^(\d+(?:\.\d+)?)\s*(?:eth)?$/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? match[1] : null;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.floor(numeric);
    }
  }
  return null;
}

function trimEth(value) {
  return String(value).replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
}

function shortAddress(address) {
  if (!address) return "none";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function telegramName(user) {
  return user.username ? `@${user.username}` : (user.firstName || "User");
}

function telegramProfileLink(user) {
  const userId = user.telegramUserId || "";
  const name = escapeHtml(telegramName(user));
  return userId ? `<a href="tg://user?id=${escapeHtml(userId)}">${name}</a>` : name;
}

function pendingFeeForChain(user, chainId) {
  return (user.pendingFees || [])
    .filter((fee) => Number(fee.chainId) === Number(chainId))
    .reduce((sum, fee) => sum + Number(fee.feeEth || 0), 0);
}

function pendingFeeWeiForChain(user, chainId) {
  return (user.pendingFees || [])
    .filter((fee) => Number(fee.chainId) === Number(chainId))
    .reduce((sum, fee) => sum + ethers.parseEther(String(fee.feeEth || 0)), 0n);
}

function clearPendingFeesForChain(user, chainId) {
  user.pendingFees = (user.pendingFees || []).filter((fee) => Number(fee.chainId) !== Number(chainId));
}

function pendingProfitAgreementLine(user, chainId) {
  const fees = (user.pendingFees || []).filter((fee) => Number(fee.chainId) === Number(chainId));
  if (!fees.length) return "";

  const totalFee = fees.reduce((sum, fee) => sum + Number(fee.feeEth || 0), 0);
  if (fees.length === 1) {
    const nftName = fees[0].nftName || "that";
    return `Pending profit agreement from ${nftName} NFT: ${trimEth(totalFee.toFixed(6))} ETH`;
  }

  return `Pending profit agreements from ${fees.length} NFTs: ${trimEth(totalFee.toFixed(6))} ETH`;
}

async function fundingSnapshot(user) {
  const wallet = getActiveWallet(user);
  const nextMint = nextLiveMint(user) || user.pendingMint || null;

  if (!wallet) {
    return null;
  }

  const result = {
    walletAddress: wallet.address,
    network: nextMint ? nextMint.chainName : null,
    targetEth: null,
    balanceEth: null,
    shortfallEth: null
  };

  if (!nextMint) {
    return result;
  }

  const provider = getProvider(nextMint.chainId);
  const balanceWei = await provider.getBalance(wallet.address);
  const mintValue = resolveMintValue(nextMint);
  let gasCapEth = nextMint.gasCapEth || nextMint.recommendedGasCapEth || null;

  if (!gasCapEth) {
    const estimate = await estimateGasCap(0, user, nextMint).catch(() => null);
    gasCapEth = estimate && estimate.gasCapEth ? estimate.gasCapEth : null;
  }

  const gasCapWei = gasCapEth ? ethers.parseEther(String(gasCapEth)) : 0n;
  const targetWei = mintValue + gasCapWei;
  const shortfallWei = targetWei > balanceWei ? targetWei - balanceWei : 0n;

  result.targetEth = trimEth(ethers.formatEther(targetWei));
  result.balanceEth = trimEth(ethers.formatEther(balanceWei));
  result.shortfallEth = trimEth(ethers.formatEther(shortfallWei));
  return result;
}

async function buildPnlDashboard(user) {
  const history = (user.mintHistory || []).filter((item) => item.status === "confirmed");
  const mintedTokens = user.mintedTokens || [];
  const soldTokens = mintedTokens.filter((token) => token.soldAt && token.lastSalePriceEth != null);
  const unsoldTokens = mintedTokens.filter((token) => !token.soldAt);
  const statsCache = new Map();

  const totalSpent = history.reduce((sum, item) => sum + Number(item.totalCostEth || item.valueEth || 0), 0);
  const realized = soldTokens.map((token) => {
    const mintPrice = Number(token.mintPriceEth || 0);
    const salePrice = Number(token.lastSalePriceEth || 0);
    return {
      token,
      profit: salePrice - mintPrice
    };
  });

  let totalUnrealized = 0;
  for (const token of unsoldTokens.slice(0, 20)) {
    const floor = await estimatedTokenValueEth(token, statsCache).catch(() => null);
    if (floor == null) continue;
    totalUnrealized += floor - Number(token.mintPriceEth || 0);
  }

  const best = realized.length
    ? realized.reduce((max, item) => item.profit > max.profit ? item : max, realized[0])
    : null;
  const worst = realized.length
    ? realized.reduce((min, item) => item.profit < min.profit ? item : min, realized[0])
    : null;

  return {
    totalSpentEth: trimEth(totalSpent.toFixed(6)),
    totalWins: realized.filter((item) => item.profit > 0).length,
    totalRealizedProfitEth: trimEth(realized.reduce((sum, item) => sum + item.profit, 0).toFixed(6)),
    totalUnrealizedProfitEth: trimEth(totalUnrealized.toFixed(6)),
    bestHit: best ? `${displayMintedTokenName(best.token)} (${trimEth(best.profit.toFixed(6))} ETH)` : "No realized wins yet",
    worstHit: worst ? `${displayMintedTokenName(worst.token)} (${trimEth(worst.profit.toFixed(6))} ETH)` : "No realized losses yet"
  };
}

async function estimatedTokenValueEth(token, statsCache = new Map()) {
  if (!process.env.OPENSEA_API_KEY) return null;
  const slug = token.openSeaSlug;
  if (!slug) return null;
  if (!statsCache.has(slug)) {
    statsCache.set(slug, fetchOpenSeaCollection(slug, token.chainId).catch(() => null));
  }
  const collection = await statsCache.get(slug);
  return extractFloorPriceEth(collection && collection.stats);
}

function extractFloorPriceEth(stats) {
  const candidates = [
    stats && stats.floor_price,
    stats && stats.total && stats.total.floor_price,
    stats && stats.total && stats.total.floorPrice,
    stats && stats.floorPrice
  ];
  for (const value of candidates) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) {
      return numeric;
    }
  }
  return null;
}

function qrCodeUrl(value) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(String(value || ""))}`;
}

async function sendTxResult(chatId, title, txHash, chainId) {
  const url = explorerTxUrl(chainId, txHash);
  const options = url
    ? {
        reply_markup: {
          inline_keyboard: [[{ text: "View Transaction", url }]]
        }
      }
    : {};

  await safeSend(
    chatId,
    [
      title,
      "Submitted. Tap below to view it."
    ].join("\n"),
    options
  );
}

function explorerTxUrl(chainId, txHash) {
  if (!txHash) return "";
  if (Number(chainId) === 8453) return `https://basescan.org/tx/${txHash}`;
  if (Number(chainId) === 1) return `https://etherscan.io/tx/${txHash}`;
  return "";
}

function openSeaAssetUrl(chainId, contractAddress, tokenId) {
  const chain = getChainConfig(chainId);
  if (!chain || !contractAddress || tokenId == null) return "";
  return Number(chain.chainId) === 1
    ? `https://opensea.io/assets/ethereum/${contractAddress}/${tokenId}`
    : `https://opensea.io/assets/${chain.openSeaChain}/${contractAddress}/${tokenId}`;
}

function openSeaSdkChain(chainId, ChainEnum = {}) {
  if (Number(chainId) === 8453) {
    return ChainEnum.Base || "base";
  }
  return ChainEnum.Mainnet || ChainEnum.Ethereum || "mainnet";
}

function userFriendlyError(err, fallback = "That action did not go through. Try again or buy from the mint page.") {
  const message = err && err.message ? String(err.message).toLowerCase() : String(err || "").toLowerCase();

  if (message.includes("gas cap exceeded")) {
    return "Gas ran over your limit, so the bot skipped the buy instead of chasing it.";
  }
  if (message.includes("insufficient eth") || message.includes("insufficient funds")) {
    return "Your live wallet does not have enough ETH for the buy and gas.";
  }
  if (message.includes("no compatible mint function") || message.includes("custom function")) {
    return "This drop needs extra steps from the mint page. Buy it from the official page instead.";
  }
  if (message.includes("private relay") || message.includes("flashbots")) {
    return "Private send is unavailable for this drop right now. Turn it off or buy from the mint page.";
  }
  if (message.includes("approval") || message.includes("approved")) {
    return "OpenSea needs one approval before this item can be listed. Open it once on OpenSea, approve it, then come back.";
  }
  if (message.includes("opensea")) {
    return "OpenSea could not finish that request right now. Try again in a moment.";
  }
  if (message.includes("revert") || message.includes("not active") || message.includes("not live")) {
    return "The drop was not open for that try. The bot will keep trying while your retry window is still alive.";
  }
  if (message.includes("wallet") || message.includes("private key")) {
    return "Set a live mint wallet first.";
  }

  return fallback;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function groupUnhandledInteractions() {
  const groups = new Map();
  for (const item of (db.analytics && db.analytics.unhandled) || []) {
    const key = item.type || "unknown";
    const existing = groups.get(key) || { type: key, count: 0, users: new Set() };
    existing.count += 1;
    existing.users.add(item.userId);
    groups.set(key, existing);
  }
  return [...groups.values()]
    .map((item) => ({ type: item.type, count: item.count, uniqueUsers: item.users.size }))
    .sort((a, b) => b.uniqueUsers - a.uniqueUsers || b.count - a.count);
}

function topEntries(object, limit = 5) {
  return Object.entries(object || {}).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function redactSensitive(value) {
  return String(value)
    .replace(/0x[a-fA-F0-9]{64}/g, "[private-key]")
    .replace(/[A-Za-z0-9+/=]{80,}/g, "[long-token]");
}

function shortError(err) {
  const message = err && err.message ? err.message : String(err);
  return message.replace(/\s+/g, " ").slice(0, 240);
}

function randomId(bytes = 8) {
  return crypto.randomBytes(bytes).toString("hex");
}

function timerKeyFor(chatId, mintId) {
  return `${chatId}:${mintId}`;
}

function rememberHistory(user, role, content) {
  user.history = user.history || [];
  user.history.push({ role, content: String(content).slice(0, 2000) });
  user.history = user.history.slice(-10);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeSend(chatId, text, options = {}) {
  try {
    return await bot.sendMessage(chatId, text, {
      disable_web_page_preview: true,
      ...options
    });
  } catch (err) {
    console.error("sendMessage failed:", err.message);
    return null;
  }
}

async function safeEdit(chatId, messageId, text, options = {}) {
  try {
    return await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      disable_web_page_preview: true,
      ...options
    });
  } catch (err) {
    console.error("editMessageText failed:", err.message);
    return null;
  }
}

async function safeSendPhoto(chatId, photo, options = {}) {
  try {
    return await bot.sendPhoto(chatId, photo, options);
  } catch (err) {
    console.error("sendPhoto failed:", err.message);
    return null;
  }
}

async function safeDelete(chatId, messageId) {
  try {
    await bot.deleteMessage(chatId, messageId);
  } catch (err) {
    // Telegram only allows deleting recent messages and messages the bot can access.
  }
}
