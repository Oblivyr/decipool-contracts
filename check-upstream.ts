// Fails if Birdbrain's contracts differ from upstream (see NOTICE). To move to a newer upstream commit,
// update NOTICE and the hashes below.
import { createHash } from "crypto";
import { readFileSync } from "fs";

const UPSTREAM = "cb254fe8b0"; // Birdbrain-wtf/decision-deposit (version 2: contracts/v2/DecisionDepositPool.sol)
const FILES: Record<string, string> = {
  "contracts/DecisionDepositPool.sol": "113b553c6acb485d5378dedf7581e538a3e620a90d33c82eae172e76c328bc62",
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
