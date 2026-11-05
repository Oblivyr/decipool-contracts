#!/usr/bin/env bash
# Start a fresh chopsticks fork of an Asset Hub (macOS and Linux).
#   ./fork/start.sh            Kusama Asset Hub at the pinned block in kusama-asset-hub.yml (what the tests expect)
#   ./fork/start.sh latest     today's chain instead of the pinned block
#   FORK_NET=polkadot ./fork/start.sh    Polkadot Asset Hub (polkadot-asset-hub.yml); the tests take the same FORK_NET
#   FORK_ENDPOINT=wss://… ./fork/start.sh   fork from that node only
set -euo pipefail
cd "$(dirname "$0")/.."
NET="${FORK_NET:-kusama}"
CONFIG="fork/${NET}-asset-hub.yml"
[ -f "$CONFIG" ] || { echo "no $CONFIG"; exit 1; }
pkill -f "node_modules/.bin/chopsticks --config fork/" 2>/dev/null || true
sleep 1
ARGS=(--config "$CONFIG")
# FORK_ENDPOINT (set by fork/ci-run.sh): one node instead of the config's list.
[ -n "${FORK_ENDPOINT:-}" ] && ARGS+=(--endpoint "$FORK_ENDPOINT")
if [ "${1:-}" = "latest" ]; then
  N=$(curl -s -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"chain_getHeader","params":[]}' "https://${NET}-asset-hub-rpc.polkadot.io" | sed -E 's/.*"number":"(0x[0-9a-f]+)".*/\1/')
  ARGS+=(--block "$((N))")
fi
exec node node_modules/.bin/chopsticks "${ARGS[@]}"
