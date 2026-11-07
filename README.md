# Decipool contracts

Solidity contracts for Decipool on Kusama and Polkadot Asset Hub (pallet-revive).

- `DecisionDepositPool.sol`: one pool per referendum. Birdbrain's version 2 contract from [decision-deposit](https://github.com/Birdbrain-wtf/decision-deposit) (`contracts/v2/`), unchanged, so their pools and ours run the same code. `check-upstream.ts` fails the build if it drifts from upstream.
- `DecisionDepositPoolFactory.sol`: deploys pools and indexes them by referendum and deposit. `isPool` lets the app tell a real pool from a lookalike. Minimum payment capped at 10% of the deposit, funding window at 30 days. Stray funds a pool can `sweep` go to whoever created it. No owner.
- `Refuser.sol`: test helper.

## Deployments

| Network | Factory |
|---|---|
| Paseo Asset Hub | `0x7995c6e87915ce01640290db35fea399e4f0566c` (v2, verified) |
| Kusama Asset Hub | not yet |
| Polkadot Asset Hub | not yet |

Earlier Paseo factories (v1 `0xe1b26daa9a9000bb7be8584b994e1f47fba9998e`, which makes version 1 pools, and two prototypes) are kept in `deployments/paseo.json`; their pools keep working.

## Usage

```sh
bun install
bun run check                          # upstream check, compile, typecheck
./fork/start.sh & bun factory-test.ts  # factory on a Kusama Asset Hub fork
./fork/start.sh & bun test.ts          # pool contract on the fork
```

Deploy and verify:

```sh
bun deploy.ts paseo factory
bun deploy.ts kusama factory --mainnet   # asks to type "deploy kusama"
bun verify.ts <network> <address> <constructorArgs> factory
```

`deploy.ts` checks the target chain first (genesis, chain id, Referenda call indices, NativeToEthRatio) and reads the parameters back after deployment. Keys go in `keys/` (ignored). After a deploy, run `bun run abi:sync` in the app.

## License

Apache-2.0. See `NOTICE` for what comes from Birdbrain.
