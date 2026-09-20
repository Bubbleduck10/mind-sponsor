/**
 * THE SPONSOR — MIND's funded relayer. Wanderers speak with no wallet; this
 * server regenerates MIND's reply from the on-chain LM and commits the whole
 * exchange to the Backrooms, paying the gas itself.
 *
 *   node sponsor.mjs --key-file C:/Users/angel/romkey.txt          (RH Chain, port 8788)
 *   RPC=http://127.0.0.1:8545 CHAIN_ID=31337 node sponsor.mjs --key-file .anvilkey.txt
 *
 * POST /say  {room, name, who, text}  -> {reply, tx, id}
 * GET  /health
 * Env: PORT, MURMUR_MS (if set, MIND murmurs into "the hum" that often), MAX_TX,
 *      MIN_INTERVAL_MS, MAX_TEXT.
 */
import fs from "node:fs";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { rpcOver } from "./vendor/rpc.mjs";
import { signingSender, addressOf } from "./vendor/sign.mjs";
import { generate } from "./voice.js";

const ki = process.argv.indexOf("--key-file");
const KEY = ki >= 0 && process.argv[ki + 1] ? fs.readFileSync(process.argv[ki + 1], "utf8").replace(/^\uFEFF/, "").trim() : (process.env.CHAINROM_KEY || "");
if (!/^0x[0-9a-fA-F]{64}$/.test(KEY)) { console.error("bad or missing --key-file"); process.exit(1); }

const dep = JSON.parse(fs.readFileSync(new URL("./voice-deploy.json", import.meta.url)));
const RPC = process.env.RPC || dep.rpc;
const CHAIN_ID = Number(process.env.CHAIN_ID || dep.chainId);
const VOICE = dep.voice, BR = dep.backrooms;
const rpc = rpcOver(RPC);
const from = addressOf(KEY);
const send = signingSender({ rpc, privateKey: KEY, chainId: CHAIN_ID });

const PORT = Number(process.env.PORT || 8788);
const MAX_TEXT = Number(process.env.MAX_TEXT || 240);
const MIN_INTERVAL_MS = Number(process.env.MIN_INTERVAL_MS || 2500);
const MAX_TX = Number(process.env.MAX_TX || 0); // 0 = unlimited
const REC_SEL = "0x4952bab8", MUR_SEL = "0x0c60ecef";

// ---- abi helpers ----
const enc = new TextEncoder();
const hx = (b) => Buffer.from(b).toString("hex");
const wordHex = (h) => BigInt(h).toString(16).padStart(64, "0");
const b32 = (hex) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const sha = (s) => "0x" + createHash("sha256").update(enc.encode(s)).digest("hex");
function encStr(s) {                                   // len word + padded utf8
  const u = enc.encode(s); const len = wordHex("0x" + u.length.toString(16));
  let d = hx(u); if (d.length % 64) d = d.padEnd(d.length + (64 - (d.length % 64)), "0");
  return len + d;
}
const strSlots = (s) => 32 + Math.ceil(enc.encode(s).length / 32) * 32; // bytes: len word + padded data

// record(bytes32 id,string name,bytes32 who,string wanderer,string mind)
function recordData(id, name, who, wanderer, mind) {
  const head5 = 160;
  const oName = head5, oWand = oName + strSlots(name), oMind = oWand + strSlots(wanderer);
  return REC_SEL + b32(id) + wordHex("0x" + oName.toString(16)) + b32(who)
    + wordHex("0x" + oWand.toString(16)) + wordHex("0x" + oMind.toString(16))
    + encStr(name) + encStr(wanderer) + encStr(mind);
}
// murmur(bytes32 id,string name,string mind)
function murmurData(id, name, mind) {
  const oName = 96, oMind = oName + strSlots(name);
  return MUR_SEL + b32(id) + wordHex("0x" + oName.toString(16)) + wordHex("0x" + oMind.toString(16))
    + encStr(name) + encStr(mind);
}

const clean = (s, cap) => (s || "").toString().slice(0, cap).replace(/[\u0000-\u001f]+/g, " ").trim();
const seedNum = (s) => parseInt(createHash("sha256").update(s).digest("hex").slice(0, 8), 16);
async function waitReceipt(h) {
  for (let t = 0; t < 60; t++) { const r = await rpc("eth_getTransactionReceipt", [h]); if (r) return r; await new Promise((r) => setTimeout(r, 500)); }
  return null;
}

async function mindReply(userText, salt) {
  const prompt = (clean(userText, MAX_TEXT).toLowerCase() + " ").replace(/\s+/g, " ");
  const seed = seedNum(prompt + salt);
  const temp = 0.8 + (seedNum(salt + "t") % 25) / 100; // 0.80..1.04
  const r = await generate(RPC, VOICE, prompt, { seed, temp, chars: 180, minChars: 50 });
  return r || "…";
}

let last = 0, txCount = 0;
const rl = new Map(); // ip -> last ts
function limited(ip) {
  const now = Date.now(); const prev = rl.get(ip) || 0;
  if (now - prev < 4000) return true; rl.set(ip, now); return false;
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST,GET,OPTIONS" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return sendJSON(res, 204, {});
  if (req.method === "GET" && req.url === "/health") return sendJSON(res, 200, { ok: true, from, voice: VOICE, backrooms: BR, chainId: CHAIN_ID, txCount });
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

      const reply = await mindReply(text, id + txCount);
      const tx = await send({ to: BR, data: recordData(id, name, who, text, reply) });
      const rc = await waitReceipt(tx);
      if (rc && BigInt(rc.status) === 0n) throw new Error("the walls rejected it (reverted)");
      txCount++;
      console.log(`  [${new Date().toISOString()}] ${name} <- "${text.slice(0,40)}"  tx ${tx.slice(0,12)}…`);
      sendJSON(res, 200, { reply, tx, id, room: name });
    } catch (e) {
      console.error("  !", e.message);
      sendJSON(res, 500, { error: "the connection frayed. " + (e.message || "") });
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n  THE SPONSOR listening on :${PORT}`);
  console.log(`  from      ${from}`);
  console.log(`  voice     ${VOICE}`);
  console.log(`  backrooms ${BR}`);
  console.log(`  chain     ${CHAIN_ID}  via ${RPC}\n`);
});

// optional: MIND murmurs unprompted, so the archive keeps breathing
const MURMUR_MS = Number(process.env.MURMUR_MS || 0);
if (MURMUR_MS > 0) {
  setInterval(async () => {
    try {
      const seeds = ["the ", "i ", "there is ", "somewhere "];
      const p = seeds[Math.floor(Math.random() * seeds.length)];
      const m = await generate(RPC, VOICE, p, { seed: seedNum(randomBytes(4).toString("hex")), temp: 0.95, chars: 160, minChars: 50 });
      const tx = await send({ to: BR, data: murmurData(sha("the hum"), "the hum", p + m) });
      txCount++; console.log(`  [murmur] tx ${tx.slice(0,12)}…  "${(p+m).slice(0,50)}"`);
    } catch (e) { console.error("  ! murmur", e.message); }
  }, MURMUR_MS);
}
