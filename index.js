require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const EventEmitter = require("events");
const { ethers } = require("ethers");

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const LEGACY_RPC_URL     = process.env.RPC_URL;
const LEGACY_CHAIN_ID    = Number(process.env.CHAIN_ID || 1);
// C-3: Warn on deprecated env vars so operators know to migrate.
if (process.env.RPC_URL || process.env.CHAIN_ID) {
  console.warn("[DEPRECATED] RPC_URL / CHAIN_ID are deprecated. Use ETHEREUM_RPC_URL / BASE_RPC_URL instead.");
}
const DEFAULT_TIMEZONE   = process.env.DEFAULT_TIMEZONE || "UTC";
const AUTO_MINT_DELAY_MS = Number(process.env.AUTO_MINT_DELAY_MS   || 5000);
const POLL_MS            = Number(process.env.POLL_INTERVAL_MS     || 30000);
const RETRY_WINDOW_MS    = Number(process.env.AUTO_MINT_RETRY_WINDOW_MS || 300000);
const MAX_ATTEMPTS       = Number(process.env.AUTO_MINT_MAX_ATTEMPTS    || 10);
const TOP_OFFER_POLL_MS  = Number(process.env.TOP_OFFER_POLL_MS    || 120000);
const SALE_POLL_MS       = Number(process.env.SALE_POLL_MS         || 600000);
const STATE_TIMEOUT_MS   = Number(process.env.STATE_TIMEOUT_MS     || 600000);
const BASE_GAS_BOOST     = 110n;
const GAS_WAR_STEP       = BigInt(process.env.GAS_WAR_STEP_PERCENT || 15);
const DEFAULT_GAS_LIMIT  = BigInt(process.env.DEFAULT_GAS_LIMIT    || 300000);
const WALLET_KEY         = process.env.WALLET_ENCRYPTION_KEY || "";
const ADMIN_ID           = Number(process.env.ADMIN_USER_ID   || 0);
const TREASURY           = process.env.TREASURY_WALLET        || "";
const FEE_BPS            = 500;

const DEFAULT_DATA_FILE = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "mintbot.json")
  : "./data/mintbot.json";
const DATA_FILE = path.resolve(__dirname, process.env.DATA_FILE || DEFAULT_DATA_FILE);

const RPC_ETH  = [process.env.RPC_URL_1||process.env.ETHEREUM_RPC_URL||(LEGACY_CHAIN_ID===1?LEGACY_RPC_URL:null), process.env.RPC_URL_2, process.env.RPC_URL_3].filter(Boolean);
const RPC_BASE = [process.env.BASE_RPC_URL||(LEGACY_CHAIN_ID===8453?LEGACY_RPC_URL:null)].filter(Boolean);

const CHAIN = {
  ethereum: { key:"ethereum", chainId:1,    chainName:"Ethereum", openSeaChain:"ethereum", rpcUrls:RPC_ETH,  flashbotsRpc:"https://rpc.flashbots.net" },
  base:     { key:"base",     chainId:8453, chainName:"Base",     openSeaChain:"base",     rpcUrls:RPC_BASE, flashbotsRpc:"https://rpc.flashbots.net/fast" }
};
const OS_CHAIN_TO_ID = Object.fromEntries(Object.values(CHAIN).map(c=>[c.openSeaChain,c.chainId]));

const REMINDERS = [
  {key:"r_86400",seconds:86400,label:"24h"},{key:"r_43200",seconds:43200,label:"12h"},
  {key:"r_21600",seconds:21600,label:"6h"}, {key:"r_10800",seconds:10800,label:"3h"},
  {key:"r_3600", seconds:3600, label:"1h"}, {key:"r_1800", seconds:1800, label:"30m"},
  {key:"r_900",  seconds:900,  label:"15m"},{key:"r_300",  seconds:300,  label:"5m"}
];

// 5 keyboard buttons. Clean.
const KEYBOARD = { reply_markup:{ keyboard:[["Track","Wallet"],["Status","Gas","History"]], resize_keyboard:true, one_time_keyboard:false }};

const MINT_FN_PRIORITY = ["mint","publicMint","publicSaleMint","whitelistMint","allowlistMint","presaleMint","ogMint","gtdMint","claim","purchase"];

const COMMON_ABI = [
  "function mint() payable","function mint(uint256 quantity) payable","function mint(address to, uint256 quantity) payable",
  "function publicMint() payable","function publicMint(uint256 quantity) payable","function publicMint(address to, uint256 quantity) payable",
  "function whitelistMint(uint256 quantity) payable","function allowlistMint(uint256 quantity) payable",
  "function presaleMint(uint256 quantity) payable","function claim(uint256 quantity) payable","function purchase(uint256 quantity) payable",
  "function totalSupply() view returns (uint256)","function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)"
];
const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)","function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)","function symbol() view returns (string)"
];
const ERC721_ABI = [
  "function transferFrom(address from, address to, uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
];

const PHASE_TIMES = {
  gtd:    ["gtdStartTime","gtdMintStartTime","guaranteedStartTime","guaranteedMintStartTime","earlyAccessStartTime","startGTD"],
  og:     ["ogStartTime","ogMintStartTime","presaleStartTime","privateSaleStartTime","startOG"],
  wl:     ["wlStartTime","wlMintStartTime","whitelistStartTime","allowlistStartTime","presaleStartTime","preSaleStartTime","startWhitelist"],
  public: ["publicStartTime","publicMintStartTime","saleStartTime","mintStartTime","startTime","saleStart","mintStart","publicSaleStart","startPublic"]
};
const PRICE_READS = ["mintPrice","price","cost","publicPrice","publicSalePrice","salePrice","tokenPrice","MINT_PRICE","PUBLIC_PRICE","PRICE"];
const PHASE_PRICES = {
  gtd:["gtdPrice","guaranteedPrice","guaranteedMintPrice"],
  og:["ogPrice","ogMintPrice","presalePrice"],
  wl:["wlPrice","whitelistPrice","allowlistPrice","presalePrice"],
  public:["publicPrice","publicSalePrice","mintPrice","price","cost"]
};
const READ_ONLY_ABI = [...new Set([...Object.values(PHASE_TIMES).flat(),...PRICE_READS,...Object.values(PHASE_PRICES).flat()])].map(n=>`function ${n}() view returns (uint256)`);

const REVERT_SOLD_OUT   = ["sold out","max supply","exceeds max","supply exceeded","no more tokens","soldout","maxsupply"];
const REVERT_PER_WALLET = ["max per wallet","already claimed","exceeds allowance","mint limit","already minted","wallet limit","per wallet"];
const REVERT_WRONG_PHASE = ["not active","sale not live","presale not active","not whitelisted","not on allowlist","invalid proof","not eligible","not started","paused"];

if (!TELEGRAM_BOT_TOKEN) { console.error("TELEGRAM_BOT_TOKEN missing"); process.exit(1); }

// ─── TELEGRAM CLIENT ─────────────────────────────────────────────────────────
class TelegramBot extends EventEmitter {
  constructor(token, options={}) {
    super(); this.token=token; this.offset=0; this.textHandlers=[];
    if (options.polling) this.pollLoop();
  }
  onText(regex,fn){ this.textHandlers.push({regex,fn}); }
  async api(method, payload={}) {
    const res  = await fetch(`https://api.telegram.org/bot${this.token}/${method}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
    const data = await res.json().catch(()=>null);
    if (!res.ok||!data?.ok) throw new Error(`Telegram ${method}: ${data?.description||res.statusText}`);
    return data.result;
  }
  async setMyCommands(c) { return this.api("setMyCommands",{commands:c}); }
  async sendMessage(chatId,text,opts={}) { return this.api("sendMessage",{chat_id:chatId,text,...opts}); }
  async editMessageText(text,opts={}) { return this.api("editMessageText",{text,...opts}); }
  async deleteMessage(chatId,messageId) { return this.api("deleteMessage",{chat_id:chatId,message_id:messageId}); }
  async answerCallbackQuery(id,opts={}) { return this.api("answerCallbackQuery",{callback_query_id:id,...opts}); }
  async pollLoop() {
    while (true) {
      try {
        const updates = await this.api("getUpdates",{offset:this.offset,timeout:25,allowed_updates:["message","callback_query"]});
        for (const u of updates) { this.offset=u.update_id+1; this.handleUpdate(u); }
      } catch(err) { this.emit("polling_error",err); await sleep(3000); }
    }
  }
  handleUpdate(u) {
    if (u.message) {
      const msg=u.message;
      // R-1: Only dispatch to message listener if no onText handler matched.
      // Firing both causes a race condition when handlers mutate shared state.
      let textHandled=false;
      if (msg.text) for (const h of this.textHandlers) { h.regex.lastIndex=0; const m=msg.text.match(h.regex); if(m) { textHandled=true; Promise.resolve(h.fn(msg,m)).catch(e=>this.emit("polling_error",e)); } }
      if (!textHandled) this.dispatch("message",msg);
    }
    if (u.callback_query) this.dispatch("callback_query",u.callback_query);
  }
  dispatch(event,...args) {
    for (const l of this.listeners(event)) { try { Promise.resolve(l(...args)).catch(e=>this.emit("polling_error",e)); } catch(e){this.emit("polling_error",e);} }
  }
}

// ─── RPC FALLBACK ─────────────────────────────────────────────────────────────
class FallbackProvider {
  constructor(urls,chainId,chainName) {
    this.urls=urls; this.chainId=chainId; this.chainName=chainName; this.idx=0;
    this.providers=urls.map(u=>new ethers.JsonRpcProvider(u,chainId));
  }
  getActive(){ return this.providers[this.idx]; }
  async call(method,...args) {
    for (let i=0;i<this.providers.length;i++) {
      const idx=(this.idx+i)%this.providers.length;
      try { const r=await this.providers[idx][method](...args); this.idx=idx; return r; }
      catch(err) { if(i===this.providers.length-1) throw err; console.warn(`${this.chainName} RPC[${idx}] failed, trying next`); }
    }
  }
  getBlock(t)              { return this.call("getBlock",t); }
  getFeeData()             { return this.call("getFeeData"); }
  getBalance(a)            { return this.call("getBalance",a); }
  getCode(a)               { return this.call("getCode",a); }
  getTransactionReceipt(h) { return this.call("getTransactionReceipt",h); }
  getNetwork()             { return this.call("getNetwork"); }
  estimateGas(tx)          { return this.call("estimateGas",tx); }
  getLogs(f)               { return this.call("getLogs",f); }
}

// ─── BOOT ────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN,{polling:true});
const providers = new Map(Object.values(CHAIN).filter(c=>c.rpcUrls?.length).map(c=>[c.chainId,new FallbackProvider(c.rpcUrls,c.chainId,c.chainName)]));
const mintTimers      = new Map();
const mempoolWatchers = new Map();
const topOfferWatchers= new Map();
const saleWatchers    = new Map();
let db = loadDb();
ensureDataDir();
armAll();
// R-2: Use recursive setTimeout instead of setInterval so each loop waits
// for the previous invocation to finish before scheduling the next tick.
// setInterval on async functions allows overlapping concurrent executions
// which causes duplicate messages and concurrent writes to shared state.
(async function runPollLoop() {
  await pollLoop().catch(err => console.error("pollLoop error:", err));
  setTimeout(runPollLoop, POLL_MS);
})();
(async function runCheckTopOffers() {
  await checkTopOffers().catch(err => console.error("checkTopOffers error:", err));
  setTimeout(runCheckTopOffers, TOP_OFFER_POLL_MS);
})();
(async function runCheckSales() {
  await checkSales().catch(err => console.error("checkSales error:", err));
  setTimeout(runCheckSales, SALE_POLL_MS);
})();
setInterval(clearExpiredStates,60000);

// ─── COMMANDS ─────────────────────────────────────────────────────────────────
bot.setMyCommands([
  {command:"start",   description:"Open MintBot"},
  {command:"track",   description:"Track a drop"},
  {command:"wallet",  description:"Wallets"},
  {command:"status",  description:"Active mints"},
  {command:"gas",     description:"Gas prices"},
  {command:"history", description:"History & P&L"},
  {command:"trending",description:"Trending drops"}, // U-4: was missing
  {command:"blast",   description:"Multi-wallet blast"},
  {command:"reset",   description:"Clear stuck state"},
  {command:"stats",   description:"Admin only"}
]).catch(e=>console.error("setMyCommands:",e.message));

bot.onText(/^\/start\b/,   async msg=>sendStart(msg.chat.id,msg.from));
bot.onText(/^\/track\b/,   async msg=>startTrack(msg.chat.id));
bot.onText(/^\/wallet\b/,  async msg=>sendWalletMenu(msg.chat.id));
bot.onText(/^\/status\b/,  async msg=>sendStatus(msg.chat.id));
bot.onText(/^\/gas\b/,     async msg=>sendGas(msg.chat.id));
bot.onText(/^\/history\b/, async msg=>sendHistory(msg.chat.id));
bot.onText(/^\/trending\b/, async msg=>sendTrending(msg.chat.id));
bot.onText(/^\/blast\b/,   async msg=>sendBlastMenu(msg.chat.id));
bot.onText(/^\/reset\b/,   async msg=>resetState(msg.chat.id));
bot.onText(/^\/stats\b/,   async msg=>sendAdminStats(msg.chat.id,msg.from.id));
bot.onText(/^\/setwallet(?:\s+(.+))?$/s, async(msg,match)=>{
  const chatId=msg.chat.id;
  await safeDelete(chatId,msg.message_id);
  const key=(match?.[1]||"").trim();
  if (!key) { const u=getUser(chatId); u.state={mode:"import_wallet",at:Date.now()}; saveDb(); await send(chatId,"Drop the private key. I'll delete it right after.\n\nUse a dedicated mint wallet — never your main."); return; }
  await importWallet(chatId,key);
});

// ─── CALLBACKS ───────────────────────────────────────────────────────────────
bot.on("callback_query", async query=>{
  try { await handleCallback(query); }
  catch(err) { console.error("callback_query:",err); if(query.message) await send(query.message.chat.id,`Something broke: ${shortErr(err)}`); }
});

async function handleCallback(query) {
  const data=query.data||""; const chatId=query.message.chat.id; const msgId=query.message.message_id; const user=getUser(chatId);
  await bot.answerCallbackQuery(query.id).catch(()=>{});

  if (data==="start")            { await sendStart(chatId,query.from); return; }
  if (data==="track:start")      { await startTrack(chatId); return; }
  if (data==="wallet:menu")      { await sendWalletMenu(chatId); return; }
  if (data==="leaderboard")      { await sendLeaderboard(chatId); return; }
  if (data==="trending")         { await sendTrending(chatId); return; }
  if (data==="blast:menu")       { await sendBlastMenu(chatId); return; }
  if (data==="instant_mint")     { await promptInstantMint(chatId); return; }
  if (data==="wallet:create")    { await createWallet(chatId); return; }
  if (data==="wallet:import")    { user.state={mode:"import_wallet",at:Date.now()}; saveDb(); await send(chatId,"Drop the private key. I'll delete it right after.\n\nUse a dedicated mint wallet — never your main."); return; }
  if (data==="wallet:list")      { await sendWalletList(chatId); return; }
  if (data==="wallet:export")    { await sendExportMenu(chatId); return; }
  if (data==="wallet:receive")   { await showReceive(chatId); return; }
  if (data==="wallet:send_nft")  { await startSendNft(chatId); return; }
  if (data==="wallet:send_token"){ await startSendToken(chatId); return; }
  if (data==="gas:refresh")      { await sendGas(chatId,{editId:msgId}); return; }
  if (data==="gas:toggle_war")   { user.gasWarMode=!user.gasWarMode; saveDb(); await sendGas(chatId,{editId:msgId}); return; }

  if (data.startsWith("wallet:switch:"))     { await switchWallet(chatId,data.split(":")[2]); return; }
  if (data.startsWith("wallet:export_warn:")){ await sendExportWarning(chatId,data.split(":")[2]); return; }
  if (data.startsWith("wallet:export_ok:")) { await exportWallet(chatId,data.split(":")[2]); return; }
  if (data.startsWith("stage:"))            { await verifyAndBuildMint(chatId,{...(user.state?.draft||{}),userTier:data.split(":")[1]}); return; }

  if (data.startsWith("confirm:"))           { await confirmMint(chatId,data.split(":")[1]); return; }
  if (data.startsWith("cancel_pending:")) {
    const id=data.split(":")[1];
    if (user.pendingMint?.id===id) { user.pendingMint=null; user.state={}; saveDb(); }
    await safeEdit(chatId,msgId,"Cancelled. Drop a new URL whenever you're ready."); return;
  }
  if (data.startsWith("toggle:")) {
    const [,field,id]=data.split(":");
    if (!user.pendingMint||user.pendingMint.id!==id) { await send(chatId,"This mint setup expired. Start fresh."); return; }
    const m=user.pendingMint;
    if (field==="reminders") m.remindersEnabled=!m.remindersEnabled;
    if (field==="auto")      m.autoMintEnabled=!m.autoMintEnabled;
    if (field==="gaswar")    m.gasWarMode=!m.gasWarMode;
    if (field==="flashbots") m.flashbotsEnabled=!m.flashbotsEnabled;
    m.updatedAt=Date.now(); saveDb();
    await safeEdit(chatId,msgId,mintCard(chatId,m),{reply_markup:mintKeyboard(m)}); return;
  }
  if (data.startsWith("set_gas_cap:")) {
    const id=data.split(":")[1];
    if (!user.pendingMint||user.pendingMint.id!==id) { await send(chatId,"Mint setup expired."); return; }
    user.state={mode:"gas_cap",mintId:id,ctx:"pending",at:Date.now()}; saveDb();
    await send(chatId,`Gas cap — estimated at ${user.pendingMint._estCap||"?"} ETH.\n\nReply with your max in ETH, or "ok" to accept.`); return;
  }
  if (data.startsWith("set_target_list:"))   { user.state={mode:"target_list",mintId:data.split(":")[1],at:Date.now()}; saveDb(); await send(chatId,"Target list price in ETH — I'll alert you when the floor hits it.\n\nReply with a number (e.g. 0.5)."); return; }
  if (data.startsWith("set_profit_alert:"))  { user.state={mode:"profit_alert",mintId:data.split(":")[1],at:Date.now()}; saveDb(); await send(chatId,"Starting profit multiple for alerts (default: 2x).\n\nReply with a number (e.g. 3 = alert at 3x, 4x, 5x...)."); return; }
  if (data.startsWith("cancel_mint:")) {
    const id=data.split(":")[1]; const mint=(user.mints||[]).find(m=>m.id===id);
    if (mint) { clearMintTimer(chatId,id); stopMempoolWatcher(id); stopTopOfferWatcher(chatId,id); stopSaleWatcher(chatId,id); mint.completedAt=Date.now(); mint.cancelledManually=true; saveDb(); await send(chatId,`Cancelled: ${mint.mintName}.\n\nWatchers stopped.`); }
    return;
  }
  if (data.startsWith("instant_mint:")) { const id=data.split(":")[1]; const m=(user.mints||[]).find(x=>x.id===id); if(m) await doInstantMint(chatId,m); return; }
  if (data.startsWith("watch_offer:")) { const id=data.split(":")[1]; const m=(user.mints||[]).find(x=>x.id===id); if(m){startTopOfferWatcher(chatId,m); await send(chatId,`Watching ${m.mintName}.\nAlerts at 2x, 3x, 4x profit and at -50%, -75%.`);} return; }
  if (data.startsWith("stop_watching:")) { const parts=data.split(":"); const id=parts.length===3?parts[2]:parts[1]; stopTopOfferWatcher(chatId,id); await send(chatId,"Stopped. Restart from Status."); return; }
  if (data.startsWith("list_for_sale:"))  { user.state={mode:"list_price",mintId:data.split(":")[1],at:Date.now()}; saveDb(); await send(chatId,"List price in ETH?\n\nReply with a number (e.g. 0.5)."); return; }
  if (data.startsWith("view_rarity:"))    { const [,id,tok]=data.split(":"); const m=(user.mints||[]).find(x=>x.id===id); if(m) await showRarity(chatId,m,tok); return; }
  if (data.startsWith("accept_offer:"))   { await send(chatId,"Accept the offer directly on OpenSea — open the NFT page and tap Accept Offer."); return; }
  if (data.startsWith("blast:confirm:"))  { await executeBlast(chatId,data.split(":")[2]); return; }
  if (data.startsWith("track_slug:"))     { await handleTrackInput(chatId,`https://opensea.io/collection/${data.split(":")[1]}`); return; }
}

// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────────
bot.on("message", async msg=>{
  if (!msg.text) return;
  const text=msg.text.trim(); const chatId=msg.chat.id;
  saveProfile(chatId,msg.from);
  if (text.startsWith("/")) return;
  try {
    const lower=text.toLowerCase();
    if (lower==="track")    { await startTrack(chatId);     return; }
    if (lower==="wallet")   { await sendWalletMenu(chatId); return; }
    if (lower==="status")   { await sendStatus(chatId);     return; }
    if (lower==="gas")      { await sendGas(chatId);        return; }
    if (lower==="history")  { await sendHistory(chatId);    return; }
    if (lower==="trending") { await sendTrending(chatId);   return; }

    const user=getUser(chatId);
    // F-5: Always check expiry inline before dispatching state-sensitive handlers.
    // import_wallet state can persist across restarts (it's saved to disk), so we
    // must guard here — not only in the 60s clearExpiredStates interval.
    if (user.state?.at&&Date.now()-user.state.at>STATE_TIMEOUT_MS) user.state={};
    if (user.state?.mode==="import_wallet")        { await safeDelete(chatId,msg.message_id); await importWallet(chatId,text); return; }
    if (user.state?.mode==="track_input")          { await handleTrackInput(chatId,text); return; }
    if (user.state?.mode==="gas_cap")              { await handleGasCap(chatId,text,user.state); return; }
    if (user.state?.mode==="instant_url")          { await doInstantMintFromUrl(chatId,text); return; }
    if (user.state?.mode==="send_nft_id")          { await handleSendNftId(chatId,text,user.state); return; }
    if (user.state?.mode==="send_nft_to")          { await handleSendNftTo(chatId,text,user.state); return; }
    if (user.state?.mode==="send_token_contract")  { await handleSendTokenContract(chatId,text); return; }
    if (user.state?.mode==="send_token_amount")    { await handleSendTokenAmount(chatId,text,user.state); return; }
    if (user.state?.mode==="send_token_to")        { await handleSendTokenTo(chatId,text,user.state); return; }
    if (user.state?.mode==="list_price")           { await handleListPrice(chatId,text,user.state); return; }
    if (user.state?.mode==="target_list")          { await handleTargetList(chatId,text,user.state); return; }
    if (user.state?.mode==="profit_alert")         { await handleProfitAlert(chatId,text,user.state); return; }
    if (user.state?.mode==="blast_url")            { await handleBlastUrl(chatId,text); return; }
    if (looksLikeMint(text)) { await handleTrackInput(chatId,text); return; }
    logUnhandled(chatId,text);
    await send(chatId,"Drop an OpenSea URL to track a mint, or use the menu.",KEYBOARD);
  } catch(err) { console.error("message handler:",err); await send(chatId,`Hit an error: ${shortErr(err)}`); }
});

bot.on("polling_error", err=>console.error("polling:",err.message));
process.on("unhandledRejection", err=>console.error("unhandledRejection:",err));
process.on("uncaughtException",  err=>console.error("uncaughtException:",err));

// ─── START / DASHBOARD ───────────────────────────────────────────────────────
async function sendStart(chatId,from) {
  saveProfile(chatId,from);
  const user=getUser(chatId); const wallet=activeWallet(user);
  const isNew=!wallet&&!(user.wallets||[]).length;
  const name=from?.first_name||null;
  const activeMints=(user.mints||[]).filter(m=>m.confirmed&&!m.completedAt).length;

  if (isNew) {
    await send(chatId,[
      name?`${name}.`:"You're in.",
      "",
      "Most people miss drops because they're too slow.",
      "MintBot fires the moment your window opens — before most wallets even send.",
      "",
      "One thing standing between you and your first mint: a wallet.",
      "Takes 30 seconds."
    ].join("\n"),{reply_markup:{inline_keyboard:[
      [{text:"⚡ Create Wallet — 30 seconds",callback_data:"wallet:create"}],
      [{text:"🔑 Import Existing Wallet",callback_data:"wallet:import"}]
    ]}});
    return;
  }

  const bal=await quickBalance(wallet);
  const pnl=getPnL(user);
  await send(chatId,[
    name?`${name}.`:"Back.",
    "",
    `💼 ${shortAddr(wallet.address)}  ${bal}`,
    activeMints?`🎯 ${activeMints} mint${activeMints>1?"s":""} armed.`:"Nothing armed.",
    pnl.totalMints?`📈 ${pnl.totalMints} mints  |  net ${pnl.net>=0?"+":""}${pnl.net.toFixed(4)} ETH`:"",
    "",
    "What's next?"
  ].filter(l=>l!=="").join("\n"),{
    // U-8: Only send the inline keyboard here. KEYBOARD (persistent reply keyboard)
    // uses the same reply_markup key and would overwrite the inline buttons if spread.
    // The persistent keyboard is already visible from previous sends; no need to re-send.
    reply_markup:{inline_keyboard:[
      [{text:"📊 Track a Drop",callback_data:"track:start"},{text:"⚡ Instant Mint",callback_data:"instant_mint"}],
      [{text:"📤 Send NFT",callback_data:"wallet:send_nft"},{text:"📥 Receive",callback_data:"wallet:receive"}],
      [{text:"🏆 Leaderboard",callback_data:"leaderboard"},{text:"🔥 Trending",callback_data:"trending"}],
      [{text:"💣 Blast Mint",callback_data:"blast:menu"}]
    ]}
  });
}

// ─── WALLET ───────────────────────────────────────────────────────────────────
async function sendWalletMenu(chatId) {
  const user=getUser(chatId); const wallet=activeWallet(user);
  const bal=wallet?await quickBalance(wallet):"";
  await send(chatId,[
    "Your Wallets","",
    wallet?`Active: ${shortAddr(wallet.address)}  ${bal}`:"No wallet set.",
    `Total: ${(user.wallets||[]).length}`,
    "",
    "Use a dedicated mint wallet. Keep only what you need for minting."
  ].join("\n"),{reply_markup:{inline_keyboard:[
    [{text:"➕ Create New Wallet",callback_data:"wallet:create"}],
    [{text:"🔑 Import Wallet",callback_data:"wallet:import"}],
    [{text:"🔄 Switch Wallet",callback_data:"wallet:list"}],
    [{text:"🔐 Export Key",callback_data:"wallet:export"}],
    [{text:"📥 Receive",callback_data:"wallet:receive"},{text:"📤 Send NFT",callback_data:"wallet:send_nft"}],
    [{text:"🪙 Send Token",callback_data:"wallet:send_token"}]
  ]}});
}

async function createWallet(chatId) {
  if (!encReady()) { await send(chatId,"WALLET_ENCRYPTION_KEY not set. Add it to .env first."); return; }
  const user=getUser(chatId); const w=ethers.Wallet.createRandom();
  const record={id:uid(8),name:`Wallet ${(user.wallets||[]).length+1}`,address:w.address,encKey:encryptKey(w.privateKey),createdAt:Date.now()};
  user.wallets=user.wallets||[]; user.wallets.push(record); user.activeWalletId=record.id; saveDb();
  const msg=await send(chatId,[`Wallet created.`,``,`Address: ${w.address}`,``,`Private key — save this now. Deletes in 30 seconds:`,``,w.privateKey].join("\n"));
  if (msg?.message_id) setTimeout(()=>safeDelete(chatId,msg.message_id),30000);
  await send(chatId,`Active: ${shortAddr(w.address)}\n\nNow track a drop.`,KEYBOARD);
}

async function importWallet(chatId,rawKey) {
  if (!encReady()) { await send(chatId,"WALLET_ENCRYPTION_KEY not set in .env."); return; }
  const user=getUser(chatId); user.state={};
  let w;
  try { w=new ethers.Wallet(normKey(rawKey)); rawKey=normKey(rawKey); }
  catch { saveDb(); await send(chatId,"Invalid private key.\n\nTry /setwallet again."); return; }
  user.wallets=user.wallets||[];
  const ex=user.wallets.find(x=>x.address.toLowerCase()===w.address.toLowerCase());
  if (ex) { ex.encKey=encryptKey(rawKey); ex.updatedAt=Date.now(); user.activeWalletId=ex.id; }
  else { const r={id:uid(8),name:`Wallet ${user.wallets.length+1}`,address:w.address,encKey:encryptKey(rawKey),createdAt:Date.now()}; user.wallets.push(r); user.activeWalletId=r.id; }
  saveDb();
  await send(chatId,`Imported and set active:\n${shortAddr(w.address)}\n\nTrack a drop to start.`,KEYBOARD);
}

async function sendWalletList(chatId) {
  const user=getUser(chatId); const wallets=user.wallets||[];
  if (!wallets.length) { await send(chatId,"No wallets yet.",{reply_markup:{inline_keyboard:[[{text:"Create Wallet",callback_data:"wallet:create"}]]}}); return; }
  await send(chatId,"Select active wallet:",{reply_markup:{inline_keyboard:wallets.map(w=>[{text:`${w.id===user.activeWalletId?"✓ ":""}${shortAddr(w.address)}`,callback_data:`wallet:switch:${w.id}`}])}});
}

async function sendExportMenu(chatId) {
  const user=getUser(chatId); const wallets=user.wallets||[];
  if (!wallets.length) { await send(chatId,"No wallets to export."); return; }
  await send(chatId,"Which wallet?",{reply_markup:{inline_keyboard:wallets.map(w=>[{text:`${w.id===user.activeWalletId?"✓ ":""}${shortAddr(w.address)}`,callback_data:`wallet:export_warn:${w.id}`}])}});
}

async function sendExportWarning(chatId,walletId) {
  const user=getUser(chatId); const wallet=(user.wallets||[]).find(w=>w.id===walletId);
  if (!wallet) { await send(chatId,"Wallet not found."); return; }
  await send(chatId,`Export: ${shortAddr(wallet.address)}\n\nAnyone who sees this key owns this wallet.\nDeletes in 30 seconds.`,
    {reply_markup:{inline_keyboard:[[{text:"Show Key",callback_data:`wallet:export_ok:${wallet.id}`}],[{text:"Cancel",callback_data:"wallet:menu"}]]}});
}

async function exportWallet(chatId,walletId) {
  const user=getUser(chatId); const wallet=(user.wallets||[]).find(w=>w.id===walletId);
  if (!wallet?.encKey) { await send(chatId,"Can't export this wallet."); return; }
  let key; try { key=decryptKey(wallet.encKey); } catch { await send(chatId,"Decryption failed. Check WALLET_ENCRYPTION_KEY."); return; }
  const msg=await send(chatId,`${shortAddr(wallet.address)}\n\n${key}\n\nDeletes in 30 seconds.`);
  if (msg?.message_id) setTimeout(()=>safeDelete(chatId,msg.message_id),30000);
}

async function switchWallet(chatId,walletId) {
  const user=getUser(chatId); const wallet=(user.wallets||[]).find(w=>w.id===walletId);
  if (!wallet) { await send(chatId,"Wallet not found."); return; }
  user.activeWalletId=wallet.id; saveDb();
  const bal=await quickBalance(wallet);
  await send(chatId,`Active: ${shortAddr(wallet.address)}  ${bal}`,KEYBOARD);
}

async function showReceive(chatId) {
  const user=getUser(chatId); const wallet=activeWallet(user);
  if (!wallet) { await send(chatId,"Set a wallet first.",{reply_markup:{inline_keyboard:[[{text:"Create Wallet",callback_data:"wallet:create"}]]}}); return; }
  await send(chatId,`Your address:\n\n${wallet.address}\n\nShare this to receive ETH, tokens, or NFTs on Ethereum and Base.`);
}

// ─── SEND NFT / TOKEN ─────────────────────────────────────────────────────────
async function startSendNft(chatId) {
  const user=getUser(chatId);
  if (!activeWallet(user)) { await send(chatId,"Set a wallet first."); return; }
  user.state={mode:"send_nft_id",at:Date.now()}; saveDb();
  await send(chatId,"Send NFT\n\nReply with the contract address and token ID:\n\nExample: 0xAbCd...1234 42");
}
async function handleSendNftId(chatId,text,state) {
  const parts=text.trim().split(/\s+/); const contract=parts.find(p=>ethers.isAddress(p)); const tokenId=parts.find(p=>/^\d+$/.test(p));
  if (!contract||!tokenId) { await send(chatId,"Need a contract address and token ID.\n\nExample: 0xAbCd...1234 42"); return; }
  const user=getUser(chatId); user.state={mode:"send_nft_to",contract:ethers.getAddress(contract),tokenId,at:Date.now()}; saveDb();
  await send(chatId,`Token #${tokenId} from ${shortAddr(contract)}.\n\nDestination address:`);
}
async function handleSendNftTo(chatId,text,state) {
  const to=extractAddr(text); if (!to) { await send(chatId,"Invalid address. Try again."); return; }
  const user=getUser(chatId); user.state={}; saveDb();
  const wallet=activeWallet(user); if (!wallet) { await send(chatId,"No active wallet."); return; }
  await send(chatId,`Sending token #${state.tokenId} to ${shortAddr(to)}...`);
  try {
    // R-9: Resolve chain from the NFT contract address, not hardcoded defaultChain().
    const chainId=await resolveChainId(state.contract,null);
    const provider=getProvider(chainId); const signer=new ethers.Wallet(decryptKey(wallet.encKey),provider.getActive());
    const contract=new ethers.Contract(state.contract,ERC721_ABI,signer);
    const tx=await contract.transferFrom(wallet.address,to,BigInt(state.tokenId));
    await send(chatId,`Submitted. Tx: ${tx.hash}`);
    const r=await tx.wait(1);
    if (r?.status===1) await send(chatId,`Done. NFT #${state.tokenId} sent to ${shortAddr(to)}.\nTx: ${tx.hash}`);
    else await send(chatId,`May have failed. Check: ${tx.hash}`);
  } catch(err) { await send(chatId,`Transfer failed: ${shortErr(err)}`); }
}
async function startSendToken(chatId) {
  const user=getUser(chatId); if (!activeWallet(user)) { await send(chatId,"Set a wallet first."); return; }
  user.state={mode:"send_token_contract",at:Date.now()}; saveDb();
  await send(chatId,"Send Token\n\nReply with the ERC-20 token contract address.\n\nExample: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
}
async function handleSendTokenContract(chatId,text) {
  const addr=extractAddr(text); if (!addr) { await send(chatId,"Invalid contract address. Try again."); return; }
  const user=getUser(chatId); user.state={mode:"send_token_amount",tokenContract:addr,at:Date.now()}; saveDb();
  await send(chatId,`Contract: ${shortAddr(addr)}\n\nHow much to send? (e.g. 100)`);
}
async function handleSendTokenAmount(chatId,text,state) {
  const amount=parseFloat(text.trim()); if (!Number.isFinite(amount)||amount<=0) { await send(chatId,"Invalid amount. Reply with a number like 100."); return; }
  const user=getUser(chatId); user.state={mode:"send_token_to",tokenContract:state.tokenContract,amount,at:Date.now()}; saveDb();
  await send(chatId,`Amount: ${amount}\n\nDestination address:`);
}
async function handleSendTokenTo(chatId,text,state) {
  const to=extractAddr(text); if (!to) { await send(chatId,"Invalid address. Try again."); return; }
  const user=getUser(chatId); user.state={}; saveDb();
  const wallet=activeWallet(user); if (!wallet) { await send(chatId,"No active wallet."); return; }
  await send(chatId,`Sending ${state.amount} tokens to ${shortAddr(to)}...`);
  try {
    // R-9: Resolve chain from the token contract address, not hardcoded defaultChain().
    const chainId=await resolveChainId(state.tokenContract,null);
    const provider=getProvider(chainId); const signer=new ethers.Wallet(decryptKey(wallet.encKey),provider.getActive());
    const contract=new ethers.Contract(state.tokenContract,ERC20_ABI,signer);
    const decimals=await contract.decimals().catch(()=>18n);
    const raw=ethers.parseUnits(String(state.amount),Number(decimals));
    const tx=await contract.transfer(to,raw);
    await send(chatId,`Submitted. Tx: ${tx.hash}`);
    const r=await tx.wait(1);
    if (r?.status===1) await send(chatId,`Done. ${state.amount} tokens sent to ${shortAddr(to)}.\nTx: ${tx.hash}`);
    else await send(chatId,`May have failed. Check: ${tx.hash}`);
  } catch(err) { await send(chatId,`Transfer failed: ${shortErr(err)}`); }
}

// ─── TRACK ────────────────────────────────────────────────────────────────────
async function startTrack(chatId) {
  const user=getUser(chatId); user.state={mode:"track_input",at:Date.now()}; saveDb();
  await send(chatId,"Drop the OpenSea mint URL.\n\nExample: https://opensea.io/collection/azuki");
}

async function handleTrackInput(chatId,text) {
  const user=getUser(chatId);
  const draft={quantity:extractQty(text)||1,userTier:extractTier(text)};
  const os=parseOsUrl(text); const direct=extractAddr(text);
  if (!os.isOpenSea&&!direct) { logUnhandled(chatId,text); await send(chatId,"That doesn't look like an OpenSea URL.\n\nDrop the mint URL directly."); return; }
  if (os.slug) {
    try { const col=await fetchOsCollection(os.slug,os.chainId); Object.assign(draft,{mintName:col.name||os.slug,contractAddress:col.contractAddress,chainId:col.chainId,chainName:col.chainName,openSeaSlug:os.slug,metadata:col}); }
    catch { draft.mintName=os.slug; draft.openSeaSlug=os.slug; }
  }
  if (os.contractAddress||direct) { draft.contractAddress=os.contractAddress||direct; draft.chainId=os.chainId||draft.chainId||defaultChain().chainId; }
  if (!draft.contractAddress) { user.state={mode:"track_input",at:Date.now()}; saveDb(); await send(chatId,"Couldn't find a contract address in that URL. Try again."); return; }
  if (draft.userTier) { await verifyAndBuildMint(chatId,draft); return; }
  user.state={mode:"awaiting_stage",draft,at:Date.now()}; saveDb();
  await send(chatId,"Which phase are you eligible for?",{reply_markup:{inline_keyboard:[
    [{text:"GTD",callback_data:"stage:gtd"},{text:"OG",callback_data:"stage:og"}],
    [{text:"WL",callback_data:"stage:wl"},{text:"Public",callback_data:"stage:public"}]
  ]}});
}

async function verifyAndBuildMint(chatId,draft) {
  const user=getUser(chatId);
  try {
    const verified=await verifyFromContract(draft);
    const mint=buildMintRecord(verified,draft);
    if (!mint.mintTime) { user.state={mode:"track_input",at:Date.now()}; saveDb(); await send(chatId,"Couldn't find the phase open time from the contract. Drop the URL again."); return; }
    mint._estCap=await estGasCap(mint).catch(()=>null);
    user.pendingMint=mint; user.state={}; saveDb();
    await send(chatId,mintCard(chatId,mint),{reply_markup:mintKeyboard(mint)});
  } catch(err) {
    user.state={mode:"track_input",at:Date.now()}; saveDb();
    await send(chatId,`Couldn't process that drop: ${shortErr(err)}\n\nTry again or paste the contract address directly.`);
  }
}

// ─── MINT CARD ────────────────────────────────────────────────────────────────
function mintCard(chatId,mint) {
  const user=getUser(chatId); const wallet=activeWallet(user);
  const pending=user.pendingFee||{};
  const pendingTotal=Object.values(pending).reduce((s,f)=>s+parseFloat(f.feeEth||0),0);
  return [
    `${mint.mintName}`,
    `${mint.userTier.toUpperCase()} — ${formatDt(mint.mintTime)}  (${formatDur(mint.mintTime-Date.now())})`,
    "",
    "Phase times:",
    mint.gtdTime    ?`GTD     ${formatDt(mint.gtdTime)}`:null,
    mint.ogTime     ?`OG      ${formatDt(mint.ogTime)}`:null,
    mint.wlTime     ?`WL      ${formatDt(mint.wlTime)}`:null,
    mint.publicTime ?`Public  ${formatDt(mint.publicTime)}`:null,
    "",
    `Chain     ${mint.chainName}`,
    `Contract  ${mint.contractAddress||"—"}`,
    `Price     ${mint.priceEth||"—"} ETH`,
    `Qty       ${mint.quantity}`,
    `Wallet    ${wallet?shortAddr(wallet.address):"none — set a wallet first"}`,
    "",
    `Gas cap   ${mint._userGasCap?mint._userGasCap+" ETH":mint._estCap?mint._estCap+" ETH (est)":"not set"}`,
    `Gas War   ${mint.gasWarMode?"ON — escalates each retry":"off — 10% baseline"}`,
    `Flashbots ${mint.flashbotsEnabled?"ON — private mempool":"off"}`,
    `Auto-mint ${mint.autoMintEnabled?"ON":"off"}`,
    `Reminders ${mint.remindersEnabled?"on":"off"}`,
    mint.targetListPrice?`Target    ${mint.targetListPrice} ETH`:null,
    "",
    pendingTotal>0?`⚠️  Pending fee: ${pendingTotal.toFixed(6)} ETH bundled into this mint.`:null,
    "Fee: 5% of profit only. Zero on losses.",
  ].filter(l=>l!==null&&l!==undefined).join("\n");
}

function mintKeyboard(mint) {
  return {inline_keyboard:[
    [{text:"✅ Confirm",callback_data:`confirm:${mint.id}`},{text:"❌ Cancel",callback_data:`cancel_pending:${mint.id}`}],
    [{text:`🔔 Reminders ${mint.remindersEnabled?"✓":""}`,callback_data:`toggle:reminders:${mint.id}`},{text:`🤖 Auto-mint ${mint.autoMintEnabled?"✓":""}`,callback_data:`toggle:auto:${mint.id}`}],
    [{text:`⚔️ Gas War ${mint.gasWarMode?"ON":"off"}`,callback_data:`toggle:gaswar:${mint.id}`},{text:`🔒 Flashbots ${mint.flashbotsEnabled?"ON":"off"}`,callback_data:`toggle:flashbots:${mint.id}`}],
    [{text:"⛽ Set Gas Cap",callback_data:`set_gas_cap:${mint.id}`},{text:"🎯 Target List Price",callback_data:`set_target_list:${mint.id}`}],
    [{text:"🔔 Profit Alert Level",callback_data:`set_profit_alert:${mint.id}`}]
  ]};
}

// ─── CONFIRM ─────────────────────────────────────────────────────────────────
async function confirmMint(chatId,mintId) {
  const user=getUser(chatId); const mint=user.pendingMint;
  if (!mint||mint.id!==mintId) { await send(chatId,"This mint setup expired. Start a new one."); return; }
  // Auto-accept the gas estimate — user can override via "Set Gas Cap" button if they want
  if (!mint._userGasCap&&mint._estCap) mint._userGasCap=mint._estCap;
  await finalizeConfirm(chatId,mint);
}

async function handleGasCap(chatId,text,state) {
  const user=getUser(chatId);
  const target=state.ctx==="confirm"?user.pendingMint:(user.mints||[]).find(m=>m.id===state.mintId);
  if (!target) { user.state={}; saveDb(); await send(chatId,"Mint not found. Start a new one."); return; }
  if (text.trim().toLowerCase()==="ok") { target._userGasCap=target._estCap; }
  else { const v=parseFloat(text.trim()); if (!Number.isFinite(v)||v<=0) { await send(chatId,'Invalid. Reply with a number like 0.005, or "ok" to accept.'); return; } target._userGasCap=String(v); }
  user.state={}; saveDb();
  if (state.ctx==="confirm") await finalizeConfirm(chatId,target);
  else await send(chatId,`Gas cap updated to ${target._userGasCap} ETH.`);
}

async function finalizeConfirm(chatId,mint) {
  const user=getUser(chatId);
  mint.confirmed=true; mint.confirmedAt=Date.now(); mint.updatedAt=Date.now();
  user.mints=user.mints||[]; user.mints.push(mint);
  user.pendingMint=null; user.state={};
  lbAdd(chatId,"totalMints",1); saveDb(); // F-6: was 0 — counter never incremented
  await send(chatId,[
    `Locked in: ${mint.mintName}`,
    "",
    `${mint.userTier.toUpperCase()} opens: ${formatDt(mint.mintTime)}`,
    `That's ${formatDur(mint.mintTime-Date.now())} from now.`,
    "",
    mint.autoMintEnabled?`Auto-mint ON — fires ${AUTO_MINT_DELAY_MS/1000}s after open.`:"Auto-mint OFF — you'll get the open alert.",
    "",
    `Reminders: ${mint.remindersEnabled?REMINDERS.map(r=>r.label).join(" · "):"off"}`
  ].join("\n"),KEYBOARD);
  scheduleMint(chatId,mint);
  startMempoolWatcher(chatId,mint);
}

async function handleTargetList(chatId,text,state) {
  const v=parseFloat(text.trim()); if (!Number.isFinite(v)||v<=0) { await send(chatId,"Invalid. Reply with a number like 0.5."); return; }
  const user=getUser(chatId); const mint=user.pendingMint||(user.mints||[]).find(m=>m.id===state.mintId);
  if (!mint) { user.state={}; saveDb(); await send(chatId,"Mint not found."); return; }
  mint.targetListPrice=String(v); user.state={}; saveDb();
  await send(chatId,`Target set: ${v} ETH. Alert fires when the floor hits it.`);
}

async function handleProfitAlert(chatId,text,state) {
  // R-11: Use Number() not parseInt() — parseInt("2.9") returns 2, silently truncating.
  const v=Number(text.trim()); if (!Number.isInteger(v)||v<2) { await send(chatId,"Enter a whole number 2 or higher. Example: 3 = start alerts at 3x."); return; }
  const user=getUser(chatId); const mint=user.pendingMint||(user.mints||[]).find(m=>m.id===state.mintId);
  if (!mint) { user.state={}; saveDb(); await send(chatId,"Mint not found."); return; }
  mint.profitAlertStart=v; user.state={}; saveDb();
  await send(chatId,`First profit alert at ${v}x. Every new multiple after that too.`);
}

async function handleListPrice(chatId,text,state) {
  const price=parseFloat(text.trim()); if (!Number.isFinite(price)||price<=0) { await send(chatId,"Invalid. Reply with a number like 0.3."); return; }
  const user=getUser(chatId); const mint=(user.mints||[]).find(m=>m.id===state.mintId);
  user.state={}; saveDb(); if (!mint) { await send(chatId,"Mint not found."); return; }
  await doListing(chatId,mint,price);
}

// ─── INSTANT MINT ─────────────────────────────────────────────────────────────
async function promptInstantMint(chatId) {
  const user=getUser(chatId);
  if (!activeWallet(user)) { await send(chatId,"No wallet set.",{reply_markup:{inline_keyboard:[[{text:"Create Wallet",callback_data:"wallet:create"}]]}}); return; }
  user.state={mode:"instant_url",at:Date.now()}; saveDb();
  await send(chatId,"⚡ Instant Mint\n\nPaste the contract address or OpenSea URL.\nNo confirmation. No delays. Fires immediately.");
}

async function doInstantMintFromUrl(chatId,text) {
  const user=getUser(chatId); const wallet=activeWallet(user);
  if (!wallet) { await send(chatId,"No active wallet."); return; }
  user.state={}; saveDb();
  const os=parseOsUrl(text); let contract=os.contractAddress||extractAddr(text); let chainId=os.chainId||defaultChain().chainId;
  if (!contract&&os.slug) {
    try { const col=await fetchOsCollection(os.slug); contract=col.contractAddress; chainId=col.chainId||chainId; }
    catch { await send(chatId,"Couldn't resolve the contract."); return; }
  }
  if (!contract) { await send(chatId,"No contract address found."); return; }
  await send(chatId,`Firing on ${shortAddr(contract)}...`);
  try {
    const provider=getProvider(chainId); const signer=new ethers.Wallet(decryptKey(wallet.encKey),provider.getActive());
    const abi=await resolveAbi({contractAddress:contract,chainId}); const iface=new ethers.Interface(abi);
    const c=new ethers.Contract(contract,abi,signer);
    const cand=pickMintFn(iface,{quantity:1,mintFunction:null,mintArgs:null,merkleProof:null},signer.address);
    if (!cand) { await send(chatId,"Couldn't find a mint function on that contract."); return; }
    const feeData=await provider.getFeeData(); const gas=buildGas(feeData,false,0);
    // F-2: Resolve actual mint price — hardcoded 0n caused paid mints to always revert.
    const readContract=new ethers.Contract(contract,mergeAbi(abi,READ_ONLY_ABI),provider.getActive());
    const priceStr=await readPrice(readContract,"public");
    const value=priceStr?ethers.parseEther(priceStr):0n;
    const gasLimit=await resolveGasLimit(c,cand,value);
    const tx=await c[cand.functionKey](...cand.args,{...gas,gasLimit,value});
    const r=await tx.wait(1);
    if (r?.status===1) await send(chatId,`✅ Minted.\nTx: ${tx.hash}`);
    else await send(chatId,`May have failed. Check: ${tx.hash}`);
  } catch(err) { await send(chatId,`Instant mint failed: ${shortErr(err)}`); }
}

async function doInstantMint(chatId,mint) {
  const user=getUser(chatId); const wallet=activeWallet(user);
  if (!wallet) { await send(chatId,"No active wallet."); return; }
  await send(chatId,`Firing on ${mint.mintName}...`);
  try { const result=await runAutoMint(chatId,user,mint,wallet); await send(chatId,`Confirmed.\nTx: ${result.hash}`); }
  catch(err) { await send(chatId,`Failed: ${shortErr(err)}`); }
}

// ─── BLAST ────────────────────────────────────────────────────────────────────
async function sendBlastMenu(chatId) {
  const user=getUser(chatId); const wallets=user.wallets||[];
  if (wallets.length<2) {
    await send(chatId,"💣 Blast fires the same mint from every wallet simultaneously.\n\nYou only have one wallet. Add more, then blast.",
      {reply_markup:{inline_keyboard:[[{text:"Add Wallet",callback_data:"wallet:import"}]]}}); return;
  }
  const active=(user.mints||[]).filter(m=>m.confirmed&&!m.completedAt);
  if (!active.length) { user.state={mode:"blast_url",at:Date.now()}; saveDb(); await send(chatId,`💣 Blast — ${wallets.length} wallets ready.\n\nPaste the contract address or OpenSea URL.`); return; }
  const buttons=active.map(m=>[{text:`Blast: ${m.mintName}`,callback_data:`blast:confirm:${m.id}`}]);
  buttons.push([{text:"New URL",callback_data:"blast:menu"}]);
  await send(chatId,`💣 Blast — ${wallets.length} wallets\n\nSelect a tracked mint to blast, or paste a new URL.`,{reply_markup:{inline_keyboard:buttons}});
}

async function handleBlastUrl(chatId,text) {
  const user=getUser(chatId); const os=parseOsUrl(text);
  let contract=os.contractAddress||extractAddr(text); let chainId=os.chainId||defaultChain().chainId;
  user.state={};
  if (!contract&&os.slug) { try { const col=await fetchOsCollection(os.slug); contract=col.contractAddress; chainId=col.chainId||chainId; } catch { await send(chatId,"Couldn't resolve. Paste a contract address directly."); return; } }
  if (!contract) { await send(chatId,"No contract found."); return; }
  // R-8: Resolve the actual mint price so blast doesn't fire with value:0n on paid contracts.
  let priceEth=null;
  try {
    const provider=getProvider(chainId);
    const readContract=new ethers.Contract(contract,READ_ONLY_ABI,provider.getActive());
    priceEth=await readPrice(readContract,"public");
  } catch {}
  // Fire immediately — no second confirmation
  const fakeMint=buildMintRecord({contractAddress:contract,chainId,chainName:defaultChain().chainName,userTier:"public",mintTime:Date.now(),priceEth},{quantity:1});
  user.blastPending=fakeMint; saveDb();
  await executeBlast(chatId,fakeMint.id);
}

async function executeBlast(chatId,mintId) {
  const user=getUser(chatId); const wallets=user.wallets||[];
  if (!wallets.length) { await send(chatId,"No wallets to blast from."); return; }
  const mint=(user.mints||[]).find(m=>m.id===mintId)||user.blastPending;
  if (!mint) { await send(chatId,"Blast mint not found."); return; }
  await send(chatId,`💣 Blasting from ${wallets.length} wallets...`);
  const results=await Promise.allSettled(wallets.map(w=>runAutoMint(chatId,user,mint,w)));
  const ok=results.filter(r=>r.status==="fulfilled"); const fail=results.filter(r=>r.status==="rejected");
  const lines=[`💣 Blast complete.`,``,`Confirmed: ${ok.length}/${wallets.length}`,...ok.map((r,i)=>`Wallet ${i+1}: ${r.value?.hash||"ok"}`)];
  if (fail.length) { lines.push(``,`Failed: ${fail.length}`); fail.forEach((r,i)=>lines.push(`Wallet ${ok.length+i+1}: ${shortErr(r.reason)}`)); }
  await send(chatId,lines.join("\n"));
  user.blastPending=null; saveDb();
}

// ─── SCHEDULING / POLL ───────────────────────────────────────────────────────
function scheduleMint(chatId,mint) {
  if (!mint?.confirmed||!mint.autoMintEnabled||!mint.mintTime||!mint.contractAddress||mint.autoMint?.success) return;
  const key=`${chatId}:${mint.id}`; if (mintTimers.has(key)) return;
  const delay=Math.max(1000,Number(mint.mintTime)+AUTO_MINT_DELAY_MS-Date.now());
  const t=setTimeout(async()=>{mintTimers.delete(key); await tryAutoMint(chatId,mint.id,"timer");},delay);
  mintTimers.set(key,t); mint.autoMint=mint.autoMint||{}; mint.autoMint.scheduled=true; saveDb();
}
function clearMintTimer(chatId,mintId) { const k=`${chatId}:${mintId}`; const t=mintTimers.get(k); if(t) clearTimeout(t); mintTimers.delete(k); }

function armAll() {
  for (const [chatId,user] of Object.entries(db.users||{})) {
    for (const mint of user.mints||[]) {
      if (!mint.confirmed) continue;
      if (mint.completedAt) continue; // R-5: don't arm timers for completed mints on restart
      scheduleMint(chatId,mint);
      if (!mint.autoMint?.success&&mint.mintTime&&Date.now()<Number(mint.mintTime)+RETRY_WINDOW_MS) startMempoolWatcher(chatId,mint);
      if (mint._watcherState) startTopOfferWatcher(chatId,mint);
      if (mint._mintedTokenIds?.length&&!mint._saleClosed) startSaleWatcher(chatId,mint);
    }
  }
}

async function pollLoop() {
  const now=Date.now();
  for (const [chatId,user] of Object.entries(db.users||{})) {
    for (const mint of user.mints||[]) {
      if (!mint.confirmed||!mint.mintTime) continue;
      if (mint.completedAt) continue; // R-4: skip completed mints — was iterating them every tick
      if (mint.remindersEnabled) {
        for (const r of REMINDERS) {
          const due=mint.mintTime-r.seconds*1000;
          if (now>=due&&now<mint.mintTime+3600000&&!mint.firedReminders.includes(r.key)) {
            mint.firedReminders.push(r.key); mint.updatedAt=now; saveDb();
            await send(chatId,`⏰ ${r.label} — ${mint.mintName} ${mint.userTier.toUpperCase()} opens at ${formatDt(mint.mintTime)}.`);
          }
        }
      }
      if (now>=mint.mintTime&&!mint.openAlertSent) {
        mint.openAlertSent=true; mint.updatedAt=now; saveDb();
        await send(chatId,`🔓 OPEN — ${mint.mintName} (${mint.userTier.toUpperCase()})\n\n${mint.autoMintEnabled?"Auto-mint firing now.":"Mint manually now."}`);
      }
      if (mint.autoMintEnabled) await tryAutoMint(chatId,mint.id,"poll");
    }
  }
}

async function tryAutoMint(chatId,mintId,source) {
  const user=getUser(chatId); const mint=(user.mints||[]).find(m=>m.id===mintId);
  if (!mint?.confirmed||!mint.autoMintEnabled) return;
  const am=mint.autoMint||{}; mint.autoMint=am;
  if (am.success||am.inFlight) return;
  if (source!=="mempool"&&Date.now()<mint.mintTime+AUTO_MINT_DELAY_MS) return;
  if (Date.now()>mint.mintTime+RETRY_WINDOW_MS) return;
  if ((am.attempts||0)>=MAX_ATTEMPTS) return;
  const wallet=activeWallet(user); if (!wallet||!mint.contractAddress) return;
  am.inFlight=true; am.attempts=(am.attempts||0)+1; am.lastAt=Date.now(); am.lastSource=source; saveDb();
  try {
    const result=await runAutoMint(chatId,user,mint,wallet);
    am.success=true; am.inFlight=false; am.txHash=result.hash; am.doneAt=Date.now(); mint.completedAt=Date.now();
    stopMempoolWatcher(mint.id);
    user.mintHistory=user.mintHistory||[];
    user.mintHistory.unshift({mintId:mint.id,mintName:mint.mintName,userTier:mint.userTier,txHash:result.hash,status:"confirmed",timestamp:Date.now(),priceEth:mint.priceEth});
    lbAdd(chatId,"totalEthSpent",parseFloat(mint.priceEth||0)*(mint.quantity||1));
    saveDb();
    await send(chatId,[
      `✅ MINTED — ${mint.mintName}`,``,
      `Phase: ${mint.userTier.toUpperCase()}`,
      `Price: ${mint.priceEth||"?"} ETH × ${mint.quantity}`,
      `Tx: ${result.hash}`
    ].join("\n"));
    await postMintActions(chatId,mint,result);
  } catch(err) {
    am.inFlight=false; am.lastError=shortErr(err); mint.updatedAt=Date.now();
    const reason=classifyRevert(err);
    if (reason==="sold_out") { mint.completedAt=Date.now(); saveDb(); await send(chatId,`Sold out — ${mint.mintName}.\n\nWatch secondaries.`); return; }
    if (reason==="per_wallet"||reason==="wrong_phase") { saveDb(); return; }
    saveDb();
    const left=MAX_ATTEMPTS-am.attempts; const done=left<=0||Date.now()>mint.mintTime+RETRY_WINDOW_MS;
    await send(chatId,done?`Auto-mint stopped — ${mint.mintName}.\n\nReason: ${shortErr(err)}\n\nMint manually if you still want in.`:`Attempt ${am.attempts} failed — ${mint.mintName}.\n${shortErr(err)}\n\n${left} retries left.`);
  }
}

function classifyRevert(err) {
  const msg=(err?.message||String(err)).toLowerCase();
  if (REVERT_SOLD_OUT.some(k=>msg.includes(k)))    return "sold_out";
  if (REVERT_PER_WALLET.some(k=>msg.includes(k)))  return "per_wallet";
  if (REVERT_WRONG_PHASE.some(k=>msg.includes(k))) return "wrong_phase";
  return "unknown";
}

// ─── EXECUTE MINT ─────────────────────────────────────────────────────────────
async function runAutoMint(chatId,user,mint,walletRecord) {
  if (!mint.contractAddress) throw new Error("No contract address.");
  if (!walletRecord.encKey)  throw new Error("Wallet has no key.");
  const provider=getProvider(mint.chainId); const key=decryptKey(walletRecord.encKey);
  const rpcUrl=mint.flashbotsEnabled?(CHAIN[mint.chainId===1?"ethereum":"base"]?.flashbotsRpc||null):null;
  const sigProv=rpcUrl?new ethers.JsonRpcProvider(rpcUrl,mint.chainId):provider.getActive();
  const signer=new ethers.Wallet(key,sigProv);
  const abi=await resolveAbi(mint); const contract=new ethers.Contract(mint.contractAddress,abi,signer);
  const cand=pickMintFn(contract.interface,mint,signer.address);
  if (!cand) throw new Error("No mint function found. Contract may use a custom ABI.");
  const value=mintValue(mint); const feeData=await provider.getFeeData();
  const attempt=mint.autoMint?.attempts||0; const useWar=mint.gasWarMode||user.gasWarMode;
  const gas=buildGas(feeData,useWar,attempt);
  // R-3: Compute gas limit once and reuse — was calling resolveGasLimit twice,
  // wasting an RPC round-trip and allowing the cap check and actual limit to diverge.
  const gasLimit=await resolveGasLimit(contract,cand,value);
  if (mint._userGasCap) {
    const capWei=ethers.parseEther(String(mint._userGasCap));
    const cost=gasLimit*(gas.maxFeePerGas||gas.gasPrice||0n);
    if (cost>capWei) throw new Error(`Gas cap hit. Estimated: ${ethers.formatEther(cost)} ETH, cap: ${mint._userGasCap} ETH.`);
  }
  const balance=await provider.getBalance(signer.address);
  const maxCost=gasLimit*(gas.maxFeePerGas||gas.gasPrice||0n);
  // F-4: Estimate pending fee for balance check but don't send it until mint confirms.
  const pendingFeeWei=estimatePendingFee(user);
  const totalValue=value+pendingFeeWei;
  if (balance<totalValue+maxCost) throw new Error(`Not enough ETH. Need ~${ethers.formatEther(totalValue+maxCost)}, have ${ethers.formatEther(balance)}.`);
  const tx=await contract[cand.functionKey](...cand.args,{...gas,gasLimit,value});
  const receipt=await tx.wait(1);
  if (!receipt||receipt.status!==1) throw new Error(`Reverted: ${tx.hash}`);
  // F-4: Only collect the pending fee after the mint is confirmed on-chain.
  await collectPendingFee(chatId,user,value,signer,mint.chainId);
  return {hash:tx.hash,receipt};
}

function buildGas(feeData,warMode,attempt) {
  const step=warMode?(100n+GAS_WAR_STEP*BigInt(attempt)):100n;
  const boost=(BASE_GAS_BOOST*step)/100n;
  if (feeData.maxFeePerGas&&feeData.maxPriorityFeePerGas) return {maxFeePerGas:(BigInt(feeData.maxFeePerGas)*boost)/100n,maxPriorityFeePerGas:(BigInt(feeData.maxPriorityFeePerGas)*boost)/100n};
  if (feeData.gasPrice) return {gasPrice:(BigInt(feeData.gasPrice)*boost)/100n};
  return {};
}

// ─── POST-MINT / RARITY ───────────────────────────────────────────────────────
async function postMintActions(chatId,mint,result) {
  const tokenId=extractTokenId(result.receipt);
  if (tokenId!==null) {
    mint._lastMintedTokenId=String(tokenId); mint._mintedTokenIds=mint._mintedTokenIds||[];
    if (!mint._mintedTokenIds.includes(String(tokenId))) mint._mintedTokenIds.push(String(tokenId));
    saveDb(); await sendRarityAlert(chatId,mint,String(tokenId));
  }
  startTopOfferWatcher(chatId,mint); startSaleWatcher(chatId,mint);
}

function extractTokenId(receipt) {
  if (!receipt?.logs) return null;
  const TRANSFER="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  for (const log of receipt.logs) {
    if (log.topics?.[0]===TRANSFER&&log.topics.length===4) { try { return BigInt(log.topics[3]).toString(); } catch {} }
  }
  return null;
}

async function sendRarityAlert(chatId,mint,tokenId) {
  let rarity=null; try { rarity=await fetchRarity(mint.contractAddress,tokenId,mint.chainId); } catch {}
  const isRare=rarity?.rank&&rarity?.totalSupply?rarity.rank<=rarity.totalSupply*0.1:null;
  const lines=[
    `${mint.mintName} #${tokenId}`,"",
    rarity?.rank?`Rank: #${rarity.rank}`+(rarity.totalSupply?` of ${rarity.totalSupply}`:""):null,
    rarity?.score?`Score: ${rarity.score}`:null,"",
    isRare===true?"🔥 RARE. Hold.":null,
    isRare===false?"Common. Consider listing.":null,
    isRare===null?"Rarity data loading — check back.":null
  ].filter(l=>l!==null);
  // Top offer watcher starts automatically — no button needed
  await send(chatId,lines.join("\n"),{reply_markup:{inline_keyboard:[
    [{text:"📤 List for Sale",callback_data:`list_for_sale:${mint.id}`}]
  ]}});
}

async function fetchRarity(contractAddress,tokenId,chainId) {
  if (!process.env.OPENSEA_API_KEY) return null;
  try {
    const chain=chainId===8453?"base":"ethereum";
    const data=await fetchJson(`https://api.opensea.io/api/v2/chain/${chain}/contract/${contractAddress}/nfts/${tokenId}`,osHeaders());
    const nft=data.nft||data;
    return {rank:nft.rarity_rank||null,score:nft.rarity_score||null,totalSupply:null};
  } catch { return null; }
}

async function showRarity(chatId,mint,tokenId) {
  const r=await fetchRarity(mint.contractAddress,tokenId,mint.chainId);
  if (!r) { await send(chatId,"Rarity data not available for this collection yet."); return; }
  const lines=[`${mint.mintName} #${tokenId}`,""]; if(r.rank) lines.push(`Rank: #${r.rank}`); if(r.score) lines.push(`Score: ${r.score}`);
  await send(chatId,lines.join("\n"));
}

// ─── TOP OFFER WATCHER ───────────────────────────────────────────────────────
function startTopOfferWatcher(chatId,mint) {
  if (!mint.openSeaSlug&&!mint.contractAddress) return;
  const key=`${chatId}:${mint.id}`; if (topOfferWatchers.has(key)) return;
  if (!mint._watcherState) { mint._watcherState={fired:[],fired50:false,fired75:false}; saveDb(); }
  topOfferWatchers.set(key,true);
}
function stopTopOfferWatcher(chatId,mintId) { topOfferWatchers.delete(`${chatId}:${mintId}`); }

async function checkTopOffers() {
  for (const [key] of topOfferWatchers) {
    const [chatId,mintId]=key.split(":");
    const user=getUser(chatId); const mint=(user.mints||[]).find(m=>m.id===mintId);
    if (!mint||mint.completedAt) { topOfferWatchers.delete(key); continue; }
    try { await checkOneTopOffer(chatId,mint); } catch {}
  }
}

async function checkOneTopOffer(chatId,mint) {
  if (!process.env.OPENSEA_API_KEY||!mint.openSeaSlug) return;
  const stats=await fetchJson(`https://api.opensea.io/api/v2/collections/${encodeURIComponent(mint.openSeaSlug)}/stats`,osHeaders()).catch(()=>null);
  if (!stats) return;
  const floor=parseFloat(stats.total?.floor_price||stats.floor_price||0);
  const topOffer=parseFloat(stats.total?.top_bid||stats.top_bid||0);
  const mintPrice=parseFloat(mint.priceEth||0);
  if (!mintPrice||!topOffer) return;
  const state=mint._watcherState||{fired:[],fired50:false,fired75:false}; mint._watcherState=state;
  const startAt=mint.profitAlertStart||2;
  const multiple=Math.floor(topOffer/mintPrice);
  for (let m=startAt;m<=multiple;m++) {
    if (!state.fired.includes(m)) {
      state.fired.push(m);
      const profit=topOffer-mintPrice; const profitPct=((profit/mintPrice)*100).toFixed(1);
      const osLink=mint.contractAddress?`https://opensea.io/assets/${mint.chainId===8453?"base":"ethereum"}/${mint.contractAddress}/${mint._lastMintedTokenId||""}`:null;
      await send(chatId,[`🚀 ${m}x — ${mint.mintName}`,``,`Top offer: ${topOffer} ETH`,`Floor: ${floor} ETH`,`Mint price: ${mintPrice} ETH`,`Profit: +${profit.toFixed(4)} ETH (+${profitPct}%)`,osLink?`\nAccept on OpenSea: ${osLink}`:``].filter(l=>l!=="").join("\n"),
        {reply_markup:{inline_keyboard:[
          [{text:"📤 List for Sale",callback_data:`list_for_sale:${mint.id}`}],
          [{text:"🛑 Stop Watching",callback_data:`stop_watching:${mint.id}`}]
        ]}});
    }
  }
  if (topOffer<mintPrice) {
    const lossPct=((mintPrice-topOffer)/mintPrice)*100;
    const lossMsg=(pct)=>[`📉 -${pct}% — ${mint.mintName}`,``,`Top offer: ${topOffer} ETH`,`Mint price: ${mintPrice} ETH`,`Loss: -${(mintPrice-topOffer).toFixed(4)} ETH`].join("\n");
    const lossKb={reply_markup:{inline_keyboard:[[{text:"📤 List for Sale",callback_data:`list_for_sale:${mint.id}`}],[{text:"🛑 Stop Watching",callback_data:`stop_watching:${mint.id}`}]]}};
    if (lossPct>=75&&!state.fired75) { state.fired75=true; await send(chatId,lossMsg(75),lossKb); }
    else if (lossPct>=50&&!state.fired50) { state.fired50=true; await send(chatId,lossMsg(50),lossKb); }
  }
  if (mint.targetListPrice&&floor>=parseFloat(mint.targetListPrice)&&!state.targetFired) {
    state.targetFired=true;
    await send(chatId,[`🎯 Floor hit your target — ${mint.mintName}`,``,`Floor: ${floor} ETH`,`Target: ${mint.targetListPrice} ETH`].join("\n"),
      {reply_markup:{inline_keyboard:[[{text:"📤 List at Target",callback_data:`list_for_sale:${mint.id}`}]]}});
  }
  saveDb();
}

// ─── SALE WATCHER ────────────────────────────────────────────────────────────
function startSaleWatcher(chatId,mint) { if (!mint.contractAddress) return; const key=`${chatId}:${mint.id}`; if (!saleWatchers.has(key)) saleWatchers.set(key,true); }
function stopSaleWatcher(chatId,mintId) { saleWatchers.delete(`${chatId}:${mintId}`); }

async function checkSales() {
  for (const [key] of saleWatchers) {
    const [chatId,mintId]=key.split(":");
    const user=getUser(chatId); const mint=(user.mints||[]).find(m=>m.id===mintId);
    if (!mint||mint._saleClosed) { saleWatchers.delete(key); continue; }
    try { await checkOneSale(chatId,mint,user); } catch {}
  }
}

async function checkOneSale(chatId,mint,user) {
  const wallet=activeWallet(user); if (!wallet) return;
  const tokenIds=mint._mintedTokenIds||(mint._lastMintedTokenId?[mint._lastMintedTokenId]:[]);
  if (!tokenIds.length) return;
  for (const tokenId of tokenIds) {
    const saleKey=`_saleFired_${tokenId}`; if (mint[saleKey]) continue;
    const sold=await detectSaleOpenSea(mint,tokenId,wallet.address)||await detectSaleOnChain(mint,tokenId,wallet.address);
    if (!sold) continue;
    mint[saleKey]=true; saveDb();
    if (sold.salePriceEth>0) await collectProfitFee(chatId,mint,sold.salePriceEth);
  }
  const allDone=tokenIds.every(id=>mint[`_saleFired_${id}`]);
  if (allDone&&tokenIds.length) { mint._saleClosed=true; stopSaleWatcher(chatId,mint.id); stopTopOfferWatcher(chatId,mint.id); saveDb(); }
}

async function detectSaleOpenSea(mint,tokenId,ownerAddress) {
  if (!process.env.OPENSEA_API_KEY) return null;
  try {
    const chain=mint.chainId===8453?"base":"ethereum";
    const data=await fetchJson(`https://api.opensea.io/api/v2/events/chain/${chain}/contract/${mint.contractAddress}/nfts/${tokenId}?event_type=sale&limit=5`,osHeaders());
    for (const ev of (data.asset_events||data.events||[])) {
      const t=ev.event_timestamp||ev.created_date;
      if (t&&new Date(t).getTime()<(mint.confirmedAt||0)) continue;
      const seller=(ev.seller||ev.from_address||"").toLowerCase();
      if (seller!==ownerAddress.toLowerCase()) continue;
      const wei=ev.payment?.quantity||ev.total_price; if (!wei) continue;
      const price=parseFloat(ethers.formatEther(BigInt(wei)));
      if (price>0) return {salePriceEth:price};
    }
    return null;
  } catch { return null; }
}

async function detectSaleOnChain(mint,tokenId,ownerAddress) {
  try {
    const provider=getProvider(mint.chainId); const c=new ethers.Contract(mint.contractAddress,ERC721_ABI,provider.getActive());
    const block=await provider.getBlock("latest"); const from=Math.max(0,(block?.number||0)-5000);
    const logs=await c.queryFilter(c.filters.Transfer(ownerAddress,null,BigInt(tokenId)),from);
    if (!logs.length) return null;
    const log=logs[logs.length-1]; const to=log.args?.to||"";
    if (to.toLowerCase()===ownerAddress.toLowerCase()||to===ethers.ZeroAddress) return null;
    const tx=await provider.getActive().getTransaction(log.transactionHash);
    return {salePriceEth:tx?.value?parseFloat(ethers.formatEther(tx.value)):0};
  } catch { return null; }
}

// ─── LISTING ─────────────────────────────────────────────────────────────────
async function doListing(chatId,mint,priceEth) {
  if (!process.env.OPENSEA_API_KEY) { await send(chatId,"OpenSea listing needs OPENSEA_API_KEY in .env."); return; }
  const user=getUser(chatId); const wallet=activeWallet(user);
  if (!wallet) { await send(chatId,"No active wallet."); return; }
  if (!mint.contractAddress) { await send(chatId,"No contract address on this mint."); return; }
  const chain=mint.chainId===8453?"base":"ethereum";
  const priceWei=ethers.parseEther(String(priceEth));
  // U-3: Send "Listing..." only after initial validation passes, not before async work,
  // so users don't see "Listing at X ETH..." followed immediately by a validation error.
  try {
    const provider=getProvider(mint.chainId);
    const signer=new ethers.Wallet(decryptKey(wallet.encKey),provider.getActive());
    let tokenId=mint._lastMintedTokenId||await fetchFirstToken(signer.address,mint.contractAddress,mint.chainId);
    if (!tokenId) { await send(chatId,`No token found for ${mint.mintName} in this wallet.`); return; }
    await send(chatId,`Listing ${mint.mintName} at ${priceEth} ETH...`);
    const expiry=Math.floor(Date.now()/1000)+60*60*24*30;
    // F-7: Fetch the offerer's current Seaport counter on-chain.
    // Hardcoded "0" causes signature mismatch for users who have cancelled orders before.
    const seaportAddress="0x0000000000000068f116a894984e2db1123eb395";
    const seaportContract=new ethers.Contract(seaportAddress,["function getCounter(address offerer) view returns (uint256)"],provider.getActive());
    const counter=(await seaportContract.getCounter(signer.address)).toString();
    // F-8: Fetch creator royalties from OpenSea and include them in consideration.
    // Without royalty items, OpenSea marks the listing as royalty-bypassing.
    let royaltyConsideration=[];
    try {
      const royaltyData=await fetchJson(`https://api.opensea.io/api/v2/chain/${chain}/contract/${mint.contractAddress}/fee`,osHeaders());
      const fees=royaltyData.fees||royaltyData.seller_fees||[];
      for (const fee of fees) {
        if (!fee.recipient||!fee.basis_points) continue;
        const royaltyWei=priceWei*BigInt(fee.basis_points)/10000n;
        if (royaltyWei>0n) royaltyConsideration.push({itemType:0,token:ethers.ZeroAddress,identifierOrCriteria:"0",startAmount:royaltyWei.toString(),endAmount:royaltyWei.toString(),recipient:fee.recipient});
      }
    } catch {}
    // Reduce seller amount by royalties so total ETH adds up correctly.
    const royaltyTotal=royaltyConsideration.reduce((s,r)=>s+BigInt(r.startAmount),0n);
    const sellerAmount=(priceWei-royaltyTotal>0n?priceWei-royaltyTotal:priceWei).toString();
    const consideration=[
      {itemType:0,token:ethers.ZeroAddress,identifierOrCriteria:"0",startAmount:sellerAmount,endAmount:sellerAmount,recipient:signer.address},
      ...royaltyConsideration
    ];
    const orderParams={
      offerer:signer.address, zone:ethers.ZeroAddress,
      offer:[{itemType:2,token:mint.contractAddress,identifierOrCriteria:tokenId,startAmount:"1",endAmount:"1"}],
      consideration,
      orderType:0, startTime:Math.floor(Date.now()/1000).toString(), endTime:expiry.toString(),
      zoneHash:"0x0000000000000000000000000000000000000000000000000000000000000000",
      salt:ethers.hexlify(ethers.randomBytes(16)),
      conduitKey:"0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
      counter
    };
    const domain={name:"Seaport",version:"1.6",chainId:mint.chainId,verifyingContract:"0x0000000000000068f116a894984e2db1123eb395"};
    const types={
      OrderComponents:[
        {name:"offerer",type:"address"},{name:"zone",type:"address"},
        {name:"offer",type:"OfferItem[]"},{name:"consideration",type:"ConsiderationItem[]"},
        {name:"orderType",type:"uint8"},{name:"startTime",type:"uint256"},
        {name:"endTime",type:"uint256"},{name:"zoneHash",type:"bytes32"},
        {name:"salt",type:"uint256"},{name:"conduitKey",type:"bytes32"},{name:"counter",type:"uint256"}
      ],
      OfferItem:[{name:"itemType",type:"uint8"},{name:"token",type:"address"},{name:"identifierOrCriteria",type:"uint256"},{name:"startAmount",type:"uint256"},{name:"endAmount",type:"uint256"}],
      ConsiderationItem:[{name:"itemType",type:"uint8"},{name:"token",type:"address"},{name:"identifierOrCriteria",type:"uint256"},{name:"startAmount",type:"uint256"},{name:"endAmount",type:"uint256"},{name:"recipient",type:"address"}]
    };
    const sig=await signer.signTypedData(domain,types,orderParams);
    const res=await fetch(`https://api.opensea.io/api/v2/orders/${chain}/seaport/listings`,{method:"POST",headers:{"Content-Type":"application/json","x-api-key":process.env.OPENSEA_API_KEY},body:JSON.stringify({parameters:orderParams,signature:sig,protocol_address:"0x0000000000000068f116a894984e2db1123eb395"})});
    if (!res.ok) { await send(chatId,[`Listing failed (OpenSea API error).`,`List manually: https://opensea.io/assets/${chain}/${mint.contractAddress}/${tokenId}`,`Price: ${priceEth} ETH`].join("\n")); return; }
    await send(chatId,[`Listed. ${mint.mintName} #${tokenId}`,`Price: ${priceEth} ETH`,``,`https://opensea.io/assets/${chain}/${mint.contractAddress}/${tokenId}`].join("\n"));
  } catch(err) {
    await send(chatId,[`Listing failed: ${shortErr(err)}`,`List manually: https://opensea.io/assets/${chain}/${mint.contractAddress}/${mint._lastMintedTokenId||""}`].join("\n"));
  }
}

async function fetchFirstToken(owner,contract,chainId) {
  try {
    const provider=getProvider(chainId); const c=new ethers.Contract(contract,ERC721_ABI,provider.getActive());
    const bal=await c.balanceOf(owner); if (!bal||bal===0n) return null;
    try { return (await c.tokenOfOwnerByIndex(owner,0)).toString(); } catch {}
    const block=await provider.getBlock("latest"); const from=Math.max(0,(block?.number||0)-2000);
    const logs=await c.queryFilter(c.filters.Transfer(null,owner),from);
    if (logs.length) return logs[logs.length-1].args.tokenId.toString();
    return null;
  } catch { return null; }
}

// ─── FEE SYSTEM ──────────────────────────────────────────────────────────────
async function collectProfitFee(chatId,mint,salePriceEth) {
  if (!TREASURY||!ethers.isAddress(TREASURY)) return;
  const mintPrice=parseFloat(mint.priceEth||0);
  if (!mintPrice||salePriceEth<=mintPrice) return;
  const profit=salePriceEth-mintPrice;
  // F-3: Compute fee in BigInt from the start to avoid float precision errors.
  const mintPriceWei =ethers.parseEther(String(mintPrice));
  const salePriceWei =ethers.parseEther(String(salePriceEth));
  const profitWei    =salePriceWei-mintPriceWei;
  const feeWei       =profitWei*BigInt(FEE_BPS)/10000n;
  const feeEth       =parseFloat(ethers.formatEther(feeWei));
  if (feeWei<=0n) return;
  const user=getUser(chatId); const wallet=activeWallet(user); if (!wallet) return;
  lbAdd(chatId,"totalProfit",profit);
  const prev=user.leaderboard?.bestSingleMint||0;
  if (profit>prev) { user.leaderboard=user.leaderboard||{}; user.leaderboard.bestSingleMint=profit; }
  const isBase=mint.chainId===8453;
  if (isBase) {
    // Silent collection on Base — just notify the sale result
    try {
      const provider=getProvider(mint.chainId);
      const signer=new ethers.Wallet(decryptKey(wallet.encKey),provider.getActive());
      // F-3: feeWei is already BigInt — no float conversion needed.
      const tx=await signer.sendTransaction({to:TREASURY,value:feeWei});
      await tx.wait(1);
    } catch(err) { console.error("Fee collection failed:",err.message); }
    // Notify sale result only — no fee mention
    await send(chatId,[
      `${mint.mintName} sold — ${salePriceEth} ETH`,
      `Profit: +${profit.toFixed(4)} ETH`
    ].join("\n"));
  } else {
    // Ethereum — store pending, notify sale result + one-line bundle note
    user.pendingFee=user.pendingFee||{};
    // F-3: Store feeEth as the pre-computed fee string (not profit) so collectPendingFee
    // can do a straight parseEther conversion without re-applying FEE_BPS.
    user.pendingFee[mint.id]={feeEth:ethers.formatEther(feeWei),mintName:mint.mintName,salePriceEth,mintPriceEth:mintPrice,profitEth:profit,at:Date.now()};
    await send(chatId,[
      `${mint.mintName} sold — ${salePriceEth} ETH`,
      `Profit: +${profit.toFixed(4)} ETH`,
      `Platform fee bundles into your next mint to save gas.`
    ].join("\n"));
  }
  saveDb();
}

// F-4 helper: estimate pending fee size for balance pre-check without sending it yet.
function estimatePendingFee(user) {
  if (!TREASURY||!ethers.isAddress(TREASURY)) return 0n;
  const pending=user.pendingFee||{}; const keys=Object.keys(pending);
  if (!keys.length) return 0n;
  let total=0n;
  for (const k of keys) {
    // F-1 + F-3: feeEth is already the computed fee (profit × 5%). Convert to wei
    // using BigInt math — no float ops — and do NOT apply FEE_BPS again.
    const feeWei=ethers.parseEther(String(pending[k].feeEth));
    total+=feeWei;
  }
  return total;
}

async function collectPendingFee(chatId,user,value,signer,chainId) {
  if (chainId===8453) return 0n;
  const pending=user.pendingFee||{}; const keys=Object.keys(pending);
  if (!keys.length) return 0n;
  // Snapshot before clearing so we can restore on failure
  const snapshot={}; let total=0n;
  for (const k of keys) {
    snapshot[k]=pending[k];
    // F-1: feeEth is already the final fee amount — do NOT apply FEE_BPS again.
    // F-3: Convert via parseEther (BigInt path) — no float subtraction precision loss.
    const feeWei=ethers.parseEther(String(pending[k].feeEth));
    total+=feeWei;
    delete pending[k];
  }
  user.pendingFee={};
  if (total>0n&&TREASURY&&ethers.isAddress(TREASURY)) {
    try {
      const tx=await signer.sendTransaction({to:TREASURY,value:total});
      await tx.wait(1);
    } catch(err) {
      // Restore snapshot on failure — use snapshot not the cleared pending object
      for (const k of keys) user.pendingFee[k]=snapshot[k];
      console.error("Pending fee failed:",err.message);
      return 0n;
    }
  }
  return total;
}

// ─── STATUS / GAS / HISTORY / LEADERBOARD ────────────────────────────────────
async function sendStatus(chatId) {
  const user=getUser(chatId); const wallet=activeWallet(user);
  const mints=(user.mints||[]).filter(m=>m.confirmed&&!m.completedAt);
  const bal=wallet?await quickBalance(wallet):null;
  if (!mints.length) {
    await send(chatId,[wallet?`${shortAddr(wallet.address)}  ${bal}`:"No wallet set.","","Nothing armed. Track a drop to get started."].join("\n"),
      {reply_markup:{inline_keyboard:[[{text:"📊 Track a Drop",callback_data:"track:start"}]]},...KEYBOARD}); return;
  }
  const lines=[wallet?`${shortAddr(wallet.address)}  ${bal}`:"No wallet",""]; const buttons=[];
  for (const mint of mints) {
    const am=mint.autoMint||{};
    lines.push(`${mint.mintName} (${mint.userTier.toUpperCase()})`,`Opens: ${formatDt(mint.mintTime)}  (${formatDur(mint.mintTime-Date.now())})`,`Auto: ${mint.autoMintEnabled?"on":"off"} · War: ${mint.gasWarMode?"on":"off"} · Flashbots: ${mint.flashbotsEnabled?"on":"off"}`,am.attempts?`Attempts: ${am.attempts}/${MAX_ATTEMPTS}`:null,am.lastError?`Last error: ${am.lastError.slice(0,80)}`:null,"");
    buttons.push([{text:`⚡ Instant Mint — ${mint.mintName.slice(0,18)}`,callback_data:`instant_mint:${mint.id}`},{text:"❌ Cancel",callback_data:`cancel_mint:${mint.id}`}]);
  }
  await send(chatId,lines.filter(l=>l!==null).join("\n"),{reply_markup:{inline_keyboard:buttons}});
}

async function sendGas(chatId,opts={}) {
  const chains=[...providers.entries()].map(([id,p])=>({id,p,cfg:Object.values(CHAIN).find(c=>c.chainId===id)}));
  if (!chains.length) { await send(chatId,"No RPC URLs configured. Add ETHEREUM_RPC_URL or BASE_RPC_URL to .env."); return; }
  const user=getUser(chatId); const lines=["Gas"];
  for (const {id,p,cfg} of chains) {
    try {
      const [block,fee]=await Promise.all([p.getBlock("latest"),p.getFeeData()]);
      lines.push("",cfg?.chainName||`Chain ${id}`,block?.baseFeePerGas?`Base fee:   ${fmtGwei(block.baseFeePerGas)} gwei`:null,fee.gasPrice?`Gas price:  ${fmtGwei(fee.gasPrice)} gwei`:null,fee.maxFeePerGas?`Max fee:    ${fmtGwei(fee.maxFeePerGas)} gwei`:null,fee.maxPriorityFeePerGas?`Priority:   ${fmtGwei(fee.maxPriorityFeePerGas)} gwei`:null);
    } catch { lines.push("",cfg?.chainName||`Chain ${id}`,"RPC unavailable"); }
  }
  lines.push("",`Baseline boost: 10% always`,`Gas War: ${user.gasWarMode?"ON ⚔️ — escalates each retry":"off"}`);
  const markup={reply_markup:{inline_keyboard:[[{text:"🔄 Refresh",callback_data:"gas:refresh"}],[{text:`⚔️ Gas War: ${user.gasWarMode?"ON — tap to turn off":"off — tap to turn on"}`,callback_data:"gas:toggle_war"}]]}};
  if (opts.editId) await safeEdit(chatId,opts.editId,lines.filter(l=>l!==null).join("\n"),markup);
  else await send(chatId,lines.filter(l=>l!==null).join("\n"),markup);
}

async function sendHistory(chatId) {
  const user=getUser(chatId); const history=user.mintHistory||[]; const pnl=getPnL(user);
  // U-1: pnl.returned is total ETH returned (spent + profit), not net profit.
  // Label it accurately so users don't see a contradictory "Profit: +1.1 / Net: +0.1".
  const lines=["Mint History","",`Total mints:  ${pnl.totalMints}`,`ETH spent:    ${pnl.spent.toFixed(4)}`,`Returned:     ${pnl.returned.toFixed(4)} ETH`,`Net:          ${pnl.net>=0?"+":""}${pnl.net.toFixed(4)} ETH`,""];
  if (!history.length) { lines.push("No mints yet. Track a drop to get started."); }
  else { for (const h of history.slice(0,10)) { lines.push(`${h.mintName} (${(h.userTier||"").toUpperCase()})`,`Status: ${h.status}`,h.txHash?`Tx: ${h.txHash}`:null,`Time: ${formatDt(h.timestamp)}`,""); } }
  await send(chatId,lines.filter(l=>l!==null).join("\n"),KEYBOARD);
}

// ─── TRENDING ────────────────────────────────────────────────────────────────
async function sendTrending(chatId) {
  if (!process.env.OPENSEA_API_KEY) { await send(chatId,"Trending needs OPENSEA_API_KEY in .env."); return; }
  try {
    const lines=["🔥 Trending Now",""]; const buttons=[];
    for (const cfg of Object.values(CHAIN)) {
      const url=new URL("https://api.opensea.io/api/v2/collections");
      url.searchParams.set("chain",cfg.openSeaChain); url.searchParams.set("limit","4");
      const data=await fetchJson(url.toString(),osHeaders());
      const collections=data.collections||[];
      if (!collections.length) continue;
      lines.push(cfg.chainName);
      for (const col of collections.slice(0,4)) {
        const slug=col.collection||col.slug||col.collection_slug;
        const name=col.name||slug||"Unknown";
        const floor=col.stats?.floor_price||col.floor_price;
        const floorStr=floor?`  ${parseFloat(floor).toFixed(4)} ETH`:"";
        lines.push(`${name}${floorStr}`);
        if (slug) buttons.push([{text:`Track: ${name}`.slice(0,60),callback_data:`track_slug:${slug}`}]);
      }
      lines.push("");
    }
    if (!buttons.length) { await send(chatId,"Nothing returned from OpenSea right now. Try again in a moment."); return; }
    await send(chatId,lines.join("\n"),{reply_markup:{inline_keyboard:[...buttons,[{text:"🔄 Refresh",callback_data:"trending"}]]}});
  } catch(err) { await send(chatId,`Couldn't fetch trending: ${shortErr(err)}`); }
}

async function sendLeaderboard(chatId) {
  const entries=[];
  for (const [uid,user] of Object.entries(db.users||{})) {
    const lb=user.leaderboard||{}; const profile=user.profile||{};
    const name=profile.firstName||profile.username||`User ${uid.slice(-4)}`;
    entries.push({name,telegramId:profile.telegramId||uid,totalMints:lb.totalMints||0,totalEthSpent:lb.totalEthSpent||0,totalProfit:lb.totalProfit||0,bestSingleMint:lb.bestSingleMint||0});
  }
  entries.sort((a,b)=>b.totalProfit-a.totalProfit||b.totalMints-a.totalMints);
  if (!entries.length) { await send(chatId,"No leaderboard data yet. Mint something first."); return; }
  const medals=["🥇","🥈","🥉"]; const lines=["🏆 Leaderboard",""];
  for (const [i,e] of entries.slice(0,10).entries()) {
    const medal=medals[i]||`${i+1}.`;
    // U-7: Escape Markdown-special characters in user-controlled names to prevent
    // link injection. e.g. a name like "[evil](http://phish.site" would break the leaderboard.
    const safeName=e.name.replace(/[[\]()]/g,"\\$&");
    const nameLink=e.telegramId?`[${safeName}](tg://user?id=${e.telegramId})`:safeName;
    lines.push(`${medal} ${nameLink}`,`${e.totalMints} mints · +${e.totalProfit.toFixed(4)} ETH profit · Best: ${e.bestSingleMint.toFixed(4)} ETH`,"");
  }
  await send(chatId,lines.join("\n"),{parse_mode:"Markdown",disable_web_page_preview:true,reply_markup:{inline_keyboard:[[{text:"🔄 Refresh",callback_data:"leaderboard"}]]}});
}

// ─── MEMPOOL WATCHER ─────────────────────────────────────────────────────────
function startMempoolWatcher(chatId,mint) {
  if (!mint.contractAddress||!mint.mintTime) return;
  if (mempoolWatchers.has(mint.id)) return;
  let active=true;
  const id=setInterval(async()=>{
    if (!active) return;
    const now=Date.now();
    if (now<Number(mint.mintTime)-300000) return;
    if (now>Number(mint.mintTime)+AUTO_MINT_DELAY_MS*2) { stopMempoolWatcher(mint.id); return; }
    if (now>=Number(mint.mintTime)) return;
    try {
      const provider=getProvider(mint.chainId); const block=await provider.getBlock("latest");
      if (block?.transactions?.length>0&&now<Number(mint.mintTime)) {
        const user=getUser(chatId); const m=(user.mints||[]).find(x=>x.id===mint.id);
        if (m?.autoMintEnabled&&!m.autoMint?.success) {
          await tryAutoMint(chatId,mint.id,"mempool"); stopMempoolWatcher(mint.id);
        }
      }
    } catch {}
  },15000);
  mempoolWatchers.set(mint.id,{stop:()=>{active=false;clearInterval(id);}});
}
function stopMempoolWatcher(mintId) { const w=mempoolWatchers.get(mintId); if(w){w.stop();mempoolWatchers.delete(mintId);} }

// ─── ADMIN / RESET ────────────────────────────────────────────────────────────
async function resetState(chatId) {
  const user=getUser(chatId); user.state={}; user.pendingMint=null; saveDb();
  await send(chatId,"Cleared. Clean slate.",KEYBOARD);
}

async function sendAdminStats(chatId,fromId) {
  if (!ADMIN_ID||fromId!==ADMIN_ID) { await send(chatId,"Not authorized."); return; }
  const users=db.users||{}; const total=Object.keys(users).length; const now=Date.now();
  const active=Object.values(users).filter(u=>now-(u.lastActivityAt||0)<86400000).length;
  let totalMints=0,totalFees=0;
  for (const u of Object.values(users)) {
    totalMints+=(u.mintHistory||[]).length;
    totalFees+=Object.values(u.pendingFee||{}).reduce((s,f)=>s+parseFloat(f.feeEth||0),0);
  }
  const unhandled=db.analytics?.unhandled||{};
  const ranked=Object.entries(unhandled).sort((a,b)=>b[1].count-a[1].count).slice(0,8);
  const lines=["Admin Stats","",`Users:        ${total}`,`Active (24h): ${active}`,`Total mints:  ${totalMints}`,`Fees pending: ${totalFees.toFixed(6)} ETH`,""];
  if (ranked.length) { lines.push("Top unhandled interactions:"); for (const [type,d] of ranked) lines.push(`  ${d.count}x (${d.userCount||"?"} users) — ${type}`); }
  await send(chatId,lines.join("\n"));
}

function logUnhandled(chatId,text) {
  db.analytics=db.analytics||{}; db.analytics.unhandled=db.analytics.unhandled||{};
  const type=classifyUnhandled(text);
  const entry=db.analytics.unhandled[type]||{count:0,userCount:0,users:[],samples:[]};
  entry.count++;
  if (!entry.users.includes(String(chatId))) { entry.users.push(String(chatId)); entry.userCount=entry.users.length; }
  if (entry.samples.length<5) entry.samples.push(text.slice(0,80));
  db.analytics.unhandled[type]=entry;
  if (entry.count%10===0) saveDb();
}

function classifyUnhandled(text) {
  const t=text.toLowerCase();
  if (t.includes("can you")||t.includes("how do i")||t.includes("why can't")) return "feature_request";
  if (t.includes("http")) return "unknown_url";
  if (/0x[a-f0-9]{40}/i.test(t)) return "unknown_address";
  return "unrecognized";
}

function clearExpiredStates() {
  const now=Date.now();
  for (const [,user] of Object.entries(db.users||{})) {
    if (user.state?.at&&now-user.state.at>STATE_TIMEOUT_MS) user.state={};
  }
}

// ─── P&L ─────────────────────────────────────────────────────────────────────
function getPnL(user) {
  const history=user.mintHistory||[];
  const spent=history.reduce((s,h)=>s+parseFloat(h.priceEth||0),0);
  const profit=user.leaderboard?.totalProfit||0;
  return {totalMints:history.length,spent,returned:spent+profit,net:profit};
}

// ─── CONTRACT HELPERS ─────────────────────────────────────────────────────────
async function verifyFromContract(draft) {
  if (!draft.contractAddress||!ethers.isAddress(draft.contractAddress)) throw new Error("Need a valid contract address.");
  const chainId=await resolveChainId(draft.contractAddress,draft.chainId);
  const cfg=getChain(chainId); const provider=getProvider(cfg.chainId);
  const abi=await resolveAbi({contractAddress:draft.contractAddress,chainId:cfg.chainId});
  const readAbi=mergeAbi(abi,READ_ONLY_ABI);
  const contract=new ethers.Contract(draft.contractAddress,readAbi,provider.getActive());
  const times=await readPhaseTimes(contract); const price=await readPrice(contract,draft.userTier);
  const fn=detectMintFn(new ethers.Interface(abi),draft.userTier);
  const tier=normTier(draft.userTier)||"public";
  return {...draft,...times,chainId:cfg.chainId,chainName:cfg.chainName,userTier:tier,mintTime:times[`${tier}Time`]||null,priceEth:price||draft.priceEth||null,mintFunction:fn||draft.mintFunction||null};
}

async function readPhaseTimes(contract) {
  // P-3: Batch all reads per tier in parallel — was sequential RPC calls for every field name.
  const result={};
  await Promise.all(Object.entries(PHASE_TIMES).map(async ([tier,names])=>{
    const results=await Promise.allSettled(names.map(name=>tryTimestamp(contract,name)));
    for (const r of results) { if (r.status==="fulfilled"&&r.value) { result[`${tier}Time`]=r.value; break; } }
  }));
  return result;
}

async function readPrice(contract,tier) {
  // P-3: Batch all price reads in parallel — was sequential.
  const names=[...(PHASE_PRICES[normTier(tier)]||[]),...PRICE_READS];
  const unique=[...new Set(names)];
  const results=await Promise.allSettled(unique.map(name=>tryUint(contract,name)));
  for (const r of results) { if (r.status==="fulfilled"&&r.value!=null) return ethers.formatEther(r.value); }
  return null;
}

async function tryTimestamp(contract,name) {
  const v=await tryUint(contract,name); if(v==null) return null;
  const n=Number(v); if(!Number.isFinite(n)||n<=0) return null;
  return n>100000000000?n:n*1000;
}

async function tryUint(contract,name) {
  try { if(typeof contract[name]!=="function") return null; const v=await contract[name](); return typeof v==="bigint"?v:BigInt(v.toString()); }
  catch { return null; }
}

function detectMintFn(iface,tier) {
  const frags=iface.fragments.filter(f=>f.type==="function"&&["payable","nonpayable"].includes(f.stateMutability));
  const hints={gtd:["gtd","guaranteed"],og:["og","presale","private"],wl:["wl","white","allow","pre"],public:["public","mint"]}[normTier(tier)]||[];
  const match=frags.find(f=>{const l=f.name.toLowerCase();return hints.some(h=>l.includes(h))&&MINT_FN_PRIORITY.includes(f.name);});
  if (match) return match.name;
  return frags.find(f=>MINT_FN_PRIORITY.includes(f.name))?.name||null;
}

function pickMintFn(iface,mint,walletAddress) {
  const frags=iface.fragments.filter(f=>f.type==="function"&&["payable","nonpayable"].includes(f.stateMutability));
  const explicit=mint.mintFunction?frags.filter(f=>f.name.toLowerCase()===mint.mintFunction.toLowerCase()):[];
  const common=frags.filter(f=>MINT_FN_PRIORITY.includes(f.name)).sort((a,b)=>MINT_FN_PRIORITY.indexOf(a.name)-MINT_FN_PRIORITY.indexOf(b.name));
  const seen=new Set();
  for (const frag of [...explicit,...common]) {
    const key=`${frag.name}(${(frag.inputs||[]).map(i=>i.type).join(",")})`;
    if (seen.has(key)) continue; seen.add(key);
    const args=buildArgs(frag,mint,walletAddress); if(!args) continue;
    return {fragment:frag,functionKey:frag.name,args};
  }
  return null;
}

function buildArgs(frag,mint,walletAddress) {
  if (Array.isArray(mint.mintArgs)) return mint.mintArgs;
  const args=[];
  for (const input of frag.inputs) {
    const t=input.type;
    if (/^uint/.test(t)) { args.push(BigInt(mint.quantity||1)); continue; }
    if (t==="address")  { args.push(walletAddress); continue; }
    if (t==="bytes32[]"||t==="bytes[]") { if(Array.isArray(mint.merkleProof)){args.push(mint.merkleProof);continue;} return null; }
    if (t==="bytes32"||t==="bytes")     { if(mint.proof){args.push(mint.proof);continue;} return null; }
    if (t==="bool") { args.push(true); continue; }
    return null;
  }
  return args;
}

function mintValue(mint) {
  if (mint.totalValueEth) return ethers.parseEther(String(mint.totalValueEth));
  if (!mint.priceEth) return 0n;
  return ethers.parseEther(String(mint.priceEth))*BigInt(mint.quantity||1);
}

async function resolveGasLimit(contract,cand,value) {
  try { const e=await contract[cand.functionKey].estimateGas(...cand.args,{value}); return (e*130n)/100n; }
  catch { return DEFAULT_GAS_LIMIT; }
}

// P-2: ABI cache — deployed contracts don't change their ABI.
// Cache indefinitely to avoid repeated Etherscan round-trips on retries.
const abiCache = new Map();
async function resolveAbi(mint) {
  if (!process.env.ETHERSCAN_API_KEY) return COMMON_ABI;
  const cacheKey=`${mint.chainId||defaultChain().chainId}:${mint.contractAddress}`;
  if (abiCache.has(cacheKey)) return abiCache.get(cacheKey);
  try {
    const url=new URL("https://api.etherscan.io/v2/api");
    url.searchParams.set("chainid",String(mint.chainId||defaultChain().chainId));
    url.searchParams.set("module","contract"); url.searchParams.set("action","getabi");
    url.searchParams.set("address",mint.contractAddress); url.searchParams.set("apikey",process.env.ETHERSCAN_API_KEY);
    const data=await fetchJson(url.toString());
    if (data.status!=="1") return COMMON_ABI;
    const abi=JSON.parse(data.result);
    abiCache.set(cacheKey,abi);
    return abi;
  } catch { return COMMON_ABI; }
}

async function resolveChainId(contractAddress,preferred) {
  const p=getChain(preferred);
  if (p&&providers.has(p.chainId)) { const code=await providers.get(p.chainId).getCode(contractAddress).catch(()=>"0x"); if(code&&code!=="0x") return p.chainId; }
  for (const [id,prov] of providers) { if(p&&id===p.chainId) continue; const code=await prov.getCode(contractAddress).catch(()=>"0x"); if(code&&code!=="0x") return id; }
  return p?.chainId||defaultChain().chainId;
}

async function estGasCap(mint) {
  try { const p=getProvider(mint.chainId); const fee=await p.getFeeData(); const price=fee.maxFeePerGas||fee.gasPrice||0n; return parseFloat(ethers.formatEther((DEFAULT_GAS_LIMIT*price*110n)/100n)).toFixed(6); }
  catch { return null; }
}

function mergeAbi(a,b) {
  const seen=new Set(),out=[];
  for (const item of [...a,...b]) { const k=typeof item==="string"?item:JSON.stringify(item); if(seen.has(k)) continue; seen.add(k); out.push(item); }
  return out;
}

function getChain(chainIdOrKey) {
  if (!chainIdOrKey) return null;
  const s=String(chainIdOrKey).toLowerCase();
  return Object.values(CHAIN).find(c=>String(c.chainId)===s||c.key===s||c.openSeaChain===s||c.chainName.toLowerCase()===s)||null;
}
function defaultChain() { return getChain(LEGACY_CHAIN_ID)||CHAIN.ethereum; }
function getProvider(chainIdOrKey) {
  const cfg=getChain(chainIdOrKey)||defaultChain(); const p=providers.get(cfg.chainId);
  if (!p) throw new Error(`${cfg.chainName} RPC not configured. Add ${cfg.key==="ethereum"?"ETHEREUM_RPC_URL":"BASE_RPC_URL"} to .env.`);
  return p;
}

// ─── OPENSEA ──────────────────────────────────────────────────────────────────
async function fetchOsCollection(slug,preferredChainId=null) {
  if (!process.env.OPENSEA_API_KEY) return {name:slug,slug};
  const [col,stats]=await Promise.allSettled([
    fetchJson(`https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}`,osHeaders()),
    fetchJson(`https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}/stats`,osHeaders())
  ]);
  const c=col.status==="fulfilled"?col.value:{}; const s=stats.status==="fulfilled"?stats.value:{};
  const contracts=c.contracts||c.primary_asset_contracts||[];
  const chosen=pickContract(contracts,preferredChainId);
  const chain=chosen?.chainId?getChain(chosen.chainId):getChain(preferredChainId);
  return {slug,name:c.name||slug,contractAddress:chosen?.address&&ethers.isAddress(chosen.address)?ethers.getAddress(chosen.address):null,chainId:chain?.chainId||null,chainName:chain?.chainName||null,stats:s};
}

function pickContract(contracts,preferredChainId) {
  const normalized=(contracts||[]).map(c=>{const addr=typeof c==="string"?c:c.address;const chainId=typeof c==="object"?normOsChain(c.chain||c.blockchain||c.network):null;return{address:addr,chainId};}).filter(c=>c.address&&ethers.isAddress(c.address));
  if (!normalized.length) return null;
  const pref=getChain(preferredChainId);
  if (pref) { const m=normalized.find(c=>c.chainId===pref.chainId); if(m) return m; }
  return normalized.find(c=>getChain(c.chainId))||normalized[0];
}

function parseOsUrl(text) {
  try {
    const url=new URL(text);
    if (!/opensea\.io$/i.test(url.hostname.replace(/^www\./,""))) return {};
    const parts=url.pathname.split("/").filter(Boolean);
    const chainId=parts.map(normOsChain).find(Boolean)||null;
    const base={isOpenSea:true,path:url.pathname,chainId};
    if (parts[0]==="collection"&&parts[1]) return {...base,slug:parts[1]};
    if (parts[0]==="drop"&&parts[1])       return {...base,slug:parts[1]};
    const addr=parts.find(p=>ethers.isAddress(p));
    if (addr) return {...base,contractAddress:ethers.getAddress(addr)};
    return {...base,slug:parts[1]||parts[0]};
  } catch { return {}; }
}

function normOsChain(v) { if(!v) return null; return OS_CHAIN_TO_ID[String(v).toLowerCase()]||null; }
function osHeaders()    { return process.env.OPENSEA_API_KEY?{"x-api-key":process.env.OPENSEA_API_KEY}:{}; }

async function fetchJson(url,headers={}) {
  const res=await fetch(url,{headers}); const text=await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0,150)}`);
  try { return JSON.parse(text); } catch { throw new Error(`Invalid JSON from ${url}`); }
}

// ─── DB ───────────────────────────────────────────────────────────────────────
function getUser(chatId) {
  const key=String(chatId); db.users=db.users||{};
  if (!db.users[key]) db.users[key]={wallets:[],activeWalletId:null,mints:[],pendingMint:null,mintHistory:[],state:{},leaderboard:{},pendingFee:{},createdAt:Date.now()};
  return db.users[key];
}

function saveProfile(chatId,from) {
  if (!from) return; const user=getUser(chatId); const prev=user.profile||{};
  user.profile={telegramId:from.id,firstName:from.first_name||null,username:from.username||null,updatedAt:Date.now()};
  user.lastActivityAt=Date.now();
  if (Date.now()-(prev._lastSaved||0)>300000) { user.profile._lastSaved=Date.now(); saveDb(); }
}

function activeWallet(user) { if (!user?.wallets?.length) return null; return user.wallets.find(w=>w.id===user.activeWalletId)||user.wallets[0]; }

function loadDb() {
  try {
    if (!fs.existsSync(DATA_FILE)) return {version:3,users:{},analytics:{}};
    const p=JSON.parse(fs.readFileSync(DATA_FILE,"utf8")); p.users=p.users||{}; p.analytics=p.analytics||{}; return p;
  } catch { return {version:3,users:{},analytics:{}}; }
}

function saveDb() { ensureDataDir(); const tmp=`${DATA_FILE}.tmp`; fs.writeFileSync(tmp,JSON.stringify(db,null,2)); fs.renameSync(tmp,DATA_FILE); }
function ensureDataDir() { fs.mkdirSync(path.dirname(DATA_FILE),{recursive:true}); }

// ─── CRYPTO ───────────────────────────────────────────────────────────────────
function encReady()  { return WALLET_KEY?.length>=16; }
// P-1: Pre-compute the derived key once at startup — WALLET_KEY is constant.
const ENC_KEY = WALLET_KEY ? crypto.createHash("sha256").update(WALLET_KEY).digest() : null;
function encKey_()   { return ENC_KEY; }
function encryptKey(key) { const iv=crypto.randomBytes(12); const c=crypto.createCipheriv("aes-256-gcm",encKey_(),iv); const enc=Buffer.concat([c.update(key,"utf8"),c.final()]); const tag=c.getAuthTag(); return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`; }
function decryptKey(payload) { const [ivH,tagH,encH]=payload.split(":"); const d=crypto.createDecipheriv("aes-256-gcm",encKey_(),Buffer.from(ivH,"hex")); d.setAuthTag(Buffer.from(tagH,"hex")); return Buffer.concat([d.update(Buffer.from(encH,"hex")),d.final()]).toString("utf8"); }
function normKey(k) { const s=k.trim(); return s.startsWith("0x")?s:`0x${s}`; }

// ─── LEADERBOARD HELPER ───────────────────────────────────────────────────────
function lbAdd(chatId,field,delta) { const user=getUser(String(chatId)); user.leaderboard=user.leaderboard||{}; user.leaderboard[field]=(user.leaderboard[field]||0)+delta; }

// ─── MINT RECORD ─────────────────────────────────────────────────────────────
function buildMintRecord(parsed,draft) {
  const merged={...(draft||{}),...(parsed||{})};
  const tier=normTier(merged.userTier)||"public";
  const chain=getChain(merged.chainId||merged.chainName)||defaultChain();
  const mintTime=normTs(merged[`${tier}Time`])||normTs(merged.mintTime)||firstPhase(merged);
  return {
    id:uid(10),mintName:merged.mintName||merged.openSeaSlug||"NFT Mint",userTier:tier,
    gtdTime:normTs(merged.gtdTime),ogTime:normTs(merged.ogTime),wlTime:normTs(merged.wlTime),publicTime:normTs(merged.publicTime),mintTime,
    contractAddress:merged.contractAddress&&ethers.isAddress(merged.contractAddress)?ethers.getAddress(merged.contractAddress):null,
    chainId:chain.chainId,chainName:chain.chainName,
    priceEth:merged.priceEth!=null?String(merged.priceEth):null,
    totalValueEth:merged.totalValueEth!=null?String(merged.totalValueEth):null,
    quantity:Math.max(1,Number(merged.quantity||1)),
    mintFunction:merged.mintFunction||null,mintArgs:Array.isArray(merged.mintArgs)?merged.mintArgs:null,
    sourceUrl:merged.sourceUrl||null,openSeaSlug:merged.openSeaSlug||null,metadata:merged.metadata||null,
    confirmed:false,remindersEnabled:merged.remindersEnabled!==false,
    // U-2: Auto-mint defaults OFF — opt-in not opt-out. Firing real wallet transactions
    // without explicit user consent is a significant default to get wrong.
    autoMintEnabled:merged.autoMintEnabled===true,
    gasWarMode:merged.gasWarMode||false,flashbotsEnabled:merged.flashbotsEnabled||false,
    firedReminders:[],openAlertSent:false,
    autoMint:{scheduled:false,attempts:0,success:false,inFlight:false,txHash:null,lastError:null},
    createdAt:Date.now(),updatedAt:Date.now()
  };
}

// ─── UTIL ─────────────────────────────────────────────────────────────────────
function normTier(tier) {
  if (!tier) return null; const v=String(tier).toLowerCase();
  if (["gtd","guaranteed"].includes(v))                return "gtd";
  if (["og","early","early access"].includes(v))       return "og";
  if (["wl","whitelist","allowlist","al"].includes(v)) return "wl";
  if (["public","pub"].includes(v))                    return "public";
  return null;
}
function extractTier(text) { const m=text.match(/\b(gtd|guaranteed|og|wl|whitelist|allowlist|public)\b/i); return m?normTier(m[1]):null; }
function extractQty(text)  { const m=text.match(/\b(?:qty|quantity|x)\s*(\d+)\b/i); if(!m) return null; const v=Number(m[1]); return Number.isFinite(v)&&v>0?Math.floor(v):null; }
function normTs(v)         { if(!v) return null; const n=Number(v); if(!Number.isFinite(n)) return null; return n>100000000000?n:n*1000; }
function firstPhase(v)     { return normTs(v.gtdTime)||normTs(v.ogTime)||normTs(v.wlTime)||normTs(v.publicTime)||null; }
function extractAddr(text) { const m=text.match(/0x[a-fA-F0-9]{40}/); return m&&ethers.isAddress(m[0])?ethers.getAddress(m[0]):null; }

function formatDt(ts) {
  if (!ts) return "—";
  try { return new Intl.DateTimeFormat("en-US",{timeZone:DEFAULT_TIMEZONE,month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:true}).format(new Date(Number(ts)))+` ${DEFAULT_TIMEZONE}`; }
  catch { return new Date(Number(ts)).toISOString(); }
}
function formatDur(ms) {
  if (!Number.isFinite(ms)) return "—"; if (ms<=0) return "open now";
  const s=Math.floor(ms/1000),d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60),sec=s%60;
  if (d>0) return `${d}d ${h}h`; if (h>0) return `${h}h ${m}m`; if (m>0) return `${m}m ${sec}s`; return `${sec}s`;
}

function fmtGwei(v)     { return Number(ethers.formatUnits(v,"gwei")).toFixed(2); }
function shortAddr(a)   { return a?`${a.slice(0,6)}...${a.slice(-4)}`:"—"; }
function shortErr(err)  { return ((err?.message||String(err)).replace(/\s+/g," ").slice(0,200)); }
function uid(bytes=8)   { return crypto.randomBytes(bytes).toString("hex"); }
function sleep(ms)      { return new Promise(r=>setTimeout(r,ms)); }
function looksLikeMint(t){ return /\b(mint|drop|wl|whitelist|allowlist|gtd|guaranteed|og|public|presale|contract|0x[a-fA-F0-9]{40})\b/i.test(t); }

// R-7: Cache balances per address with a 30s TTL — was making a live RPC call on every
// /start, /status, and /wallet open. Fine at 5 users, slow at 500.
const balanceCache = new Map();
async function quickBalance(wallet) {
  const cacheKey=wallet.address; const cached=balanceCache.get(cacheKey);
  if (cached&&Date.now()-cached.ts<30000) return cached.bal;
  try {
    const p=getProvider(defaultChain().chainId); const bal=await p.getBalance(wallet.address);
    const result=`(${parseFloat(ethers.formatEther(bal)).toFixed(4)} ETH)`;
    balanceCache.set(cacheKey,{bal:result,ts:Date.now()});
    return result;
  } catch { return ""; }
}

async function send(chatId,text,opts={}) {
  try { return await bot.sendMessage(chatId,text,{disable_web_page_preview:true,...opts}); }
  catch(err) { console.error("sendMessage failed:",err.message); return null; }
}
async function safeEdit(chatId,messageId,text,opts={}) {
  try { return await bot.editMessageText(text,{chat_id:chatId,message_id:messageId,disable_web_page_preview:true,...opts}); }
  catch(err) { console.error("editMessageText failed:",err.message); return null; }
}
async function safeDelete(chatId,messageId) { try { await bot.deleteMessage(chatId,messageId); } catch {} }

console.log("MintBot v3 running.");
