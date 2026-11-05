// Modified from Birdbrain's decision-deposit (Apache-2.0) for Decipool, November 2026: adds Polkadot and the fork endpoints.
// Per-chain deployment parameters.
export const NETWORKS = {
  kusama: {
    name: "Kusama Asset Hub", symbol: "KSM", chainId: 420420418,
    eth: "https://eth-rpc-kusama.polkadot.io", ws: "wss://kusama-asset-hub-rpc.polkadot.io",
    explorer: "https://blockscout-kusama.polkadot.io", subsquare: "https://kusama.subsquare.io/referenda/",
    genesis: "0x48239ef607d7928874027a43a67689209727dfb3d3dc5e5b03a39bdc2eda771a",
    referendaPallet: 92, place: 1, refund: 2, weiPerPlanck: 1_000_000n, planckPerUnit: 1_000_000_000_000n,
  },
  paseo: {
    name: "Paseo Asset Hub", symbol: "PAS", chainId: 420420417, test: true,
    eth: "https://eth-rpc-testnet.polkadot.io", ws: "wss://asset-hub-paseo-rpc.n.dwellir.com",
    explorer: "https://blockscout-testnet.polkadot.io", subsquare: "https://paseo.subsquare.io/referenda/",
    genesis: "0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2",
    referendaPallet: 62, place: 1, refund: 2, weiPerPlanck: 100_000_000n, planckPerUnit: 10_000_000_000n,
  },
  polkadot: {
    name: "Polkadot Asset Hub", symbol: "DOT", chainId: 420420419,
    eth: "https://eth-rpc.polkadot.io", ws: "wss://polkadot-asset-hub-rpc.polkadot.io",
    explorer: "https://blockscout.polkadot.io", subsquare: "https://polkadot.subsquare.io/referenda/",
    genesis: "0x68d56f15f85d3136970ec16946040bc1752654e906147f7e43e9d539d7c3de2f",
    referendaPallet: 62, place: 1, refund: 2, weiPerPlanck: 100_000_000n, planckPerUnit: 10_000_000_000n,
  },
} as const;
export type Net = keyof typeof NETWORKS;
