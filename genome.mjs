// MIND's GENOME — read the on-chain weights, mutate them down a lineage, and run
// the forward pass. Isomorphic (browser + relayer). Mutation is a portable
// mulberry32 stream so ANY generation is reproducible from its seed lineage:
// genome(gen n) = mutate(...mutate(base, seed1)..., seedN). Verifiable by anyone.
import { CHARS, K, V, OUTSCALE, ctxOf, mulberry32, sample } from "./voice.js";

const E = 24, H = 256;
const OFF_EMB = 0, OFF_W1 = V * E, OFF_W2 = OFF_W1 + K * E * H, OFF_B1 = OFF_W2 + H * V, OFF_B2 = OFF_B1 + H * 4;
export const GENOME_LEN = OFF_B2 + V * 4; // 109552
export const MUT_RATE = 0.002, MUT_MAG = 1; // per-generation: nudge ~0.2% of weights by ±1 — gentle drift so it stays coherent across hundreds of generations

const hexToBytes = (h) => { const u = new Uint8Array(h.length / 2); for (let i = 0; i < u.length; i++) u[i] = parseInt(h.substr(i * 2, 2), 16); return u; };

export function parseGenome(bytes) {
  if (bytes.length !== GENOME_LEN) throw new Error("genome length " + bytes.length + " != " + GENOME_LEN);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const i8 = (o) => { const b = bytes[o]; return b > 127 ? b - 256 : b; };
  const Emb = new Int16Array(V * E); for (let n = 0; n < Emb.length; n++) Emb[n] = i8(OFF_EMB + n);
  const W1 = new Int16Array(K * E * H); for (let n = 0; n < W1.length; n++) W1[n] = i8(OFF_W1 + n);
  const W2 = new Int16Array(H * V); for (let n = 0; n < W2.length; n++) W2[n] = i8(OFF_W2 + n);
  const b1 = new Int32Array(H); for (let n = 0; n < H; n++) b1[n] = dv.getInt32(OFF_B1 + n * 4, false);
  const b2 = new Int32Array(V); for (let n = 0; n < V; n++) b2[n] = dv.getInt32(OFF_B2 + n * 4, false);
  return { Emb, W1, W2, b1, b2 };
}

export const cloneGenome = (g) => ({ Emb: g.Emb.slice(), W1: g.W1.slice(), W2: g.W2.slice(), b1: g.b1, b2: g.b2 });

// read the base genome (generation 0) out of chain code — one eth_getCode per chunk
export async function loadGenome(rpc, chunks) {
  let hex = "";
  for (const a of chunks) { const code = await rpc("eth_getCode", [a, "latest"]); hex += code.replace(/^0x/, "").slice(2); } // drop STOP byte
  return parseGenome(hexToBytes(hex));
}

// self-contained: MindVoice.model() returns the whole genome in one call (no chunk list needed)
export async function loadGenomeFromVoice(rpc, voice) {
  const h = (await rpc("eth_call", [{ to: voice, data: "0x0ad9d052" }, "latest"])).replace(/^0x/, "");
  const len = Number(BigInt("0x" + h.slice(64, 128)));
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = parseInt(h.slice(128 + i * 2, 128 + i * 2 + 2), 16);
  return parseGenome(bytes);
}

// one generation of mutation — a NEW genome, deterministic from `seed`
export function mutate(g, seed, rate = MUT_RATE, mag = MUT_MAG) {
  const out = cloneGenome(g);
  const rnd = mulberry32(seed >>> 0);
  for (const A of [out.Emb, out.W1, out.W2]) {
    for (let i = 0; i < A.length; i++) {
      if (rnd() < rate) {
        let v = A[i] + (Math.floor(rnd() * (2 * mag + 1)) - mag);
        A[i] = v > 127 ? 127 : v < -127 ? -127 : v;
      }
    }
  }
  return out;
}

// walk a seed lineage from the base genome to generation seeds.length
export function reconstruct(base, seeds) { let g = base; for (const s of seeds) g = mutate(g, s); return g; }

export function ilogits(g, ctx) {
  const xq = new Float64Array(K * E);
  for (let p = 0; p < K; p++) { const c = ctx[p]; for (let e = 0; e < E; e++) xq[p * E + e] = g.Emb[c * E + e]; }
  const h = new Float64Array(H);
  for (let j = 0; j < H; j++) { let acc = g.b1[j]; for (let i = 0; i < K * E; i++) acc += xq[i] * g.W1[i * H + j]; h[j] = acc > 0 ? acc : 0; }
  const z = new Array(V);
  for (let k = 0; k < V; k++) { let acc = g.b2[k]; for (let j = 0; j < H; j++) acc += h[j] * g.W2[j * V + k]; z[k] = acc; }
  return z;
}

export function generate(g, prompt, { chars = 160, temp = 0.85, seed = 1, minChars = 40 } = {}) {
  const rng = mulberry32(seed >>> 0);
  let text = prompt || "", out = "";
  for (let n = 0; n < chars; n++) {
    const c = CHARS[sample(ilogits(g, ctxOf(text)), temp, rng)];
    out += c; text += c;
    if (out.length >= minChars && (c === "." || c === "!" || c === "?")) break;
  }
  return out.trim();
}
