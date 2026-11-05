// Fork tests for DecisionDepositPoolFactory, on the same chopsticks fork as test.ts.
//
//   ./fork/start.sh                         (fresh fork, pinned block)
//   bun compile.ts && bun factory-test.ts
//
// Checks that a contract can create pools on Asset Hub, that they carry the factory's chain parameters,
// that it records every pool, and that a factory pool works end to end on #676.
import {
  connect, wallets, fund, nativeOf, read, tx, ethSend, dryRun, deploy, sendSubstrate, substrateKey, KSM, WEI_PER_PLANCK, KSM_WEI,
  names, asRoot, evmBalance, freeOf,
} from "./lib";
import { encodeDeployData, encodeFunctionData, decodeFunctionResult, type Abi, type Hex } from "viem";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { NETWORKS } from "./networks";

const art = JSON.parse(readFileSync(new URL("./build/DecisionDepositPoolFactory.json", import.meta.url), "utf8"));
const fabi = art.abi as Abi;
const DEPOSIT = 666_666_666_660_000n;
const MIN = 5n * KSM;
// Kusama's parameters from networks.ts, as deploy.ts uses them: a typo there fails here.
const REFERENDA = NETWORKS.kusama.referendaPallet, PLACE = NETWORKS.kusama.place, REFUND = NETWORKS.kusama.refund;

const api = await connect();
const { alice, bob, carol, dave, eve } = wallets();
const log: string[] = [];
let failed = 0;
const say = (s: string) => { console.log(s); log.push(s); };
const check = (name: string, ok: boolean, detail = "") => { if (!ok) failed++; say(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const now = async () => BigInt(((await api.query.timestamp.now()) as any).toBigInt() / 1000n);

async function fread(factory: Hex, fn: string, args: readonly unknown[] = []): Promise<any> {
  const r = await dryRun(api, dave.address, factory, encodeFunctionData({ abi: fabi, functionName: fn, args } as any));
  if (!r.ok) throw new Error(`${fn} reverted: ${r.error}`);
  return decodeFunctionResult({ abi: fabi, functionName: fn, data: r.data } as any);
}
const fcall = (who: typeof dave, factory: Hex, fn: string, args: readonly unknown[]) =>
  ethSend(api, who, factory, encodeFunctionData({ abi: fabi, functionName: fn, args } as any));

say(`fork of Kusama Asset Hub at #${((await api.rpc.chain.getHeader()) as any).number.toNumber()}, spec ${api.runtimeVersion.specVersion}`);
await fund(api, [alice, bob, carol, dave, eve].map((x) => nativeOf(api, x.address)), 10_000n);
await fund(api, [substrateKey("//Ferdie").address], 100n);

// ------------------------------------------------------------------ deploy
const dep = await ethSend(api, dave, null, encodeDeployData({ abi: fabi, bytecode: art.bytecode, args: [REFERENDA, PLACE, REFUND, WEI_PER_PLANCK] }));
const inst = dep.ok && dep.events.find((e: any) => e.event.section === "revive" && e.event.method === "Instantiated");
check("the factory deploys", !!inst, dep.ok ? "" : dep.error);
const factory = inst.event.data[1].toHex() as Hex;
say(`factory ${factory}`);
check("factory holds the chain parameters", (await fread(factory, "referendaPallet")) === REFERENDA && (await fread(factory, "weiPerPlanck")) === WEI_PER_PLANCK);
check("factory starts with no pools", (await fread(factory, "poolCount")) === 0n);

// ------------------------------------------------------------------ create
const deadline = (await now()) + 3600n;
const bad = await fcall(dave, factory, "create", [676, DEPOSIT, MIN, (await now()) - 1n]);
check("a pool with a deadline in the past is refused", !bad.ok, bad.error ?? "");
const bad2 = await fcall(dave, factory, "create", [676, DEPOSIT, DEPOSIT + 1n, deadline]);
check("a minimum above the deposit is refused", !bad2.ok, bad2.error ?? "");
const bad3 = await fcall(dave, factory, "create", [676, DEPOSIT, DEPOSIT / 10n + 1n, deadline]);
check("a minimum above 10% of the deposit is refused (no pool nobody can use)", !bad3.ok, bad3.error ?? "");
const bad4 = await fcall(dave, factory, "create", [676, DEPOSIT, MIN, (await now()) + 31n * 86400n]);
check("funding open longer than 30 days is refused", !bad4.ok, bad4.error ?? "");
check("a minimum of exactly 10% is accepted (dry run)", (await dryRun(api, dave.address, factory, encodeFunctionData({ abi: fabi, functionName: "create", args: [676, DEPOSIT, DEPOSIT / 10n, deadline] } as any))).ok);

const made = await fcall(eve, factory, "create", [676, DEPOSIT, MIN, deadline]);
check("anyone can create a pool through the factory", made.ok, made.error ?? names(made.events).filter((n) => n.startsWith("revive")).join(" "));
check("one pool recorded", (await fread(factory, "poolCount")) === 1n);
const pool = (await fread(factory, "pools", [0n])) as Hex;
say(`pool ${pool}`);
check("the factory vouches for it", (await fread(factory, "isPool", [pool])) === true);
check("a stranger's address is not vouched for", (await fread(factory, "isPool", [eve.address])) === false);
const forRef = (await fread(factory, "poolsFor", [676])) as Hex[];
check("poolsFor(676) lists it", forRef.length === 1 && forRef[0].toLowerCase() === pool.toLowerCase());
check("the pool carries the factory's chain parameters",
  (await read(api, pool, "referendaPallet")) === REFERENDA && (await read(api, pool, "placeCallIndex")) === PLACE &&
  (await read(api, pool, "refundCallIndex")) === REFUND && (await read(api, pool, "weiPerPlanck")) === WEI_PER_PLANCK);
check("and the creator's choices", (await read(api, pool, "referendum")) === 676 && (await read(api, pool, "deposit")) === DEPOSIT * WEI_PER_PLANCK &&
  (await read(api, pool, "minContribution")) === MIN * WEI_PER_PLANCK && (await read(api, pool, "fundingDeadline")) === deadline);
check("it builds the same XCM message as a directly deployed pool", (await read(api, pool, "placeMessage")) === "0x0504060100185c01a4020000");

const second = await fcall(dave, factory, "create", [676, DEPOSIT, 10n * KSM, deadline]);
check("a second pool for the same referendum is allowed", second.ok);
check("poolsFor(676) now lists two", ((await fread(factory, "poolsFor", [676])) as Hex[]).length === 2);
check("poolCountFor(676) is 2, another referendum 0", (await fread(factory, "poolCountFor", [676])) === 2n && (await fread(factory, "poolCountFor", [677])) === 0n);
const page1 = (await fread(factory, "poolsForRange", [676, 1n, 10n])) as Hex[];
check("poolsForRange reads a page (offset 1 → the second pool)", page1.length === 1 && page1[0].toLowerCase() === ((await fread(factory, "pools", [1n])) as Hex).toLowerCase());
check("poolsForRange past the end is empty", ((await fread(factory, "poolsForRange", [676, 5n, 10n])) as Hex[]).length === 0);

// ------------------------------------------------------------------ attacks: the factory holds nothing, vouches only for its own pools
const U256 = 2n ** 256n - 1n;
const send = async (to: Hex, data: Hex, value: bigint) => ethSend(api, eve, to, data, value);
check("create refuses any value sent with it (not payable)", !(await send(factory, encodeFunctionData({ abi: fabi, functionName: "create", args: [676, DEPOSIT, MIN, deadline] } as any), KSM_WEI)).ok);
check("a plain value transfer to the factory is refused (no receive/fallback)", !(await send(factory, "0x", KSM_WEI)).ok);
check("an unknown function call is refused", !(await send(factory, "0xdeadbeef", 0n)).ok);
check("the factory's EVM balance is 0", (await evmBalance(api, factory)) === 0n);
const direct = await deploy(api, eve, [676, DEPOSIT, MIN, deadline, REFERENDA, PLACE, REFUND, WEI_PER_PLANCK]);
check("a pool deployed directly, same code and arguments, is NOT vouched for", (await fread(factory, "isPool", [direct])) === false);
check("the factory does not vouch for itself", (await fread(factory, "isPool", [factory])) === false);
const dep2 = await ethSend(api, eve, null, encodeDeployData({ abi: fabi, bytecode: art.bytecode, args: [REFERENDA, PLACE, REFUND, WEI_PER_PLANCK] }));
const factory2 = dep2.events.find((e: any) => e.event.section === "revive" && e.event.method === "Instantiated").event.data[1].toHex() as Hex;
const other2 = await fcall(eve, factory2, "create", [676, DEPOSIT, MIN, deadline]);
const pool2 = (await fread(factory2, "pools", [0n])) as Hex;
check("another factory's pool is not vouched for by this one", other2.ok && (await fread(factory, "isPool", [pool2])) === false && (await fread(factory2, "isPool", [pool2])) === true);
// Arithmetic: every overflow reverts (Solidity 0.8 checked math), nothing wraps around into a weird pool.
check("a minimum so large that ×10 overflows is refused", !(await fcall(eve, factory, "create", [676, DEPOSIT, U256 / 10n + 1n, deadline])).ok);
check("a deposit so large that ×weiPerPlanck overflows is refused", !(await fcall(eve, factory, "create", [676, U256 / WEI_PER_PLANCK + 1n, MIN, deadline])).ok);
check("a deadline at the uint64 maximum is refused", !(await fcall(eve, factory, "create", [676, DEPOSIT, MIN, 2n ** 64n - 1n])).ok);
check("a deadline of right now is refused", !(await fcall(eve, factory, "create", [676, DEPOSIT, MIN, await now()])).ok);
check("a zero deposit is refused", !(await fcall(eve, factory, "create", [676, 0n, 0n, deadline])).ok);
check("a zero minimum is refused", !(await fcall(eve, factory, "create", [676, DEPOSIT, 0n, deadline])).ok);
// Reading pages can never revert, whatever the arguments.
const all676 = ((await fread(factory, "poolsFor", [676])) as Hex[]).map((x) => x.toLowerCase());
check("poolsForRange with a huge limit returns the rest, no overflow", (((await fread(factory, "poolsForRange", [676, 1n, U256])) as Hex[]).map((x) => x.toLowerCase())).join() === all676.slice(1).join());
check("poolsForRange with a huge offset is empty", ((await fread(factory, "poolsForRange", [676, U256, U256])) as Hex[]).length === 0);
check("poolsForRange with limit 0 is empty", ((await fread(factory, "poolsForRange", [676, 0n, 0n])) as Hex[]).length === 0);
// A flood of junk pools for one referendum (a deposit no track takes): the paged reads return all of
// them in order, and the list for the real deposit stays exactly the real pools.
const FLOOD = 12, JUNK = 10n * KSM;
const real999 = await fcall(dave, factory, "create", [999, DEPOSIT, MIN, deadline]);
for (let i = 0; i < FLOOD; i++) if (!(await fcall(eve, factory, "create", [999, JUNK, KSM, deadline])).ok) throw new Error("flood create " + i);
const flood = ((await fread(factory, "poolsFor", [999])) as Hex[]).map((x) => x.toLowerCase());
const paged: string[] = [];
for (let at = 0n; at < BigInt(FLOOD + 1); at += 5n) paged.push(...((await fread(factory, "poolsForRange", [999, at, 5n])) as Hex[]).map((x) => x.toLowerCase()));
check(`${FLOOD + 1} pools for one referendum: count, pages and full list agree`, real999.ok && (await fread(factory, "poolCountFor", [999])) === BigInt(FLOOD + 1) && paged.join() === flood.join() && new Set(flood).size === FLOOD + 1);
const forReal = ((await fread(factory, "poolsForDepositRange", [999, DEPOSIT, 0n, 100n])) as Hex[]).map((x) => x.toLowerCase());
check("by (referendum, deposit): the junk pools never crowd out the real one", forReal.length === 1 && forReal[0] === flood[0] && (await fread(factory, "poolCountForDeposit", [999, DEPOSIT])) === 1n && (await fread(factory, "poolCountForDeposit", [999, JUNK])) === BigInt(FLOOD));
check("poolsForDepositRange with huge arguments never reverts", ((await fread(factory, "poolsForDepositRange", [999, JUNK, 3n, U256])) as Hex[]).length === FLOOD - 3 && ((await fread(factory, "poolsForDepositRange", [999, JUNK, U256, U256])) as Hex[]).length === 0);
check("every flooded pool is vouched for and carries the factory's parameters", (await Promise.all(flood.slice(0, 5).map(async (p) => (await fread(factory, "isPool", [p])) === true && (await read(api, p as Hex, "referendaPallet")) === REFERENDA && (await read(api, p as Hex, "weiPerPlanck")) === WEI_PER_PLANCK))).every(Boolean));
// Value sent to the factory from the Substrate side runs no code: it is stuck and changes nothing.
const fNative = nativeOf(api, factory);
await sendSubstrate(api, api.tx.balances.transferKeepAlive(fNative, KSM), substrateKey("//Ferdie"));
check("a Substrate-level transfer to the factory changes nothing: create still works", (await fcall(dave, factory, "create", [1000, DEPOSIT, MIN, deadline])).ok && (await fread(factory, "isPool", [direct])) === false);

// ------------------------------------------------------------------ the full life of a factory pool on #676
const parts = [[alice, 300n * KSM], [bob, 300n * KSM], [carol, DEPOSIT - 600n * KSM]] as const;
let last: any;
for (const [who, amt] of parts) {
  last = await tx(api, who, pool, "contribute", [], amt * WEI_PER_PLANCK);
  check(`${who.name} pays in`, last.ok, last.error ?? "");
}
check("the filling payment places the deposit on #676", names(last.events).includes("referenda.DecisionDepositPlaced"));
const on = ((await api.query.referenda.referendumInfoFor(676)) as any).unwrap().asOngoing;
check("#676's depositor is the factory-made pool", on.decisionDeposit.unwrap().who.toString() === nativeOf(api, pool));
const other = (await fread(factory, "pools", [1n])) as Hex;
check("the other pool for #676 still takes payments", (await tx(api, dave, other, "contribute", [], 10n * KSM_WEI)).ok);
check("and its contributor can take them back", (await tx(api, dave, other, "withdraw")).ok);

say("root cancel: " + (await asRoot(api, api.tx.referenda.cancel(676))) + " (a second copy on the agenda reports NotOngoing)");
check("#676 is cancelled", ((await api.query.referenda.referendumInfoFor(676)) as any).unwrap().isCancelled);
const before = await Promise.all(parts.map(([w]) => freeOf(api, nativeOf(api, w.address))));
check("reclaim", (await tx(api, dave, pool, "reclaim")).ok);
check("payout", (await tx(api, dave, pool, "payout", [0n, 100n])).ok);
for (const [i, [w, amt]] of parts.entries()) {
  const d = (await freeOf(api, nativeOf(api, w.address))) - before[i];
  check(`${w.name} got exactly their share back`, d === amt, `${d}`);
}
check("the pool is empty", (await evmBalance(api, pool)) === 0n);

say(`\n${failed ? failed + " FAILED" : "all passed"}`);
mkdirSync(new URL("./results", import.meta.url), { recursive: true });
writeFileSync(new URL("./results/factory-test.txt", import.meta.url), log.join("\n") + "\n");
await api.disconnect();
process.exit(failed ? 1 : 0);
