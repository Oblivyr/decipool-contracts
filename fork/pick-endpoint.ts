// Prints the fastest endpoint of a fork config that serves its pinned block, skipping nodes whose genesis
// doesn't match the "# genesis:" line (some providers serve another chain under a similar name).
//   bun fork/pick-endpoint.ts fork/polkadot-asset-hub.yml
import { readFileSync } from "fs";
const file = process.argv[2] || "fork/kusama-asset-hub.yml";
const yml = readFileSync(file, "utf8");
const block = Number(/^block:\s*(\d+)/m.exec(yml)?.[1]);
const endpoints = [...yml.matchAll(/^\s*-\s*(wss:\/\/\S+)/gm)].map((m) => m[1]);
const genesis = /^#\s*genesis:\s*(0x[0-9a-f]{64})/m.exec(yml)?.[1];
if (!block || !endpoints.length || !genesis) { console.error("no block, endpoints or # genesis: line in " + file); process.exit(1); }

function probe(url: string): Promise<number> {
  const t0 = Date.now();
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    const done = (e?: Error) => { clearTimeout(timer); try { ws.close(); } catch {} e ? rej(e) : res(Date.now() - t0); };
    const timer = setTimeout(() => done(new Error("timeout")), 20000);
    let step = 0;
    ws.onerror = () => done(new Error("connect"));
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "chain_getBlockHash", params: [0] }));
    ws.onmessage = (m) => {
      const j = JSON.parse(String(m.data));
      if (j.error || !j.result) return done(new Error(j.error?.message || "empty"));
      if (step === 0 && j.result !== genesis) return done(new Error("another chain (genesis " + String(j.result).slice(0, 10) + "…)"));
      if (step === 0) ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "chain_getBlockHash", params: [block] }));
      else if (step === 1) ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "state_getStorage", params: ["0x3a636f6465", j.result] }));
      else done(j.result.length > 1000 ? undefined : new Error("no code"));
      step++;
    };
  });
}
const results = await Promise.all(endpoints.map((u) => probe(u).then((ms) => ({ u, ms }), (e) => ({ u, ms: Infinity, e: e.message }))));
for (const r of results) console.error(`${r.u}: ${Number.isFinite(r.ms) ? r.ms + " ms" : "fail (" + (r as any).e + ")"}`);
const best = results.filter((r) => Number.isFinite(r.ms)).sort((a, b) => a.ms - b.ms)[0];
if (!best) process.exit(1);
console.log(best.u);
process.exit(0);
