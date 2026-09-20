// standalone rpcOver (Cloudflare-fronted RPCs need the Origin header)
export function rpcOver(endpoint, { headers = {}, attempts = 4 } = {}) {
  return async function rpc(method, params) {
    let last;
    for (let a = 0; a < attempts; a++) {
      try {
        const r = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        const text = await r.text();
        if (text.trim().startsWith("<")) throw new Error("RPC returned an HTML challenge page");
        const j = JSON.parse(text);
        if (j.error) throw new Error(j.error.message);
        return j.result;
      } catch (e) { last = e; if (a < attempts - 1) await new Promise((s) => setTimeout(s, 300 * 2 ** a)); }
    }
    throw new Error("rpc " + method + " failed: " + last.message);
  };
}
