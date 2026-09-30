export type Cluster = "localnet" | "devnet";

const env = import.meta.env;

/** Cluster the app talks to: `VITE_CLUSTER`, else devnet in production builds and localnet in dev. */
export const CLUSTER: Cluster = env.VITE_CLUSTER === "devnet" || env.VITE_CLUSTER === "localnet"
  ? env.VITE_CLUSTER
  : env.PROD ? "devnet" : "localnet";

export const RPC_URL: string =
  env.VITE_RPC_URL || (CLUSTER === "devnet" ? "https://api.devnet.solana.com" : "http://127.0.0.1:8899");

/** Demo cast (in-browser persona wallets). On by default; `VITE_DEMO=false` hides it. */
export const DEMO_ENABLED = env.VITE_DEMO !== "false";

export function explorerTx(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}${explorerCluster()}`;
}

export function explorerAddress(address: string): string {
  return `https://explorer.solana.com/address/${address}${explorerCluster()}`;
}

function explorerCluster(): string {
  return CLUSTER === "devnet" && !env.VITE_RPC_URL
    ? "?cluster=devnet"
    : `?cluster=custom&customUrl=${encodeURIComponent(RPC_URL)}`;
}
