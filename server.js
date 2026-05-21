// ============================================================
// ORACLE v2 — AI Autonomous Pump.fun Trader
// Backend: Node.js + Express | Railway Deploy
// ============================================================

const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");
const fetch = require("node-fetch");
const app = express();

app.use(cors());
app.use(express.json());

// ── ENV VARS (set di Railway) ────────────────────────────────
const CONFIG = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
  QUICKNODE_RPC: process.env.QUICKNODE_RPC || "",
  QUICKNODE_WSS: process.env.QUICKNODE_WSS || "",
  WALLET_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY || "",
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",
  PORT: process.env.PORT || 3000,
};

// ── STATE ────────────────────────────────────────────────────
let botState = {
  running: false,
  mode: "paper", // "paper" | "live"
  paperBalance: 1.0, // SOL
  liveBalance: 0,
  confidence_threshold: 75,
  max_trade_size_sol: 0.05,
  stop_loss_pct: 30,
  take_profit_pct: 50,
  trades: [],
  activePositions: {},
  tradeMemory: [], // Claude's learning memory
  stats: {
    total: 0,
    wins: 0,
    losses: 0,
    pnl_sol: 0,
    pnl_pct: 0,
  },
  logs: [],
};

// ── PUMP.FUN PROGRAM IDs ─────────────────────────────────────
const PUMP_FUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_FUN_MIGRATION = "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg";

// ── LOGGING ──────────────────────────────────────────────────
function log(level, msg, data = null) {
  const entry = {
    time: new Date().toISOString(),
    level,
    msg,
    data,
  };
  botState.logs.unshift(entry);
  if (botState.logs.length > 200) botState.logs.pop();
  console.log(`[${level}] ${msg}`, data || "");
}

// ── TELEGRAM NOTIFY ──────────────────────────────────────────
async function sendTelegram(msg) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(
      `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CONFIG.TELEGRAM_CHAT_ID,
          text: msg,
          parse_mode: "Markdown",
        }),
      }
    );
  } catch (e) {
    log("WARN", "Telegram send failed", e.message);
  }
}

// ── SHARED HEADERS (mimic browser) ───────────────────────────
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Origin": "https://pump.fun",
  "Referer": "https://pump.fun/",
};

// ── FETCH TOKEN DATA FROM PUMP.FUN ───────────────────────────
async function fetchTokenData(mintAddress) {
  // Try Pump.fun API v2 first, fallback to v1
  const urls = [
    `https://frontend-api-v2.pump.fun/coins/${mintAddress}`,
    `https://frontend-api.pump.fun/coins/${mintAddress}`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: BROWSER_HEADERS });
      if (res.ok) return await res.json();
    } catch (e) {}
  }
  return null;
}

// ── FETCH RECENT TOKENS ──────────────────────────────────────
async function fetchRecentTokens() {
  const urls = [
    "https://frontend-api-v2.pump.fun/coins?offset=0&limit=20&sort=created_timestamp&order=DESC&includeNsfw=false",
    "https://frontend-api.pump.fun/coins?offset=0&limit=20&sort=created_timestamp&order=DESC&includeNsfw=false",
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: BROWSER_HEADERS });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          log("INFO", `Fetched ${data.length} tokens from Pump.fun`);
          return data;
        }
      }
    } catch (e) {
      log("WARN", `Fetch failed: ${url} — ${e.message}`);
    }
  }
  log("WARN", "All Pump.fun endpoints failed");
  return [];
}

// ── CLAUDE AI DECISION ENGINE ────────────────────────────────
async function claudeAnalyze(tokenData) {
  if (!CONFIG.ANTHROPIC_API_KEY) {
    log("WARN", "No Anthropic API key set");
    return null;
  }

  // Build memory context from recent trades
  const recentMemory = botState.tradeMemory.slice(-10);
  const memoryContext =
    recentMemory.length > 0
      ? `\nRECENT TRADE MEMORY (learn from this):\n${JSON.stringify(recentMemory, null, 2)}`
      : "\nNo trade history yet.";

  // Build stats context
  const statsContext = `
CURRENT BOT STATS:
- Total trades: ${botState.stats.total}
- Win rate: ${botState.stats.total > 0 ? ((botState.stats.wins / botState.stats.total) * 100).toFixed(1) : 0}%
- Total PnL: ${botState.stats.pnl_sol.toFixed(4)} SOL
- Active positions: ${Object.keys(botState.activePositions).length}
`;

  const prompt = `You are ORACLE v2, an autonomous AI trading bot for Pump.fun on Solana.
Your job: analyze the token data below and decide BUY, SKIP, or WATCH.

${statsContext}
${memoryContext}

TOKEN TO ANALYZE:
${JSON.stringify(tokenData, null, 2)}

RULES:
1. Rug pull patterns → always SKIP
2. Dev wallet holding >30% → SKIP
3. Token age < 2 min with high volume growth → possible BUY
4. Confidence must be honest — do NOT force BUY
5. Learn from trade memory — avoid patterns that caused losses

Respond ONLY in this exact JSON format (no markdown, no extra text):
{
  "decision": "BUY" | "SKIP" | "WATCH",
  "confidence": 0-100,
  "reasoning": "2-3 sentence explanation",
  "entry_strategy": "immediate" | "wait_dip" | null,
  "exit_target_pct": 30-100 or null,
  "stop_loss_pct": 15-40 or null,
  "risk_level": "low" | "medium" | "high",
  "red_flags": ["list of concerns"] or [],
  "green_flags": ["list of positives"] or []
}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CONFIG.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await res.json();
    if (!data.content || !data.content[0]) return null;

    const text = data.content[0].text.trim();
    const parsed = JSON.parse(text);
    return parsed;
  } catch (e) {
    log("ERROR", "Claude analysis failed", e.message);
    return null;
  }
}

// ── EXECUTE TRADE (PAPER) ────────────────────────────────────
async function executePaperTrade(tokenData, analysis) {
  const tradeSize = botState.max_trade_size_sol;
  if (botState.paperBalance < tradeSize) {
    log("WARN", "Insufficient paper balance");
    return;
  }

  const tradeId = `PAPER_${Date.now()}`;
  const trade = {
    id: tradeId,
    mint: tokenData.mint,
    symbol: tokenData.symbol || "UNKNOWN",
    name: tokenData.name || "Unknown Token",
    entryPrice: tokenData.usd_market_cap / tokenData.total_supply || 0,
    size_sol: tradeSize,
    mode: "paper",
    status: "open",
    openTime: Date.now(),
    analysis,
    exitPrice: null,
    pnl_sol: null,
    pnl_pct: null,
  };

  botState.paperBalance -= tradeSize;
  botState.activePositions[tradeId] = trade;
  botState.trades.unshift(trade);
  botState.stats.total++;

  log("TRADE", `📄 PAPER BUY: ${trade.symbol}`, {
    confidence: analysis.confidence,
    size: tradeSize,
  });

  await sendTelegram(
    `🤖 *ORACLE v2 — PAPER BUY*\n\n` +
      `Token: *${trade.symbol}* (${trade.name})\n` +
      `Mint: \`${trade.mint}\`\n` +
      `Size: ${tradeSize} SOL\n` +
      `Confidence: ${analysis.confidence}%\n` +
      `Risk: ${analysis.risk_level?.toUpperCase()}\n\n` +
      `💭 *Reasoning:*\n${analysis.reasoning}\n\n` +
      `🟢 Positives: ${analysis.green_flags?.join(", ") || "none"}\n` +
      `🔴 Red flags: ${analysis.red_flags?.join(", ") || "none"}`
  );

  // Auto-exit simulation after delay
  simulateExit(tradeId, tokenData, analysis);
}

// ── SIMULATE EXIT FOR PAPER TRADE ────────────────────────────
function simulateExit(tradeId, tokenData, analysis) {
  const targetPct = analysis.exit_target_pct || 40;
  const slPct = analysis.stop_loss_pct || 25;

  // Simulate: random outcome weighted by confidence
  const rand = Math.random() * 100;
  const winChance = analysis.confidence;

  setTimeout(async () => {
    const trade = botState.activePositions[tradeId];
    if (!trade) return;

    let pnl_pct, outcome;
    if (rand < winChance) {
      // Win
      pnl_pct = targetPct * (0.5 + Math.random() * 0.8);
      outcome = "WIN";
    } else {
      // Loss
      pnl_pct = -slPct * (0.4 + Math.random() * 0.8);
      outcome = "LOSS";
    }

    const pnl_sol = (trade.size_sol * pnl_pct) / 100;
    trade.pnl_sol = pnl_sol;
    trade.pnl_pct = pnl_pct;
    trade.status = "closed";
    trade.closeTime = Date.now();

    botState.paperBalance += trade.size_sol + pnl_sol;
    botState.stats.pnl_sol += pnl_sol;
    if (pnl_sol > 0) botState.stats.wins++;
    else botState.stats.losses++;

    delete botState.activePositions[tradeId];

    // Add to memory for Claude to learn
    botState.tradeMemory.push({
      symbol: trade.symbol,
      mint: trade.mint,
      outcome,
      pnl_pct: pnl_pct.toFixed(2),
      confidence: analysis.confidence,
      risk_level: analysis.risk_level,
      red_flags: analysis.red_flags,
      green_flags: analysis.green_flags,
      duration_ms: trade.closeTime - trade.openTime,
    });
    if (botState.tradeMemory.length > 50) botState.tradeMemory.shift();

    const emoji = outcome === "WIN" ? "✅" : "❌";
    log("TRADE", `${emoji} PAPER EXIT: ${trade.symbol}`, {
      pnl_pct: pnl_pct.toFixed(2),
      pnl_sol: pnl_sol.toFixed(4),
    });

    await sendTelegram(
      `${emoji} *ORACLE v2 — PAPER EXIT*\n\n` +
        `Token: *${trade.symbol}*\n` +
        `Result: *${outcome}*\n` +
        `PnL: ${pnl_sol > 0 ? "+" : ""}${pnl_sol.toFixed(4)} SOL (${pnl_pct > 0 ? "+" : ""}${pnl_pct.toFixed(1)}%)\n` +
        `Balance: ${botState.paperBalance.toFixed(4)} SOL`
    );
  }, 30000 + Math.random() * 60000); // Exit between 30-90 seconds
}

// ── MAIN BOT LOOP ────────────────────────────────────────────
let botInterval = null;

async function botLoop() {
  if (!botState.running) return;

  log("INFO", "🔍 Scanning Pump.fun for new tokens...");

  try {
    const tokens = await fetchRecentTokens();
    if (!tokens || tokens.length === 0) {
      log("WARN", "No tokens fetched");
      return;
    }

    // Filter: only tokens < 10 minutes old
    const now = Date.now();
    const freshTokens = tokens.filter((t) => {
      const age = now - t.created_timestamp;
      return age < 10 * 60 * 1000;
    });

    log("INFO", `Found ${freshTokens.length} fresh tokens`);

    for (const token of freshTokens.slice(0, 3)) {
      // Process max 3 per cycle
      if (!botState.running) break;

      // Skip if already in active position
      if (botState.activePositions[token.mint]) continue;

      // Skip if already traded recently
      const alreadyTraded = botState.trades.find(
        (t) =>
          t.mint === token.mint && Date.now() - t.openTime < 15 * 60 * 1000
      );
      if (alreadyTraded) continue;

      log("INFO", `Analyzing: ${token.symbol || token.mint}`);

      const analysis = await claudeAnalyze(token);
      if (!analysis) continue;

      log("AI", `Claude decision: ${analysis.decision} (${analysis.confidence}%)`, {
        token: token.symbol,
        reasoning: analysis.reasoning,
      });

      if (
        analysis.decision === "BUY" &&
        analysis.confidence >= botState.confidence_threshold
      ) {
        if (botState.mode === "paper") {
          await executePaperTrade(token, analysis);
        } else {
          // Live trading placeholder
          log("LIVE", "Live trading execution (implement with @solana/web3.js)");
        }
      } else {
        log(
          "SKIP",
          `Skipped ${token.symbol}: ${analysis.decision} (${analysis.confidence}%)`
        );
      }

      // Delay between analyses to avoid rate limits
      await new Promise((r) => setTimeout(r, 3000));
    }
  } catch (e) {
    log("ERROR", "Bot loop error", e.message);
  }
}

// ── API ROUTES ───────────────────────────────────────────────

// GET state
app.get("/api/state", (req, res) => {
  res.json({
    ...botState,
    logs: botState.logs.slice(0, 50),
  });
});

// Start bot
app.post("/api/start", (req, res) => {
  if (botState.running) return res.json({ ok: false, msg: "Already running" });
  botState.running = true;
  botLoop();
  botInterval = setInterval(botLoop, 30000); // Every 30 seconds
  log("INFO", "🚀 ORACLE v2 started");
  sendTelegram("🚀 *ORACLE v2 STARTED*\nMode: " + botState.mode.toUpperCase());
  res.json({ ok: true });
});

// Stop bot
app.post("/api/stop", (req, res) => {
  botState.running = false;
  if (botInterval) clearInterval(botInterval);
  log("INFO", "⏹️ ORACLE v2 stopped");
  sendTelegram("⏹️ *ORACLE v2 STOPPED*");
  res.json({ ok: true });
});

// Update config
app.post("/api/config", (req, res) => {
  const {
    mode,
    confidence_threshold,
    max_trade_size_sol,
    stop_loss_pct,
    take_profit_pct,
  } = req.body;
  if (mode) botState.mode = mode;
  if (confidence_threshold) botState.confidence_threshold = confidence_threshold;
  if (max_trade_size_sol) botState.max_trade_size_sol = max_trade_size_sol;
  if (stop_loss_pct) botState.stop_loss_pct = stop_loss_pct;
  if (take_profit_pct) botState.take_profit_pct = take_profit_pct;
  res.json({ ok: true, config: botState });
});

// Manual analyze
app.post("/api/analyze", async (req, res) => {
  const { mint } = req.body;
  if (!mint) return res.status(400).json({ error: "mint required" });
  const tokenData = await fetchTokenData(mint);
  if (!tokenData) return res.status(404).json({ error: "Token not found" });
  const analysis = await claudeAnalyze(tokenData);
  res.json({ tokenData, analysis });
});

// Reset paper balance
app.post("/api/reset-paper", (req, res) => {
  botState.paperBalance = 1.0;
  botState.trades = [];
  botState.activePositions = {};
  botState.tradeMemory = [];
  botState.stats = { total: 0, wins: 0, losses: 0, pnl_sol: 0, pnl_pct: 0 };
  botState.logs = [];
  res.json({ ok: true });
});

// Health check
app.get("/health", (req, res) => res.json({ status: "ok", version: "2.0" }));

// ── START SERVER ─────────────────────────────────────────────
app.listen(CONFIG.PORT, () => {
  console.log(`ORACLE v2 Backend running on port ${CONFIG.PORT}`);
  log("INFO", `ORACLE v2 backend ready on :${CONFIG.PORT}`);
});
