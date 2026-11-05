// Modified from Birdbrain's decision-deposit (Apache-2.0) for Decipool, November 2026: adds the `factory` command.
// Deploy a pool or the pool factory from your EVM deployer key (keys/<net>-deployer.key), and record it in deployments/<net>.json.
// The deployer only pays the fee: the pool has no owner, so the key has no power over it.
//
//   bun deploy.ts <net> key
//   bun deploy.ts <net> pool <referendum> <deposit> <min> <deadline ISO> <label> [--mainnet]
//   bun deploy.ts <net> factory [--mainnet]
//   bun deploy.ts <net> preflight            (only the on-chain checks a factory deploy starts with)
//
// Amounts in whole units (KSM, DOT or PAS). Real-money networks (Kusama, Polkadot) need --mainnet. Then: bun verify.ts.
import { createPublicClient, createWalletClient, http, defineChain, encodeDeployData, type Abi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { NETWORKS, type Net } from "./networks";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { execFileSync } from "child_process";

const [net, cmd, ...a] = process.argv.slice(2) as [Net, string, ...string[]];
const N = NETWORKS[net];
if (!N) throw new Error("network: " + Object.keys(NETWORKS).join(" | "));
// Anything not marked test is real money.
const REAL = !("test" in N && N.test);
const KEYS = (process.env.KEYS ?? "keys") + "/";
const RECORD = new URL(`./deployments/${net}.json`, import.meta.url).pathname;
const chain = defineChain({ id: N.chainId, name: N.name, nativeCurrency: { name: N.symbol, symbol: N.symbol, decimals: 18 }, rpcUrls: { default: { http: [N.eth] } } });
const pub = createPublicClient({ chain, transport: http() });
type Artifact = { abi: Abi; bytecode: Hex; compiler: string };
const artifact = (name: string): Artifact => JSON.parse(readFileSync(new URL(`./build/${name}.json`, import.meta.url), "utf8"));
const art = artifact("DecisionDepositPool");

function key(name: string) {
  const f = KEYS + `${net}-${name}.key`;
  if (!existsSync(f)) writeFileSync(f, generatePrivateKey() + "\n", { mode: 0o600 });
  return privateKeyToAccount(readFileSync(f, "utf8").trim() as Hex);
}
const units = (x: string) => {
  const dp = String(N.planckPerUnit).length - 1;
  if (!new RegExp(`^\\d+(\\.\\d{1,${dp}})?$`).test(x)) throw new Error(`amount "${x}": whole ${N.symbol} with at most ${dp} decimals`);
  const [w, f = ""] = x.split(".");
  return BigInt(w) * N.planckPerUnit + BigInt(f.padEnd(dp, "0"));
};

// Check against the live chain: genesis, chain id, Referenda place/refund call indices taking one u32,
// and NativeToEthRatio. A wrong call index would make every pool dispatch the wrong call.
async function preflight() {
  const api = await ApiPromise.create({ provider: new WsProvider(N.ws), noInitWarn: true });
  try {
    const g = api.genesisHash.toHex();
    if (g !== N.genesis) throw new Error(`${N.ws} is not ${N.name} (genesis ${g})`);
    if ((await pub.getChainId()) !== N.chainId) throw new Error(`${N.eth} is not chain ${N.chainId}`);
    for (const [name, idx] of [["placeDecisionDeposit", N.place], ["refundDecisionDeposit", N.refund]] as const) {
      const m = (api.tx as any).referenda[name](0).method;
      const [p, c] = [m.callIndex[0], m.callIndex[1]];
      if (p !== N.referendaPallet || c !== idx) throw new Error(`referenda.${name} is [${p},${c}] on chain, networks.ts says [${N.referendaPallet},${idx}]`);
      const argTypes = m.meta.args.map((x: any) => x.type.toString());
      if (argTypes.length !== 1 || !/^(u32|ReferendumIndex)$/.test(argTypes[0])) throw new Error(`referenda.${name} takes (${argTypes}), the pool encodes one u32`);
    }
    const ratio = BigInt((api.consts as any).revive.nativeToEthRatio.toString());
    if (ratio !== N.weiPerPlanck) throw new Error(`Revive.NativeToEthRatio is ${ratio}, networks.ts says ${N.weiPerPlanck}`);
    console.log(`preflight on ${N.name}: genesis, chain id, Referenda calls [${N.referendaPallet},${N.place}] and [${N.referendaPallet},${N.refund}] (u32), NativeToEthRatio ${ratio}: all match`);
  } finally { await api.disconnect(); }
}

if (cmd === "preflight") {
  await preflight();
} else if (cmd === "key") {
  const names = REAL ? ["deployer"] : ["deployer", "alice", "bob"];
  for (const n of names) { const k = key(n); console.log(n, k.address, Number(await pub.getBalance({ address: k.address })) / 1e18, N.symbol); }
} else if (cmd === "pool") {
  const [ref, dep, min, deadlineIso, label] = a;
  if (REAL && !a.includes("--mainnet")) throw new Error(`${N.name} is real money: add --mainnet`);
  const deadline = BigInt(Math.floor(Date.parse(deadlineIso) / 1000));
  if (!deadline) throw new Error("deadline must be an ISO date");
  const args = [Number(ref), units(dep), units(min), deadline, N.referendaPallet, N.place, N.refund, N.weiPerPlanck] as const;
  console.log(`${N.name}: pool for #${ref}, deposit ${args[1]} planck, min ${args[2]}, deadline ${new Date(Number(deadline) * 1000).toISOString()}`);
  const deployer = key("deployer");
  const wallet = createWalletClient({ account: deployer, chain, transport: http() });
  const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args });
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (rc.status !== "success" || !rc.contractAddress) throw new Error("deploy failed " + hash);
  const r = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, "utf8")) : { network: net, pools: [], referenda: [] };
  r.pools.push({ label, address: rc.contractAddress, referendum: Number(ref), depositPlanck: String(args[1]), minPlanck: String(args[2]),
    fundingDeadline: Number(deadline), deployTx: hash, deployer: deployer.address, compiler: art.compiler,
    constructorArgs: encodeDeployData({ abi: art.abi, bytecode: "0x", args }).slice(2), at: new Date().toISOString() });
  writeFileSync(RECORD, JSON.stringify(r, null, 2) + "\n");
  console.log("pool", rc.contractAddress, "tx", hash);
  console.log(`next: bun verify.ts ${net} ${rc.contractAddress} ${r.pools.at(-1).constructorArgs}`);
} else if (cmd === "factory") {
  // Then set NETS.<net>.factory in decipool-app (page/src/config/networks.ts).
  if (REAL && !a.includes("--mainnet")) throw new Error(`${N.name} is real money: add --mainnet`);
  // Rebuild so the deployed code is the reviewed source.
  execFileSync("bun", [new URL("./compile.ts", import.meta.url).pathname], { stdio: "inherit" });
  const fart = artifact("DecisionDepositPoolFactory");
  const args = [N.referendaPallet, N.place, N.refund, N.weiPerPlanck] as const;
  await preflight();
  const deployer = key("deployer");
  if (REAL) {
    console.log(`\nAbout to deploy the pool factory on ${N.name} (REAL ${N.symbol}) from ${deployer.address},`);
    console.log(`with Referenda pallet ${N.referendaPallet}, place call ${N.place}, refund call ${N.refund}, weiPerPlanck ${N.weiPerPlanck}.`);
    if (prompt(`Type "deploy ${net}" to go on:`) !== `deploy ${net}`) throw new Error("not confirmed: nothing sent");
  }
  const wallet = createWalletClient({ account: deployer, chain, transport: http() });
  const hash = await wallet.deployContract({ abi: fart.abi, bytecode: fart.bytecode, args });
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (rc.status !== "success" || !rc.contractAddress) throw new Error("deploy failed " + hash);
  // Read the parameters back from the deployed contract.
  for (const [fn, want] of [["referendaPallet", N.referendaPallet], ["placeCallIndex", N.place], ["refundCallIndex", N.refund], ["weiPerPlanck", N.weiPerPlanck]] as const) {
    const got = await pub.readContract({ address: rc.contractAddress, abi: fart.abi, functionName: fn });
    if (BigInt(got as any) !== BigInt(want)) throw new Error(`deployed factory has ${fn} ${got}, expected ${want}: do not use it`);
  }
  console.log("read back from the deployed factory: parameters match");
  const r = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, "utf8")) : { network: net, pools: [], referenda: [] };
  // Keep earlier factories: their pools stay valid (NETS.<net>.pastFactories).
  if (r.factory) r.pastFactories = [r.factory, ...(r.pastFactories ?? [])];
  r.factory = { address: rc.contractAddress, deployTx: hash, deployer: deployer.address, compiler: fart.compiler,
    constructorArgs: encodeDeployData({ abi: fart.abi, bytecode: "0x", args }).slice(2), at: new Date().toISOString() };
  writeFileSync(RECORD, JSON.stringify(r, null, 2) + "\n");
  console.log("factory", rc.contractAddress, "tx", hash);
  console.log(`next: bun verify.ts ${net} ${rc.contractAddress} ${r.factory.constructorArgs} factory`);
  console.log(`then: set NETS.${net}.factory in page/config.js and move the previous one to NETS.${net}.pastFactories`);
} else console.log("usage: bun deploy.ts <kusama|polkadot|paseo> key | pool <ref> <deposit> <min> <deadlineISO> <label> [--mainnet] | factory [--mainnet]");
