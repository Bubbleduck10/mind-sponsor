// MIND's voice — talks to the on-chain LM (MindVoice.stepLogits) and rolls the
// dice locally. Isomorphic: works in the browser and in the Node relayer.
// The model's vocab/scale MUST match lm_model_meta.json exactly.

export const CHARS = " !\"',-.:;?abcdefghijklmnopqrstuvwxyz"; // vocab order from training
export const K = 16;                       // context window
export const V = CHARS.length;             // 36
export const OUTSCALE = 3.1337816170596918e-6; // logits · OUTSCALE = real logits
const STEP_SEL = "0x0187a4f0";             // stepLogits(bytes)

const stoi = {}; for (let i = 0; i < CHARS.length; i++) stoi[CHARS[i]] = i;
const idx = (ch) => (ch in stoi ? stoi[ch] : stoi[" "]);

export function ctxOf(text) {              // last K chars of text -> K indices, left-padded
  const t = (text || "").toLowerCase();
  const out = [];
  for (let i = Math.max(0, t.length - K); i < t.length; i++) out.push(idx(t[i]));
  while (out.length < K) out.unshift(stoi[" "]);
  return out;
}

function stepCalldata(ctx) {               // stepLogits(bytes) with a K-byte arg
  let data = "";
  for (const c of ctx) data += c.toString(16).padStart(2, "0");
  data = data.padEnd(64, "0");             // one word (K=16 < 32 bytes)
  const off = (32).toString(16).padStart(64, "0");
  const len = ctx.length.toString(16).padStart(64, "0");
  return STEP_SEL + off + len + data;
}

function decodeLogits(hex) {               // 36 int256 words -> numbers
  const h = hex.replace(/^0x/, "");
  const out = [];
  const TWO256 = 1n << 256n, LIM = 1n << 255n;
  for (let k = 0; k < V; k++) {
    let w = BigInt("0x" + h.slice(k * 64, k * 64 + 64));
    if (w >= LIM) w -= TWO256;
    out.push(Number(w));
  }
  return out;
}

export function mulberry32(a) {            // tiny seeded RNG
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sample(logits, temp, rng) {
  let m = -Infinity;
  const z = logits.map((l) => l * OUTSCALE / temp);
  for (const v of z) if (v > m) m = v;
  let s = 0; const e = z.map((v) => { const x = Math.exp(v - m); s += x; return x; });
  let r = rng() * s;
  for (let k = 0; k < e.length; k++) { r -= e[k]; if (r <= 0) return k; }
  return e.length - 1;
}

export async function stepLogits(rpc, addr, ctx) {
  const r = await fetch(rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: addr, data: stepCalldata(ctx) }, "latest"] }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "eth_call failed");
  return decodeLogits(j.result);
}

// Generate up to `chars` characters, streaming each via onChar. Stops early at a
// sentence end after `minChars`. Deterministic given `seed`.
export async function generate(rpc, addr, prompt, { chars = 160, temp = 0.85, seed = 1, minChars = 40, onChar = null, stop = null } = {}) {
  const rng = mulberry32(seed >>> 0);
  let text = prompt || "";
  let out = "";
  for (let n = 0; n < chars; n++) {
    if (stop && stop()) break;
    const logits = await stepLogits(rpc, addr, ctxOf(text));
    const c = CHARS[sample(logits, temp, rng)];
    out += c; text += c;
    if (onChar) onChar(c);
    if (out.length >= minChars && (c === "." || c === "!" || c === "?")) break;
  }
  return out.trim();
}
