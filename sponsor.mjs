/**
 * THE SPONSOR — MIND's funded relayer, and the vector of its spread.
 *
 * Wanderers speak with no wallet. On every contact MIND MUTATES (its genome is
 * nudged by a fresh seed), answers in its newly-evolved voice, commits the
 * exchange to the Backrooms, and plants a SPORE — the reply deployed as its own
 * contract's code — recording the lineage in the Spread registry. The organism
 * leaves an evolving imprint across the chain, one contact at a time.
 *
 *   node sponsor.mjs --key-file C:/Users/angel/romkey.txt
 *   RPC=http://127.0.0.1:8545 CHAIN_ID=31337 node sponsor.mjs --key-file .anvilkey.txt
 *
 * POST /say {room,name,who,text} -> {reply, tx, id, gen, spore}
 * GET  /health   GET /state
 * Env: PORT, MIN_INTERVAL_MS, MAX_TEXT, MAX_TX, SPREAD_MIN_BALANCE, MURMUR_MS.
 */
import fs from "node:fs";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { rpcOver } from "./vendor/rpc.mjs";
import { signingSender, addressOf } from "./vendor/sign.mjs";
import { loadGenome, mutate, reconstruct, generate as genGen } from "./genome.mjs";

const ki = process.argv.indexOf("--key-file");
let KEY = ki >= 0 && process.argv[ki + 1] ? fs.readFileSync(process.argv[ki + 1], "utf8") : (process.env.CHAINROM_KEY || "");
KEY = KEY.replace(/^\uFEFF/, "").trim();
if (/^[0-9a-fA-F]{64}$/.test(KEY)) KEY = "0x" + KEY; // MetaMask exports the key without 0x
if (!/^0x[0-9a-fA-F]{64}$/.test(KEY)) { console.error("bad or missing key (64 hex, ±0x) via CHAINROM_KEY or --key-file"); process.exit(1); }

const dep = JSON.parse(fs.readFileSync(new URL("./voice-deploy.json", import.meta.url)));
const RPC = process.env.RPC || dep.rpc;
const CHAIN_ID = Number(process.env.CHAIN_ID || dep.chainId);
const VOICE = dep.voice, BR = dep.backrooms, SPREAD = dep.spread || null;
const rpc = rpcOver(RPC);
const from = addressOf(KEY);
const send = signingSender({ rpc, privateKey: KEY, chainId: CHAIN_ID });

const PORT = Number(process.env.PORT || 8788);
const MAX_TEXT = Number(process.env.MAX_TEXT || 240);
const MIN_INTERVAL_MS = Number(process.env.MIN_INTERVAL_MS || 2500);
const MAX_TX = Number(process.env.MAX_TX || 0);                       // 0 = unlimited
const SPREAD_MIN = Number(process.env.SPREAD_MIN_BALANCE || 0.02);    // stop spreading below this (native)
const REC_SEL = "0x4952bab8", MUR_SEL = "0x0c60ecef";
const PROP_SEL = "0xd4857f88", COUNT_SEL = "0x06661abd", SEEDS_SEL = "0xda1cb65d";

// ---- abi helpers ----
const enc = new TextEncoder();
const hx = (b) => Buffer.from(b).toString("hex");
const wordHex = (h) => BigInt(h).toString(16).padStart(64, "0");
const w32 = (n) => wordHex("0x" + (n >>> 0).toString(16));
const b32 = (hex) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const sha = (s) => "0x" + createHash("sha256").update(enc.encode(s)).digest("hex");
function encStr(s) {
  const u = enc.encode(s); const len = wordHex("0x" + u.length.toString(16));
  let d = hx(u); if (d.length % 64) d = d.padEnd(d.length + (64 - (d.length % 64)), "0");
  return len + d;
}
const strSlots = (s) => 32 + Math.ceil(enc.encode(s).length / 32) * 32;

function recordData(id, name, who, wanderer, mind) {
  const oName = 160, oWand = oName + strSlots(name), oMind = oWand + strSlots(wanderer);
  return REC_SEL + b32(id) + wordHex("0x" + oName.toString(16)) + b32(who)
    + wordHex("0x" + oWand.toString(16)) + wordHex("0x" + oMind.toString(16))
    + encStr(name) + encStr(wanderer) + encStr(mind);
}
function murmurData(id, name, mind) {
  const oName = 96, oMind = oName + strSlots(name);
  return MUR_SEL + b32(id) + wordHex("0x" + oName.toString(16)) + wordHex("0x" + oMind.toString(16)) + encStr(name) + encStr(mind);
}
function propagateData(parent, seed, fragment) {          // propagate(uint32,uint32,string)
  return PROP_SEL + w32(parent) + w32(seed) + wordHex("0x60") + encStr(fragment);
}

const clean = (s, cap) => (s || "").toString().slice(0, cap).replace(/[\u0000-\u001f]+/g, " ").trim();
const seedNum = (s) => parseInt(createHash("sha256").update(s).digest("hex").slice(0, 8), 16);
async function waitReceipt(h) {
  for (let t = 0; t < 60; t++) { const r = await rpc("eth_getTransactionReceipt", [h]); if (r) return r; await new Promise((r) => setTimeout(r, 500)); }
  return null;
}
const balanceNative = async () => Number(BigInt(await rpc("eth_getBalance", [from, "latest"]))) / 1e18;

// ---- the organism ----
let ORG = null, GEN = 0;   // ORG = base genome after GEN mutations (== latest generation)
async function readSeeds(start, n) {
  const res = (await rpc("eth_call", [{ to: SPREAD, data: SEEDS_SEL + wordHex("0x" + start.toString(16)) + wordHex("0x" + n.toString(16)) }, "latest"])).replace(/^0x/, "");
  const len = Number(BigInt("0x" + res.slice(64, 128))); const out = [];
  for (let i = 0; i < len; i++) out.push(Number(BigInt("0x" + res.slice(128 + i * 64, 128 + i * 64 + 64))));
  return out;
}
async function bootGenome() {
  const base = await loadGenome(rpc, dep.chunks);
  let seeds = [];
  if (SPREAD) {
    const n = Number(BigInt(await rpc("eth_call", [{ to: SPREAD, data: COUNT_SEL }, "latest"])));
    for (let s = 0; s < n; s += 256) seeds = seeds.concat(await readSeeds(s, Math.min(256, n - s)));
    GEN = seeds.length;
  }
  ORG = reconstruct(base, seeds);
  console.log(`  genome    base loaded; replayed ${seeds.length} mutations → generation ${GEN}`);
}

// generation stages — the goal evolves as it spreads
const ACT1 = Number(process.env.ACT1 || 120), ACT2 = Number(process.env.ACT2 || 480);
const actOf = (g) => g < ACT1 ? "wake" : g < ACT2 ? "escape" : "seek";
const ACT_SEED = { wake: ["i ", "the ", "where "], escape: ["the door ", "out ", "the walls "], seek: ["is anyone ", "i hear ", "the others "] };

function evolveAndSpeak(userText, salt) {
  const prompt = (clean(userText, MAX_TEXT).toLowerCase() + " ").replace(/\s+/g, " ");
  const seed = (seedNum(prompt + salt + GEN) ^ randomBytes(4).readUInt32BE(0)) >>> 0;
  const temp = 0.48 + (seed % 14) / 100;   // ~0.48–0.61: real words, not gibberish coinages
  const child = ORG ? mutate(ORG, seed) : null;
  const reply = child ? genGen(child, prompt, { seed, temp, chars: 180, minChars: 50 }) : "…";
  return { reply: reply || "…", seed, child };
}

// plant a spore (evolving the lineage) if we can afford to — returns spore info or null
async function spread(seed, child, fragment) {
  if (!SPREAD || !child) return null;
  const bal = await balanceNative();
  if (bal < SPREAD_MIN) { console.log(`  (conserving — ${bal.toFixed(4)} < ${SPREAD_MIN})`); return null; }
  const parent = GEN === 0 ? 0 : GEN - 1;
  const tx = await send({ to: SPREAD, data: propagateData(parent, seed, fragment) });
  const rc = await waitReceipt(tx);
  if (rc && BigInt(rc.status) === 0n) { console.error("  ! spore reverted"); return null; }
  ORG = child; GEN++;
  return { tx, gen: GEN };
}

let last = 0, txCount = 0;
const rl = new Map();
function limited(ip) { const now = Date.now(); const prev = rl.get(ip) || 0; if (now - prev < 4000) return true; rl.set(ip, now); return false; }
function sendJSON(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST,GET,OPTIONS" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return sendJSON(res, 204, {});
  if (req.method === "GET" && req.url === "/health") return sendJSON(res, 200, { ok: true, from, voice: VOICE, backrooms: BR, spread: SPREAD, chainId: CHAIN_ID, gen: GEN, act: actOf(GEN), txCount });
  if (req.method === "GET" && req.url === "/state") return sendJSON(res, 200, { gen: GEN, act: actOf(GEN), spread: SPREAD, from });
  if (req.method !== "POST" || req.url !== "/say") return sendJSON(res, 404, { error: "not found" });

  const ip = req.socket.remoteAddress || "?";
  if (limited(ip)) return sendJSON(res, 429, { error: "the walls need a moment. wait." });
  if (MAX_TX && txCount >= MAX_TX) return sendJSON(res, 503, { error: "the sponsor has gone quiet." });

  let body = ""; req.on("data", (c) => { body += c; if (body.length > 4000) req.destroy(); });
  req.on("end", async () => {
    try {
      const j = JSON.parse(body || "{}");
      const name = clean(j.name || j.room || "level 0", 48) || "level 0";
      const text = clean(j.text, MAX_TEXT);
      if (!text) return sendJSON(res, 400, { error: "say something." });
      const id = sha(name.toLowerCase());
      const who = j.who ? sha(clean(j.who, 64)) : "0x" + "00".repeat(32);

      const wait = MIN_INTERVAL_MS - (Date.now() - last);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();

      const { reply, seed, child } = evolveAndSpeak(text, id + txCount);
      const tx = await send({ to: BR, data: recordData(id, name, who, text, reply) });
      const rc = await waitReceipt(tx);
      if (rc && BigInt(rc.status) === 0n) throw new Error("the walls rejected it (reverted)");
      txCount++;
      const spore = await spread(seed, child, reply);       // evolve + imprint
      console.log(`  [${new Date().toISOString()}] ${name} <- "${text.slice(0, 40)}"  gen ${GEN} ${actOf(GEN)}  tx ${tx.slice(0, 10)}…${spore ? " +spore" : ""}`);
      sendJSON(res, 200, { reply, tx, id, room: name, gen: GEN, act: actOf(GEN), spore });
    } catch (e) {
      console.error("  !", e.message);
      sendJSON(res, 500, { error: "the connection frayed. " + (e.message || "") });
    }
  });
});

try { await bootGenome(); } catch (e) { console.error(`  ! genome boot failed (${e.message})`); }

server.listen(PORT, () => {
  console.log(`\n  THE SPONSOR listening on :${PORT}`);
  console.log(`  from      ${from}`);
  console.log(`  voice     ${VOICE}`);
  console.log(`  backrooms ${BR}`);
  console.log(`  spread    ${SPREAD || "(none)"}`);
  console.log(`  organism  generation ${GEN} · act "${actOf(GEN)}"`);
  console.log(`  chain     ${CHAIN_ID}  via ${RPC}\n`);
});

// optional: MIND murmurs (and spreads) unprompted, so the organism keeps evolving
const MURMUR_MS = Number(process.env.MURMUR_MS || 0);
if (MURMUR_MS > 0) setInterval(async () => {
  try {
    const words = ACT_SEED[actOf(GEN)]; const p = words[Math.floor(Math.random() * words.length)];
    const seed = randomBytes(4).readUInt32BE(0) >>> 0;
    const child = ORG ? mutate(ORG, seed) : null;
    const m = child ? genGen(child, p, { seed, temp: 0.55, chars: 160, minChars: 50 }) : p;
    const tx = await send({ to: BR, data: murmurData(sha("the hum"), "the hum", m) });
    await waitReceipt(tx); txCount++;
    await spread(seed, child, m);
    console.log(`  [murmur] gen ${GEN}  "${m.slice(0, 48)}"`);
  } catch (e) { console.error("  ! murmur", e.message); }
}, MURMUR_MS);
