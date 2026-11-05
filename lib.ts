// Modified from Birdbrain's decision-deposit (Apache-2.0) for Decipool, November 2026: factory, Polkadot and fork helpers.
// Helpers for driving the pool on a chopsticks fork of Asset Hub.
// Asset Hub only accepts EVM bytecode through Ethereum transactions, so tests sign one and submit it
// as Revive.eth_transact, as the eth RPC server does for MetaMask.
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import type { KeyringPair } from "@polkadot/keyring/types";
import { u8aToHex, hexToU8a, u8aConcat } from "@polkadot/util";
import {
  encodeFunctionData,
  decodeFunctionResult,
  decodeErrorResult,
  encodeDeployData,
  keccak256,
  toHex,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { readFileSync } from "fs";

// FORK_NET=kusama (default) or polkadot. "KSM" below means one unit of that network's token.
import { NETWORKS, type Net } from "./networks";
export const FORK_NET = (process.env.FORK_NET ?? "kusama") as Net;
export const NET = NETWORKS[FORK_NET];
if (!NET) throw new Error("FORK_NET: " + Object.keys(NETWORKS).join(" | "));
export const KSM = NET.planckPerUnit; // planck per unit
export const WEI_PER_PLANCK = NET.weiPerPlanck;
export const KSM_WEI = KSM * WEI_PER_PLANCK; // wei per unit in the EVM

const artefact = JSON.parse(readFileSync(new URL("./build/DecisionDepositPool.json", import.meta.url), "utf8"));
export const abi = artefact.abi as Abi;
export const bytecode = artefact.bytecode as Hex;

export async function connect(url = "ws://127.0.0.1:8010") {
  return ApiPromise.create({ provider: new WsProvider(url), noInitWarn: true });
}

export type Wallet = PrivateKeyAccount & { name: string };

/** Deterministic test wallets. Example people are Alice, Bob, Carol; Dave is "anyone". */
export function wallets() {
  const mk = (name: string): Wallet =>
    Object.assign(privateKeyToAccount(keccak256(toHex("decision-deposit test " + name))), { name });
  return { alice: mk("alice"), bob: mk("bob"), carol: mk("carol"), dave: mk("dave"), eve: mk("eve") };
}

/** A Substrate key, for the governance actions that are not EVM (submitting a referendum). */
export function substrateKey(uri: string): KeyringPair {
  return new Keyring({ type: "sr25519", ss58Format: FORK_NET === "kusama" ? 2 : 0 }).addFromUri(uri);
}

/** The native account behind an Ethereum address: the 20 bytes then twelve 0xEE. */
export function nativeOf(api: ApiPromise, address: Hex): string {
  return api.createType("AccountId32", u8aConcat(hexToU8a(address), new Uint8Array(12).fill(0xee))).toString();
}

export async function newBlock(api: ApiPromise, n = 1) {
  await api.rpc("dev_newBlock" as any, { count: n });
}

export async function fund(api: ApiPromise, accounts: string[], ksm: bigint) {
  await api.rpc("dev_setStorage" as any, {
    System: { Account: accounts.map((a) => [[a], { providers: 1, data: { free: (ksm * KSM).toString() } }]) },
  });
}

export async function freeOf(api: ApiPromise, address: string): Promise<bigint> {
  const a: any = await api.query.system.account(address);
  return a.data.free.toBigInt();
}

export async function reservedOf(api: ApiPromise, address: string): Promise<bigint> {
  const a: any = await api.query.system.account(address);
  return a.data.reserved.toBigInt();
}

/** Spendable EVM balance in wei, as a contract sees `address(x).balance`. */
export async function evmBalance(api: ApiPromise, address: Hex): Promise<bigint> {
  return ((await (api.call as any).reviveApi.balance(address)) as any).toBigInt();
}

async function eventsOf(api: ApiPromise, head: any, idx: number) {
  const at = await api.at(head);
  const all: any[] = (await at.query.system.events()) as any;
  return all.filter((e) => e.phase.isApplyExtrinsic && e.phase.asApplyExtrinsic.toNumber() === idx);
}

function failureOf(api: ApiPromise, events: any[]): string | null {
  const failed = events.find((e) => e.event.section === "system" && e.event.method === "ExtrinsicFailed");
  if (!failed) return null;
  const de = failed.event.data[0];
  if (de.isModule) {
    const m = api.registry.findMetaError(de.asModule);
    return `${m.section}.${m.name}`;
  }
  return de.toString();
}

/** Submit a Substrate extrinsic, seal a block, return its events and failure, if any. */
export async function sendSubstrate(api: ApiPromise, tx: any, signer: KeyringPair) {
  const signed = await tx.signAsync(signer, { nonce: -1 });
  return include(api, signed);
}

async function include(api: ApiPromise, xt: any) {
  const hash = xt.hash.toHex();
  await api.rpc.author.submitExtrinsic(xt);
  // On slow CI the fork may still be validating the extrinsic: try up to three more blocks.
  let head: any, idx = -1;
  for (let tries = 0; idx < 0 && tries < 4; tries++) {
    await newBlock(api);
    head = await api.rpc.chain.getBlockHash();
    const block = await api.rpc.chain.getBlock(head);
    idx = block.block.extrinsics.findIndex((x) => x.hash.toHex() === hash);
  }
  if (idx < 0) throw new Error("extrinsic not included");
  const events = await eventsOf(api, head, idx);
  return { events, error: failureOf(api, events), block: head };
}

function genericTx(from: Hex, to: Hex | null, data: Hex, valueWei: bigint) {
  return {
    from,
    to,
    input: { input: data, data: null },
    value: valueWei,
    authorizationList: [],
    blobVersionedHashes: [],
    blobs: [],
  };
}

function revertName(data: Hex) {
  if (data === "0x") return "revert()";
  try {
    return decodeErrorResult({ abi, data }).errorName;
  } catch {
    return "revert " + data;
  }
}

/** Dry-run an Ethereum transaction. Returns gas and return data, or the decoded revert. */
export async function dryRun(api: ApiPromise, from: Hex, to: Hex | null, data: Hex, valueWei = 0n) {
  const res: any = await (api.call as any).reviveApi.ethTransact(genericTx(from, to, data, valueWei));
  if (res.isErr) {
    const e = res.asErr;
    if (e.isData) return { ok: false as const, error: revertName(e.asData.toHex()) };
    return { ok: false as const, error: e.asMessage.toString() };
  }
  const ok = res.asOk;
  return { ok: true as const, gas: ok.ethGas.toBigInt(), data: ok.data.toHex() as Hex };
}

const CHAIN_ID = NET.chainId;

/** Sign and submit an Ethereum transaction the way a wallet + Asset Hub's eth RPC would. */
export async function ethSend(api: ApiPromise, wallet: Wallet, to: Hex | null, data: Hex, valueWei = 0n) {
  const dry = await dryRun(api, wallet.address, to, data, valueWei);
  if (!dry.ok) return { ok: false as const, error: dry.error, events: [] as any[] };
  const nonce = ((await (api.call as any).reviveApi.nonce(wallet.address)) as any).toNumber();
  const gasPrice = ((await (api.call as any).reviveApi.gasPrice()) as any).toBigInt();
  const raw = await wallet.signTransaction({
    type: "legacy",
    chainId: CHAIN_ID,
    nonce,
    to: to ?? undefined,
    value: valueWei,
    data,
    gas: (dry.gas * 13n) / 10n,
    gasPrice,
  });
  const r = await include(api, api.tx.revive.ethTransact(raw));
  if (r.error) return { ok: false as const, error: r.error, events: r.events };
  return { ok: true as const, events: r.events };
}

export async function deploy(api: ApiPromise, wallet: Wallet, args: readonly unknown[]) {
  const data = encodeDeployData({ abi, bytecode, args });
  const r = await ethSend(api, wallet, null, data);
  if (!r.ok) throw new Error("deploy failed: " + r.error);
  const ev = r.events.find((e: any) => e.event.section === "revive" && e.event.method === "Instantiated");
  if (!ev) throw new Error("no Instantiated event");
  return ev.event.data[1].toHex() as Hex;
}

/** Read a view function. */
export async function read(api: ApiPromise, pool: Hex, fn: string, args: readonly unknown[] = []): Promise<any> {
  const data = encodeFunctionData({ abi, functionName: fn, args } as any);
  const r = await dryRun(api, wallets().dave.address, pool, data);
  if (!r.ok) throw new Error(`${fn} reverted: ${r.error}`);
  return decodeFunctionResult({ abi, functionName: fn, data: r.data } as any);
}

/** Call a state-changing function from a wallet. Returns ok, or the contract's error name. */
export async function tx(api: ApiPromise, wallet: Wallet, pool: Hex, fn: string, args: readonly unknown[] = [], valueWei = 0n) {
  const data = encodeFunctionData({ abi, functionName: fn, args } as any);
  return ethSend(api, wallet, pool, data, valueWei);
}

/** Dispatch a call as Root via the scheduler agenda. It runs on relay-chain block numbers, so it fires after two blocks. */
export async function asRoot(api: ApiPromise, call: any): Promise<string> {
  const since = ((await api.query.scheduler.incompleteSince()) as any).unwrap().toNumber();
  const item = { maybeId: null, priority: 0, call: { Inline: call.method.toHex() }, maybePeriodic: null, origin: { system: "Root" } };
  // The fork can skip relay numbers between blocks, so cover a window; a repeated cancel/kill just fails.
  const keys: any[] = [];
  for (let k = since; k <= since + 16; k++) keys.push([[k], [item]]);
  await api.rpc("dev_setStorage" as any, { Scheduler: { Agenda: keys } });
  for (let i = 0; i < 4; i++) {
    await newBlock(api);
    const events: any[] = (await api.query.system.events()) as any;
    const d = events.find((e) => e.event.section === "scheduler" && e.event.method === "Dispatched");
    if (d) {
      const r = d.event.data.result;
      if (r.isOk) return "Ok";
      const de = r.asErr;
      if (de.isModule) { const m = api.registry.findMetaError(de.asModule); return `${m.section}.${m.name}`; }
      return de.toString();
    }
  }
  return "not dispatched";
}

/** Produce blocks until the chain's clock is past `deadline` (unix seconds). Time travel breaks this fork's inherents. */
export async function advancePast(api: ApiPromise, deadline: bigint) {
  for (let i = 0; i < 400; i++) {
    const t = ((await api.query.timestamp.now()) as any).toBigInt() / 1000n;
    if (t > deadline) return;
    await newBlock(api, 5);
  }
  throw new Error("clock did not pass deadline");
}

export function names(events: any[]) {
  return events.map((e: any) => `${e.event.section}.${e.event.method}`);
}

export { u8aToHex };
