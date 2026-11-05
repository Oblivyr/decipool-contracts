// Fails if Birdbrain's contracts differ from upstream (see NOTICE). To move to a newer upstream commit,
// update NOTICE and the hashes below.
import { createHash } from "crypto";
import { readFileSync } from "fs";

const UPSTREAM = "a2a927c34e"; // Birdbrain-wtf/decision-deposit
const FILES: Record<string, string> = {
  "contracts/DecisionDepositPool.sol": "ea4f834007abd3ba3d9638cc0dc253d6ea961f3bd6f60eca7002195b6f9307a0",
  "contracts/Refuser.sol": "88387c823fe31e2aff11688cb3201600c8c0c5f95d97bf9273a8ef4753a10bd0",
};
let bad = 0;
for (const [f, want] of Object.entries(FILES)) {
  const got = createHash("sha256").update(readFileSync(new URL("./" + f, import.meta.url))).digest("hex");
  console.log((got === want ? "ok   " : "FAIL ") + f + (got === want ? "" : " differs from Birdbrain's commit " + UPSTREAM));
  if (got !== want) bad++;
}
if (bad) process.exit(1);
console.log("Birdbrain's contracts are unchanged (upstream " + UPSTREAM + ")");
