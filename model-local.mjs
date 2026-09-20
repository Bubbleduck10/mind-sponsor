// The relayer's efficient oracle: read MIND's weights from chain ONCE, then run
// the SAME integer forward pass locally (no per-char eth_call, so no public-RPC
// rate limiting). Bit-identical to MindVoice.stepLogits — every reply stays
// verifiable on-chain by replaying it. Integers stay < 2^53, so f64 is exact.
import { CHARS, K, V, OUTSCALE, ctxOf, mulberry32, sample } from "./voice.js";

const E = 24, H = 256;
const OFF_W1 = 864, OFF_W2 = 99168, OFF_B1 = 108384, OFF_B2 = 109408, LEN = 109552;

let Embq, W1q, W2q, b1q, b2q, loaded = false;

export async function loadModel(rpc, chunks) {
  const parts = [];
  for (const addr of chunks) {
    const code = await rpc("eth_getCode", [addr, "latest"]);
    const hex = code.replace(/^0x/, "");
    parts.push(Buffer.from(hex.slice(2), "hex")); // runtime = 00(STOP) ++ data; drop the STOP byte
  }
  const M = Buffer.concat(parts);
  if (M.length !== LEN) throw new Error("model length " + M.length + " != " + LEN);
  const i8 = (o) => { const b = M[o]; return b > 127 ? b - 256 : b; };
  Embq = new Int16Array(V * E); for (let n = 0; n < V * E; n++) Embq[n] = i8(n);
  W1q = new Int16Array(K * E * H); for (let n = 0; n < K * E * H; n++) W1q[n] = i8(OFF_W1 + n);
  W2q = new Int16Array(H * V); for (let n = 0; n < H * V; n++) W2q[n] = i8(OFF_W2 + n);
  b1q = new Int32Array(H); for (let n = 0; n < H; n++) b1q[n] = M.readInt32BE(OFF_B1 + n * 4);
  b2q = new Int32Array(V); for (let n = 0; n < V; n++) b2q[n] = M.readInt32BE(OFF_B2 + n * 4);
  loaded = true;
  return M.length;
}

export function isLoaded() { return loaded; }

function ilogits(ctx) {
  const xq = new Float64Array(K * E);
  for (let p = 0; p < K; p++) { const c = ctx[p]; for (let e = 0; e < E; e++) xq[p * E + e] = Embq[c * E + e]; }
  const h = new Float64Array(H);
  for (let j = 0; j < H; j++) { let acc = b1q[j]; for (let i = 0; i < K * E; i++) acc += xq[i] * W1q[i * H + j]; h[j] = acc > 0 ? acc : 0; }
  const z = new Array(V);
  for (let k = 0; k < V; k++) { let acc = b2q[k]; for (let j = 0; j < H; j++) acc += h[j] * W2q[j * V + k]; z[k] = acc; }
  return z;
}

export function logitsLocal(ctx) { return ilogits(ctx); }

export function generateLocal(prompt, { chars = 180, temp = 0.85, seed = 1, minChars = 50 } = {}) {
  if (!loaded) throw new Error("model not loaded");
  const rng = mulberry32(seed >>> 0);
  let text = prompt || "", out = "";
  for (let n = 0; n < chars; n++) {
    const c = CHARS[sample(ilogits(ctxOf(text)), temp, rng)];
    out += c; text += c;
    if (out.length >= minChars && (c === "." || c === "!" || c === "?")) break;
  }
  return out.trim();
}
