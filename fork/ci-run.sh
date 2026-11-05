#!/usr/bin/env bash
# CI wrapper: fresh fork from the fastest node (pick-endpoint.ts), 7 min cap, one retry.
#   FORK_NET=polkadot fork/ci-run.sh bun ui-test/lifecycle-e2e.ts
set -uo pipefail
cd "$(dirname "$0")/.."
CONFIG="fork/${FORK_NET:-kusama}-asset-hub.yml"
CAP=(); command -v timeout >/dev/null && CAP=(timeout 420)   # GNU timeout (CI); macOS has none: no cap
for attempt in 1 2; do
  FORK_ENDPOINT=$(bun fork/pick-endpoint.ts "$CONFIG") || FORK_ENDPOINT=""
  echo "attempt $attempt: forking from ${FORK_ENDPOINT:-every node in the config}"
  FORK_ENDPOINT="$FORK_ENDPOINT" ./fork/start.sh > fork.log 2>&1 &   # start.sh stops any earlier fork first
  for _ in $(seq 1 90); do grep -q "8010" fork.log && break; sleep 2; done
  if grep -q "8010" fork.log && "${CAP[@]}" "$@"; then exit 0; fi
  [ "$attempt" = 1 ] && echo "::warning::'$*' failed on the first fork (slow public RPCs?): retrying once on a fresh fork"
done
exit 1
