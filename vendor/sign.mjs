/**
 * Signing transactions for a real chain, without a wallet library.
 *
 * The end-to-end test publishes through anvil's unlocked accounts, which is
 * enough to prove the pipeline but not enough to publish anywhere real. This
 * is the missing half: RLP, an EIP-1559 typed transaction, and a secp256k1
 * signature.
 *
 * Three places this is easy to get subtly wrong, each of which produces a
 * signature that is well-formed and simply belongs to the wrong account:
 *
 *   Minimal integers. RLP encodes numbers as big-endian byte strings with no
 *   leading zeros, and zero as the *empty* string rather than a zero byte.
 *   Encoding zero as 0x00 changes the hash, so the transaction is signed by an
 *   address that does not exist and the node rejects it for a bad nonce — an
 *   error that points nowhere near the cause.
 *
 *   yParity, not v. Typed transactions carry the raw recovery bit. Carrying
 *   over the legacy `27 + recovery` convention yields a signature that
 *   recovers to a different address, and the node reports "insufficient funds"
 *   for an account nobody has ever funded.
 *
 *   Signing the envelope. The hash is over `0x02 || rlp(payload)` — the type
 *   byte is inside the preimage. Hashing the RLP alone produces a valid
 *   signature over the wrong message.
 *
 * So `signTx` recovers the sender from its own signature before returning it.
 * Every one of the mistakes above is caught there, locally, instead of as a
 * confusing rejection from a node after money has moved.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";

const hex = (u8) => "0x" + [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (h) => {
  const s = (h || "").replace(/^0x/, "");
  if (!s.length) return new Uint8Array(0);
  const even = s.length % 2 ? "0" + s : s;
  return Uint8Array.from(even.match(/../g).map((x) => parseInt(x, 16)));
};
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/**
 * A number as RLP wants it: big-endian, no leading zeros, zero is empty.
 *
 * The empty-string encoding of zero is not an optimisation — it is the rule,
 * and it applies to nonce 0, value 0, and an empty `to` on a deploy.
 */
export function toMinimal(value) {
  let n = BigInt(value ?? 0);
  if (n < 0n) throw new Error("cannot RLP-encode a negative number");
  if (n === 0n) return new Uint8Array(0);
  let s = n.toString(16);
  if (s.length % 2) s = "0" + s;
  return unhex(s);
}

const lengthPrefix = (len, offset) => {
  if (len < 56) return Uint8Array.from([offset + len]);
  const lenBytes = toMinimal(len);
  return cat(Uint8Array.from([offset + 55 + lenBytes.length]), lenBytes);
};

/** RLP-encode a byte string or a (possibly nested) list of them. */
export function rlp(item) {
  if (Array.isArray(item)) {
    const body = cat(...item.map(rlp));
    return cat(lengthPrefix(body.length, 0xc0), body);
  }
  const bytes = item instanceof Uint8Array ? item : unhex(item);
  /* A single byte below 0x80 is its own encoding — prefixing it would be a
     different, longer, equally "valid-looking" encoding. */
  if (bytes.length === 1 && bytes[0] < 0x80) return bytes;
  return cat(lengthPrefix(bytes.length, 0x80), bytes);
}

/** The 20-byte address for a private key. */
export function addressOf(privateKey) {
  const pk = unhex(privateKey);
  const pub = secp256k1.getPublicKey(pk, false);   // uncompressed, 65 bytes
  /* Drop the 0x04 prefix before hashing; including it gives a plausible but
     entirely different address. */
  return hex(keccak_256(pub.subarray(1)).subarray(12));
}

/**
 * Sign an EIP-1559 transaction and return the raw bytes to broadcast.
 *
 * `to` omitted means a contract deployment, which RLP-encodes as the empty
 * string — the same encoding as zero, and for the same reason.
 */
export function signTx(tx, privateKey) {
  const {
    chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gas,
    to = null, value = 0, data = "0x", accessList = [],
  } = tx;

  if (chainId === undefined) throw new Error("chainId is required — without it the signature is replayable");

  const fields = [
    toMinimal(chainId),
    toMinimal(nonce),
    toMinimal(maxPriorityFeePerGas),
    toMinimal(maxFeePerGas),
    toMinimal(gas),
    to ? unhex(to) : new Uint8Array(0),
    toMinimal(value),
    unhex(data),
    accessList,
  ];

  const TYPE = Uint8Array.from([0x02]);
  const payload = rlp(fields);
  /* The type byte is part of the preimage. */
  const sighash = keccak_256(cat(TYPE, payload));

  const sig = secp256k1.sign(sighash, unhex(privateKey), { prehash: false });
  const r = toMinimal("0x" + sig.r.toString(16));
  const s = toMinimal("0x" + sig.s.toString(16));
  /* Typed transactions carry yParity (0 or 1), never the legacy 27/28. */
  const yParity = toMinimal(sig.recovery);

  const signed = cat(TYPE, rlp([...fields, yParity, r, s]));
  const hash = hex(keccak_256(signed));

  /* Recover before returning. If any of the three traps in the header has been
     tripped, this is where it surfaces — locally, with a clear message, rather
     than as a nonsensical rejection from a node. */
  const recovered = recoverSender(sighash, sig);
  const expected = addressOf(privateKey);
  if (recovered.toLowerCase() !== expected.toLowerCase()) {
    throw new Error("signature recovers to " + recovered + ", not " + expected +
                    " — the transaction would be signed by the wrong account");
  }

  return { raw: hex(signed), hash, from: expected };
}

/** The address that produced a signature over `sighash`. */
export function recoverSender(sighash, sig) {
  const pub = sig.recoverPublicKey(sighash).toBytes(false);
  return hex(keccak_256(pub.subarray(1)).subarray(12));
}

/**
 * A sender that signs locally and broadcasts, for chains with no unlocked
 * accounts — which is every real one.
 *
 * Nonces are tracked in memory across the run. Asking the node for the pending
 * nonce before each of several hundred sequential publishes is both slow and
 * unreliable: many nodes do not count a transaction as pending immediately, so
 * two writes get the same nonce and the second silently replaces the first.
 * The ROM then seals with a hole in it.
 */
export function signingSender({ rpc, privateKey, chainId, gasLimit = null, headroom = 1.25 }) {
  const from = addressOf(privateKey);
  let nonce = null;

  return async function send(tx) {
    if (nonce === null) {
      nonce = Number(BigInt(await rpc("eth_getTransactionCount", [from, "pending"])));
    }

    let gas = gasLimit;
    if (!gas) {
      try {
        const est = BigInt(await rpc("eth_estimateGas", [{ from, ...tx }]));
        gas = Number((est * BigInt(Math.round(headroom * 100))) / 100n);
      } catch {
        gas = 8_000_000;
      }
    }

    const base = BigInt(await rpc("eth_gasPrice", []));
    const raw = signTx({
      chainId,
      nonce,
      /* A flat multiple of the going rate. Fine for an L2 at a fraction of a
         gwei; revisit before ever pointing this at mainnet. */
      maxPriorityFeePerGas: base,
      maxFeePerGas: base * 2n,
      gas,
      to: tx.to || null,
      value: tx.value || 0,
      data: tx.data || "0x",
    }, privateKey);

    const hash = await rpc("eth_sendRawTransaction", [raw.raw]);
    nonce++;
    return hash;
  };
}
