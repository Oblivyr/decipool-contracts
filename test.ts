// Modified from Birdbrain's decision-deposit (Apache-2.0) for Decipool, November 2026: fork start command in the header.
// End-to-end tests for DecisionDepositPool on a chopsticks fork of Kusama Asset Hub.
//
//   ./fork/start.sh & bun compile.ts && bun test.ts
//
// Real signed transactions on a copy of the live chain (Referenda pallet, XCM precompile). Simulated:
// balances are written, Root actions go on the scheduler agenda, one Rejected ending is written to storage.
import {
  connect, wallets, fund, nativeOf, deploy, read, tx, ethSend, KSM, WEI_PER_PLANCK, KSM_WEI,
  freeOf, reservedOf, names, asRoot, advancePast, newBlock, substrateKey, sendSubstrate, evmBalance, type Wallet,
} from "./lib";
import { encodeDeployData, encodeFunctionData, decodeEventLog, type Hex } from "viem";
import { abi as poolAbi } from "./lib";
import { readFileSync, writeFileSync, mkdirSync } from "fs";

const DEPOSIT = 666_666_666_660_000n; // planck: Kusama's WishForChange decision deposit, read live below
const MIN = 10n * KSM;
const REFERENDA = 92, PLACE = 1, REFUND = 2;

const api = await connect();
const w = wallets();
const { alice, bob, carol, dave, eve } = w;
const ferdie = substrateKey("//Ferdie"); // a plain Substrate account, for governance actions
const results: { name: string; ok: boolean; detail: string }[] = [];
const log: string[] = [];
const say = (s: string) => { console.log(s); log.push(s); };

function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  say(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
}

const planckWei = (p: bigint) => p * WEI_PER_PLANCK;
const ksm = (p: bigint) => (Number(p) / 1e12).toFixed(8) + " KSM";
const now = async () => BigInt(((await api.query.timestamp.now()) as any).toBigInt() / 1000n);
const state = async (pool: Hex) => ["Open", "Placed", "Returning"][Number(await read(api, pool, "state"))];
const info = async (idx: number) => ((await api.query.referenda.referendumInfoFor(idx)) as any);
const free = (who: Wallet | Hex) => freeOf(api, nativeOf(api, typeof who === "string" ? who : who.address));

async function newPool(referendum: number, deadlineIn = 3600n) {
  const pool = await deploy(api, dave, [referendum, DEPOSIT, MIN, (await now()) + deadlineIn, REFERENDA, PLACE, REFUND, WEI_PER_PLANCK, dave.address]);
  return pool;
}
const deadlineOf = async (pool: Hex) => BigInt(await read(api, pool, "fundingDeadline"));

async function submitReferendum(label: string) {
  const r = await sendSubstrate(
    api,
    api.tx.referenda.submit({ Origins: "WishForChange" } as any, { Inline: api.tx.system.remark(label).method.toHex() } as any, { After: 100 } as any),
    ferdie,
  );
  if (r.error) throw new Error("submit failed: " + r.error);
  const ev = r.events.find((e: any) => e.event.section === "referenda" && e.event.method === "Submitted");
  return ev.event.data[0].toNumber() as number;
}

/** Fill a pool exactly: Alice 300, Bob 300, Carol the remaining 66.66666666. */
async function fill(pool: Hex) {
  const parts: [Wallet, bigint][] = [[alice, 300n * KSM], [bob, 300n * KSM], [carol, DEPOSIT - 600n * KSM]];
  let last: any;
  for (const [who, amt] of parts) {
    last = await tx(api, who, pool, "contribute", [], planckWei(amt));
    if (!last.ok) throw new Error(`${who.name} contribute failed: ${last.error}`);
  }
  (parts as any).last = last;
  return parts;
}

/** Names of the pool's own events in a transaction's events, e.g. ["Contributed", "Placed"]. */
function poolEvents(events: any[]) {
  return events
    .filter((e: any) => e.event.section === "revive" && e.event.method === "ContractEmitted")
    .map((e: any) => {
      try {
        return decodeEventLog({ abi: poolAbi, data: e.event.data.data.toHex(), topics: e.event.data.topics.map((t: any) => t.toHex()) }).eventName ?? "?";
      } catch { return "?"; }
    });
}

async function repaidExactly(parts: [Wallet, bigint][], before: Map<string, bigint>) {
  for (const [who, amt] of parts) {
    const delta = (await free(who)) - before.get(who.name)!;
    check(`${who.name} got exactly ${ksm(amt)} back`, delta === amt, `balance moved by ${ksm(delta)}`);
  }
}

async function snapshot(parts: [Wallet, bigint][]) {
  const m = new Map<string, bigint>();
  for (const [who] of parts) m.set(who.name, await free(who));
  return m;
}

// ------------------------------------------------------------------ setup
const head = ((await api.rpc.chain.getHeader()) as any).number.toNumber();
say(`fork of Kusama Asset Hub at #${head}, spec ${api.runtimeVersion.specVersion}`);
const track2 = [...(api.consts.referenda.tracks as any)].find(([id]: any) => id.toNumber() === 2)[1];
check("WishForChange decision deposit on chain is 666.66666666 KSM", track2.decisionDeposit.toBigInt() === DEPOSIT, ksm(track2.decisionDeposit.toBigInt()));
const r676 = await info(676);
check("#676 is ongoing with no decision deposit", r676.isSome && r676.unwrap().isOngoing && r676.unwrap().asOngoing.decisionDeposit.isNone);

await fund(api, [alice, bob, carol, dave, eve].map((x) => nativeOf(api, x.address)), 10_000n);
await fund(api, [ferdie.address], 10_000n);

// ------------------------------------------------------------------ 1. #676, the real referendum
say("\n# 1. Three groups fund #676, the deposit goes on, the referendum ends, everyone is repaid");
{
  const pool = await newPool(676);
  const acct = nativeOf(api, pool);
  say(`pool ${pool} (native account ${acct})`);
  const msg = await read(api, pool, "placeMessage");
  check("contract builds the same XCM message the chain encodes", msg === "0x0504060100185c01a4020000", msg);

  check("place before full is refused", (await tx(api, dave, pool, "place")).error === "NotFull");
  check("a 5 KSM payment is under the minimum and refused", (await tx(api, alice, pool, "contribute", [], 5n * KSM_WEI)).error === "BadAmount");
  check("a payment with sub-planck dust is refused", (await tx(api, alice, pool, "contribute", [], 10n * KSM_WEI + 1n)).error === "BadAmount");
  const parts = await fill(pool);
  check("Carol's 66.67 KSM top-up is accepted although it is the final amount", (await read(api, pool, "total")) === planckWei(DEPOSIT));
  const fillEv = poolEvents((parts as any).last.events);
  check("Carol's payment that fills the pool places the deposit in the same transaction", fillEv.includes("Contributed") && fillEv.includes("Placed") && !fillEv.includes("AutoPlaceFailed"), fillEv.join(" "));
  check("that same transaction moved #676 into deciding", names((parts as any).last.events).includes("referenda.DecisionDepositPlaced"), names((parts as any).last.events).filter((n) => n.startsWith("referenda")).join(" "));
  check("paying past the deposit is refused", (await tx(api, eve, pool, "contribute", [], 10n * KSM_WEI)).error === "WrongState");
  check("three contributors recorded", (await read(api, pool, "contributorCount")) === 3n);
  check("the fallback place is refused once placed", (await tx(api, eve, pool, "place")).error === "WrongState");
  check("nobody but the pool can call its internal placing hook", (await tx(api, eve, pool, "placeFromFill", [eve.address])).error === "NotSelf");
  const on = (await info(676)).unwrap().asOngoing;
  check("#676's decision deposit is now held by the pool's own account", on.decisionDeposit.isSome && on.decisionDeposit.unwrap().who.toString() === acct && on.decisionDeposit.unwrap().amount.toBigInt() === DEPOSIT);
  check("#676 has started deciding", on.deciding.isSome);
  check("pool is Placed", (await state(pool)) === "Placed");
  check("the 666.67 KSM is reserved on the pool's account", (await reservedOf(api, acct)) >= DEPOSIT, ksm(await reservedOf(api, acct)));

  check("withdrawing once placed is refused", (await tx(api, alice, pool, "withdraw")).error === "WrongState");
  const early = await tx(api, dave, pool, "reclaim");
  check("reclaim while #676 is still live is refused and changes nothing", early.error === "NothingCameBack" && (await state(pool)) === "Placed", early.error ?? "");

  say("root cancel: " + (await asRoot(api, api.tx.referenda.cancel(676))));
  const ended = (await info(676)).unwrap();
  check("#676 is ended (cancelled by Root here; approved/rejected refund the same way)", ended.isCancelled, ended.type);

  const before = await snapshot(parts);
  const rec = await tx(api, dave, pool, "reclaim");
  check("anyone can reclaim once it has ended", rec.ok, rec.error ?? names(rec.events).filter((n) => n.startsWith("referenda") || n === "balances.Unreserved").join(" "));
  check("pool is Returning", (await state(pool)) === "Returning");
  const pay = await tx(api, dave, pool, "payout", [0n, 100n]);
  check("anyone can pay every contributor back in one transaction", pay.ok, pay.error ?? `${names(pay.events).filter((n) => n === "revive.ContractEmitted").length} events`);
  await repaidExactly(parts, before);
  check("nothing is left owed", (await read(api, pool, "total")) === 0n);
  check("pool's spendable balance is back to zero", (await evmBalance(api, pool)) === 0n, `${await evmBalance(api, pool)} wei`);
  check("a second payout is harmless", (await tx(api, dave, pool, "payout", [0n, 100n])).ok);
  check("claim with nothing owed is refused", (await tx(api, alice, pool, "claim")).error === "BadAmount");
}

// ------------------------------------------------------------------ 2. rejected, refund taken directly on governance
say("\n# 2. Referendum rejected; a stranger claims the refund straight from governance, the pool still settles");
{
  const idx = await submitReferendum("decision-deposit test 2");
  const pool = await newPool(idx);
  const parts = await fill(pool);
  check(`the filling payment places on #${idx}`, (await state(pool)) === "Placed");
  // Write the ending the pallet itself writes for a rejection: Rejected(at, submission deposit, decision deposit).
  const on = (await info(idx)).unwrap().asOngoing;
  await api.rpc("dev_setStorage" as any, {
    Referenda: { ReferendumInfoFor: [[[idx], { Rejected: [on.submitted.toNumber() + 1, on.submissionDeposit.toJSON(), on.decisionDeposit.toJSON()] }]] },
  });
  await newBlock(api);
  check(`#${idx} is rejected`, (await info(idx)).unwrap().isRejected);
  const direct = await sendSubstrate(api, api.tx.referenda.refundDecisionDeposit(idx), ferdie);
  check("a stranger refunds the decision deposit directly on governance", !direct.error, direct.error ?? "");
  const before = await snapshot(parts);
  const rec = await tx(api, dave, pool, "reclaim");
  check("reclaim still succeeds (the KSM already landed in the pool)", rec.ok, rec.error ?? "");
  check("payout succeeds", (await tx(api, dave, pool, "payout", [0n, 100n])).ok);
  await repaidExactly(parts, before);
}

// ------------------------------------------------------------------ 3. killed
say("\n# 3. Referendum killed: the deposit is slashed and the pool cannot get it back");
{
  const idx = await submitReferendum("decision-deposit test 3");
  const pool = await newPool(idx);
  await fill(pool);
  check(`the filling payment places on #${idx}`, (await state(pool)) === "Placed");
  say("root kill: " + (await asRoot(api, api.tx.referenda.kill(idx))));
  check(`#${idx} is killed`, (await info(idx)).unwrap().isKilled);
  check("the 666.67 KSM is gone from the pool's account", (await reservedOf(api, nativeOf(api, pool))) < DEPOSIT, `reserved ${ksm(await reservedOf(api, nativeOf(api, pool)))}`);
  const rec = await tx(api, dave, pool, "reclaim");
  check("reclaim is refused: nothing came back", rec.error === "NothingCameBack", rec.error ?? "");
  check("pool stays Placed, with nothing to pay out (the known risk)", (await state(pool)) === "Placed");
}

// ------------------------------------------------------------------ 4. never filled
say("\n# 4. Pool never fills before its deadline: anyone abandons it and everyone is repaid");
{
  const pool = await newPool(676, 900n);
  const parts: [Wallet, bigint][] = [[alice, 100n * KSM], [bob, 50n * KSM]];
  for (const [who, amt] of parts) check(`${who.name} pays ${ksm(amt)}`, (await tx(api, who, pool, "contribute", [], planckWei(amt))).ok);
  check("abandon before the deadline is refused", (await tx(api, dave, pool, "abandon")).error === "TooEarly");
  await advancePast(api, await deadlineOf(pool));
  check("paying in after the deadline is refused", (await tx(api, carol, pool, "contribute", [], 10n * KSM_WEI)).error === "TooLate");
  check("placing after the deadline is refused", (await tx(api, dave, pool, "place")).error === "TooLate");
  // Version 2: money sent with a plain transfer (no contribute) can be swept, and only that.
  const stray = await sendSubstrate(api, api.tx.balances.transferKeepAlive(nativeOf(api, pool), 7n * KSM), ferdie);
  check("Ferdie sends 7 KSM to the pool with a plain transfer (runs no code)", !stray.error, stray.error ?? "");
  check("sweep is refused while the pool is not Returning", (await tx(api, eve, pool, "sweep")).error === "WrongState");
  const before = await snapshot(parts);
  check("anyone can abandon after the deadline", (await tx(api, dave, pool, "abandon")).ok);
  check("excess() is the stray 7 KSM, not the contributors' 150", (await read(api, pool, "excess")) === 7n * KSM_WEI, String(await read(api, pool, "excess")));
  const d0 = await free(dave);
  check("anyone (Eve) sweeps it", (await tx(api, eve, pool, "sweep")).ok);
  check("it went to sweepTo (Dave, who created the pool): exactly 7 KSM", (await free(dave)) - d0 === 7n * KSM, ksm((await free(dave)) - d0));
  check("a second sweep has nothing left", (await tx(api, eve, pool, "sweep")).error === "NothingToSweep");
  check("payout succeeds", (await tx(api, dave, pool, "payout", [0n, 100n])).ok);
  await repaidExactly(parts, before);
}

// ------------------------------------------------------------------ 5. withdraw while open, and someone else placing first
say("\n# 5. Someone else places the deposit first: the pool refuses to place, groups withdraw");
{
  const idx = await submitReferendum("decision-deposit test 5");
  const pool = await newPool(idx);
  const b0 = await free(bob);
  check("Bob pays 50 KSM", (await tx(api, bob, pool, "contribute", [], 50n * KSM_WEI)).ok);
  check("Bob pays another 25 KSM (adds to his share, no new slot)", (await tx(api, bob, pool, "contribute", [], 25n * KSM_WEI)).ok && (await read(api, pool, "contributorCount")) === 1n);
  // Version 2: an address that withdraws and pays in again is listed once.
  check("Bob withdraws all, then pays 75 KSM again: still one slot", (await tx(api, bob, pool, "withdraw")).ok && (await tx(api, bob, pool, "contribute", [], 75n * KSM_WEI)).ok && (await read(api, pool, "contributorCount")) === 1n);
  const direct = await sendSubstrate(api, api.tx.referenda.placeDecisionDeposit(idx), ferdie);
  check(`Ferdie places #${idx}'s deposit directly`, !direct.error, direct.error ?? "");
  const parts: [Wallet, bigint][] = [[alice, 300n * KSM], [carol, DEPOSIT - 375n * KSM]];
  let lastPay: any;
  for (const [who, amt] of parts) lastPay = await tx(api, who, pool, "contribute", [], planckWei(amt));
  const ev5 = poolEvents(lastPay.events);
  check("Carol's filling payment is accepted although the automatic placing fails", lastPay.ok && ev5.includes("Contributed") && ev5.includes("AutoPlaceFailed") && !ev5.includes("Placed"), lastPay.error ?? ev5.join(" "));
  check("the pool stays Open and full, its balance untouched", (await state(pool)) === "Open" && (await read(api, pool, "total")) === planckWei(DEPOSIT) && (await evmBalance(api, pool)) === planckWei(DEPOSIT));
  const p = await tx(api, dave, pool, "place");
  check("pool's place is refused and no KSM leaves", !p.ok && (await read(api, pool, "total")) === planckWei(DEPOSIT), p.error ?? "");
  const before = await snapshot([[bob, 0n], ...parts]);
  for (const who of [bob, alice, carol]) check(`${who.name} withdraws`, (await tx(api, who, pool, "withdraw")).ok);
  for (const [who, amt] of parts) {
    const delta = (await free(who)) - before.get(who.name)!;
    const off = delta > amt ? delta - amt : amt - delta;
    check(`${who.name} got ${ksm(amt)} back, give or take her own withdraw fee and storage deposit`, off < KSM / 1000n, `moved ${ksm(delta)}`);
  }
  const bobNet = b0 - (await free(bob));
  check("Bob is out only his transaction fees", bobNet >= 0n && bobNet < KSM / 10n, `net cost ${ksm(bobNet)}`);
}

// ------------------------------------------------------------------ 6. a contributor that refuses payment
say("\n# 6. One contributor's address refuses payment: everyone else is still paid");
{
  const refuserArt = JSON.parse(readFileSync(new URL("./build/Refuser.json", import.meta.url), "utf8"));
  const d = await ethSend(api, eve, null, encodeDeployData({ abi: refuserArt.abi, bytecode: refuserArt.bytecode }));
  const refuser = d.events.find((e: any) => e.event.section === "revive" && e.event.method === "Instantiated").event.data[1].toHex() as Hex;
  const pool = await newPool(676, 900n);
  check("Alice pays 100 KSM", (await tx(api, alice, pool, "contribute", [], 100n * KSM_WEI)).ok);
  const j = await ethSend(api, eve, refuser, encodeFunctionData({ abi: refuserArt.abi, functionName: "join", args: [pool] }), 20n * KSM_WEI);
  check("a contract that refuses payments pays 20 KSM in", j.ok, j.error ?? "");
  check("Bob pays 30 KSM", (await tx(api, bob, pool, "contribute", [], 30n * KSM_WEI)).ok);
  await advancePast(api, await deadlineOf(pool));
  check("anyone abandons after the deadline", (await tx(api, dave, pool, "abandon")).ok);
  const parts: [Wallet, bigint][] = [[alice, 100n * KSM], [bob, 30n * KSM]];
  const before = await snapshot(parts);
  const pay = await tx(api, dave, pool, "payout", [0n, 100n]);
  check("payout completes despite the refusal", pay.ok, pay.error ?? "");
  await repaidExactly(parts, before);
  check("the refuser's 20 KSM stays owed to it, claimable later", (await read(api, pool, "contributed", [refuser])) === 20n * KSM_WEI);
}

// ------------------------------------------------------------------ 7. a Polkadot (Substrate) account pays in
say("\n# 7. A group pays from an ordinary Polkadot account (not an Ethereum wallet) and is repaid to that account");
{
  const pool = await newPool(676, 900n);
  // AutoMap maps accounts on creation; Ferdie was written into storage, so map him here.
  const ferdieEvm = ((await (api.call as any).reviveApi.address(ferdie.address)) as any).toHex();
  await api.rpc("dev_setStorage" as any, { Revive: { OriginalAccount: [[[ferdieEvm], ferdie.address]] } });
  const data = encodeFunctionData({ abi: (await import("./lib")).abi, functionName: "contribute", args: [] });
  const c = await sendSubstrate(api, api.tx.revive.call(pool, 40n * KSM, { refTime: 50_000_000_000n, proofSize: 1_000_000n }, 10n * KSM, data), ferdie);
  check("Ferdie pays 40 KSM with a plain Substrate Revive.call", !c.error, c.error ?? "");
  check("the pool credits Ferdie's EVM address", (await read(api, pool, "contributed", [ferdieEvm])) === 40n * KSM_WEI);
  await advancePast(api, await deadlineOf(pool));
  check("anyone abandons after the deadline", (await tx(api, dave, pool, "abandon")).ok);
  const before = await freeOf(api, ferdie.address);
  check("payout succeeds", (await tx(api, dave, pool, "payout", [0n, 100n])).ok);
  const delta = (await freeOf(api, ferdie.address)) - before;
  check("Ferdie's own Polkadot account gets exactly 40 KSM back", delta === 40n * KSM, `moved ${ksm(delta)}`);
}

// ------------------------------------------------------------------ 8. automatic placing fails, the fallback places
say("\n# 8. The automatic attempt fails (the referendum is not open yet); later anyone places with the fallback");
{
  const next = ((await api.query.referenda.referendumCount()) as any).toNumber();
  const pool = await newPool(next); // a referendum index that does not exist yet
  const parts = await fill(pool);
  const ev = poolEvents((parts as any).last.events);
  check(`filling a pool for #${next}, not yet submitted, is accepted and the automatic attempt fails`, ev.includes("Contributed") && ev.includes("AutoPlaceFailed"), ev.join(" "));
  check("pool stays Open and full, every planck still in it", (await state(pool)) === "Open" && (await evmBalance(api, pool)) === planckWei(DEPOSIT));
  const held = await reservedOf(api, nativeOf(api, pool));
  check("the deposit is not reserved on the pool's account, only its storage deposit", held < DEPOSIT, `reserved ${ksm(held)}`);
  const idx = await submitReferendum("decision-deposit test 8");
  check(`#${idx} is now submitted`, idx === next);
  const placed = await tx(api, eve, pool, "place"); // Eve has no stake: anyone can place
  check("anyone can place with the fallback", placed.ok, placed.error ?? "");
  const on = (await info(idx)).unwrap().asOngoing;
  check(`#${idx}'s decision deposit is held by the pool's own account`, on.decisionDeposit.isSome && on.decisionDeposit.unwrap().who.toString() === nativeOf(api, pool));
  say("root cancel: " + (await asRoot(api, api.tx.referenda.cancel(idx))));
  const before = await snapshot(parts);
  check("reclaim succeeds", (await tx(api, dave, pool, "reclaim")).ok);
  check("payout succeeds", (await tx(api, dave, pool, "payout", [0n, 100n])).ok);
  await repaidExactly(parts, before);
}

// ------------------------------------------------------------------ report
const passed = results.filter((r) => r.ok).length;
say(`\n${passed}/${results.length} checks passed`);
mkdirSync(new URL("./results", import.meta.url), { recursive: true });
writeFileSync(new URL("./results/fork-test.txt", import.meta.url), log.join("\n") + "\n");
await api.disconnect();
process.exit(passed === results.length ? 0 : 1);
