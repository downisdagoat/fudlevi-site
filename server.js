// MOOLANA HQ — tokenomics + holder snapshot server
// Deploy target: Railway (respects PORT). Node 18+ (global fetch).

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- config ----------
const PORT = process.env.PORT || 3000;
const MINT = process.env.MINT_ADDRESS || "2KQAKeDZfbmRXznrwB3bthEuasgjpNpjrTv8zgAYpump";
const HELIUS_KEY = process.env.HELIUS_API_KEY || "";
const RPC_URL =
  process.env.RPC_URL ||
  (HELIUS_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`
    : "https://api.mainnet-beta.solana.com");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- rpc helpers ----------
let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`RPC error: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

// ---------- tokenomics ----------
async function getSupply() {
  const r = await rpc("getTokenSupply", [MINT]);
  return {
    amount: r.value.amount,
    decimals: r.value.decimals,
    uiAmount: r.value.uiAmount,
  };
}

async function getTopHolders() {
  const r = await rpc("getTokenLargestAccounts", [MINT]);
  return r.value.map((a) => ({
    tokenAccount: a.address,
    uiAmount: a.uiAmount,
  }));
}

async function getMarket() {
  // DexScreener public API — no key needed
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${MINT}`);
    if (!res.ok) return null;
    const j = await res.json();
    const pairs = (j.pairs || []).sort(
      (a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
    );
    const p = pairs[0];
    if (!p) return null;
    return {
      priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
      marketCap: p.marketCap || p.fdv || null,
      liquidityUsd: p.liquidity?.usd || null,
      volume24h: p.volume?.h24 || null,
      priceChange24h: p.priceChange?.h24 ?? null,
      dex: p.dexId,
      pairUrl: p.url,
    };
  } catch {
    return null;
  }
}

app.get("/api/tokenomics", async (_req, res) => {
  try {
    const [supply, top, market] = await Promise.all([
      getSupply(),
      getTopHolders().catch(() => []),
      getMarket(),
    ]);
    const totalUi = supply.uiAmount || 0;
    const topWithPct = top.map((t) => ({
      ...t,
      pct: totalUi ? (t.uiAmount / totalUi) * 100 : 0,
    }));
    const top10pct = topWithPct.slice(0, 10).reduce((s, t) => s + t.pct, 0);
    res.json({ mint: MINT, supply, market, topHolders: topWithPct, top10pct });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------- full holder scan ----------
async function scanHoldersHelius() {
  // Helius DAS getTokenAccounts — paginated, reliable for full holder lists
  const holders = new Map(); // owner -> raw amount (BigInt)
  let cursor = undefined;
  let decimals = null;
  for (let page = 0; page < 200; page++) {
    const params = { mint: MINT, limit: 1000 };
    if (cursor) params.cursor = cursor;
    const r = await rpc("getTokenAccounts", params);
    const accounts = r.token_accounts || [];
    for (const a of accounts) {
      const amt = BigInt(a.amount || 0);
      if (amt === 0n) continue;
      holders.set(a.owner, (holders.get(a.owner) || 0n) + amt);
    }
    if (!r.cursor || accounts.length === 0) break;
    cursor = r.cursor;
  }
  if (decimals === null) {
    const s = await getSupply();
    decimals = s.decimals;
  }
  return { holders, decimals };
}

async function scanHoldersRpc() {
  // Generic fallback: getProgramAccounts filtered by mint (blocked on some public RPCs)
  const result = await rpc("getProgramAccounts", [
    TOKEN_PROGRAM,
    {
      encoding: "jsonParsed",
      filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: MINT } }],
    },
  ]);
  const holders = new Map();
  let decimals = null;
  for (const acc of result) {
    const info = acc.account?.data?.parsed?.info;
    if (!info) continue;
    const amt = BigInt(info.tokenAmount?.amount || 0);
    decimals = info.tokenAmount?.decimals ?? decimals;
    if (amt === 0n) continue;
    holders.set(info.owner, (holders.get(info.owner) || 0n) + amt);
  }
  if (decimals === null) {
    const s = await getSupply();
    decimals = s.decimals;
  }
  return { holders, decimals };
}

async function scanHolders() {
  if (HELIUS_KEY) {
    try {
      return await scanHoldersHelius();
    } catch (e) {
      console.warn("Helius scan failed, falling back to RPC:", e.message);
    }
  }
  return await scanHoldersRpc();
}

function holdersToList(holders, decimals) {
  const div = 10 ** decimals;
  return [...holders.entries()]
    .map(([owner, raw]) => ({ owner, amount: raw.toString(), uiAmount: Number(raw) / div }))
    .sort((a, b) => b.uiAmount - a.uiAmount);
}

// ---------- snapshots ----------
function snapshotFiles() {
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.startsWith("snapshot-") && f.endsWith(".json"))
    .sort()
    .reverse();
}

app.post("/api/snapshot", async (_req, res) => {
  try {
    const t0 = Date.now();
    const { holders, decimals } = await scanHolders();
    const list = holdersToList(holders, decimals);
    const takenAt = new Date().toISOString();
    const id = takenAt.replace(/[:.]/g, "-");
    const snap = {
      id,
      takenAt,
      mint: MINT,
      decimals,
      holderCount: list.length,
      scanMs: Date.now() - t0,
      holders: list,
    };
    fs.writeFileSync(path.join(DATA_DIR, `snapshot-${id}.json`), JSON.stringify(snap));
    res.json({ id, takenAt, holderCount: list.length, scanMs: snap.scanMs });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/snapshots", (_req, res) => {
  const out = snapshotFiles().map((f) => {
    const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f)));
    return { id: j.id, takenAt: j.takenAt, holderCount: j.holderCount };
  });
  res.json(out);
});

function loadSnapshot(id) {
  const file = path.join(DATA_DIR, `snapshot-${id}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file));
}

app.get("/api/snapshots/:id", (req, res) => {
  const snap = loadSnapshot(req.params.id);
  if (!snap) return res.status(404).json({ error: "Snapshot not found" });
  res.json(snap);
});

// CSV export, with optional min-balance filter: /api/snapshots/:id/csv?min=1000
app.get("/api/snapshots/:id/csv", (req, res) => {
  const snap = loadSnapshot(req.params.id);
  if (!snap) return res.status(404).json({ error: "Snapshot not found" });
  const min = Number(req.query.min || 0);
  const rows = snap.holders.filter((h) => h.uiAmount >= min);
  const csv =
    "wallet,balance\n" + rows.map((h) => `${h.owner},${h.uiAmount}`).join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="moolana-${snap.id}${min ? `-min${min}` : ""}.csv"`
  );
  res.send(csv);
});

// Compare a snapshot against holders now: still-holding = airdrop eligible ("held before AND held through")
app.get("/api/snapshots/:id/compare", async (req, res) => {
  try {
    const snap = loadSnapshot(req.params.id);
    if (!snap) return res.status(404).json({ error: "Snapshot not found" });
    const { holders, decimals } = await scanHolders();
    const now = holdersToList(holders, decimals);
    const nowMap = new Map(now.map((h) => [h.owner, h.uiAmount]));
    const stillHolding = [];
    const exited = [];
    for (const h of snap.holders) {
      const cur = nowMap.get(h.owner) || 0;
      if (cur > 0) stillHolding.push({ owner: h.owner, then: h.uiAmount, now: cur });
      else exited.push({ owner: h.owner, then: h.uiAmount });
    }
    const newHolders = now.filter((h) => !snap.holders.some((s) => s.owner === h.owner)).length;
    res.json({
      snapshotId: snap.id,
      takenAt: snap.takenAt,
      stillHoldingCount: stillHolding.length,
      exitedCount: exited.length,
      newHolderCount: newHolders,
      stillHolding,
      exited,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/config", (_req, res) => {
  res.json({ mint: MINT, rpcConfigured: RPC_URL !== "https://api.mainnet-beta.solana.com", helius: !!HELIUS_KEY });
});

app.listen(PORT, () => {
  console.log(`MOOLANA HQ running on :${PORT}`);
  console.log(`Mint: ${MINT}`);
  console.log(`RPC: ${HELIUS_KEY ? "Helius" : RPC_URL}`);
});
