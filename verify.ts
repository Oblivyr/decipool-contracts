// Modified from Birdbrain's decision-deposit (Apache-2.0) for Decipool, November 2026: verifies the factory too.
// Verify a contract on the network's Blockscout, with the same compiler input as compile.ts.
//
//   bun verify.ts <paseo|kusama|polkadot> <address> <constructorArgsHex> [pool|factory]
import { readFileSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { NETWORKS, type Net } from "./networks";

const [net, address, args, kind = "pool"] = process.argv.slice(2) as [Net, string, string, string];
const read = (f: string) => readFileSync(new URL("./contracts/" + f, import.meta.url), "utf8");
// The factory imports the pool, so both sources go in for it.
const files = kind === "factory" ? ["DecisionDepositPool.sol", "DecisionDepositPoolFactory.sol"] : ["DecisionDepositPool.sol"];
const name = kind === "factory" ? "DecisionDepositPoolFactory" : "DecisionDepositPool";
const input = {
  language: "Solidity",
  sources: Object.fromEntries(files.map((f) => [f, { content: read(f) }])),
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
};
// Bun's multipart upload is not read as a file by Blockscout; curl's is.
const file = `/tmp/dd-verify-${address}.json`;
writeFileSync(file, JSON.stringify(input));
const base = NETWORKS[net].explorer;
const out = execFileSync("curl", ["-s", "-m", "60", "-X", "POST", `${base}/api/v2/smart-contracts/${address}/verification/via/standard-input`,
  "-F", "compiler_version=v0.8.30+commit.73712a01", "-F", "license_type=apache_2_0", "-F", `contract_name=${name}`,
  "-F", "autodetect_constructor_args=false", "-F", `constructor_args=${args}`, "-F", `files[0]=@${file};type=application/json`]).toString();
console.log(out);
for (let i = 0; i < 20; i++) {
  await new Promise((s) => setTimeout(s, 5000));
  const c = await (await fetch(`${base}/api/v2/smart-contracts/${address}`)).json();
  if (c.is_verified) { console.log("verified:", base + "/address/" + address + "?tab=contract"); process.exit(0); }
}
console.log("not verified yet"); process.exit(1);
