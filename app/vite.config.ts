import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Connect, type Plugin } from "vite";

import { createRelay, relayHandler, rpcChain, type RelayChain } from "./api/relay.ts";

const DEFAULT_RPC = {
  localnet: "http://127.0.0.1:8899",
  devnet: "https://api.devnet.solana.com",
};

/**
 * Production builds get a strict Content-Security-Policy: no third-party scripts, fonts or
 * analytics, and network access only to the configured RPC. (Dev mode skips it because React
 * Refresh injects an inline preamble.)
 */
function contentSecurityPolicy(rpcUrls: string[]): Plugin {
  const origins = new Set<string>();
  for (const url of rpcUrls) {
    const { protocol, host } = new URL(url);
    origins.add(`${protocol}//${host}`);
    origins.add(`${protocol === "https:" ? "wss:" : "ws:"}//${host}`);
    // web3.js opens its signature-subscription websocket on port + 1 for plain-http RPCs.
    if (protocol === "http:") {
      const [hostname, port] = host.split(":");
      if (port) origins.add(`ws://${hostname}:${Number(port) + 1}`);
    }
  }
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data:",
    `connect-src 'self' ${[...origins].join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join("; ");
  return {
    name: "sikrit-csp",
    apply: "build",
    transformIndexHtml: (html) =>
      html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`),
  };
}

/**
 * Mounts the relayer service (api/relay.ts, a Vercel function in production) on `vite dev` and `vite preview`, so
 * local runs go through the same code. Its key is RELAYER_SECRET_KEY or, on localnet, a fresh key that the local
 * faucet keeps topped up. With neither (a devnet preview without a key), or with RELAYER=browser, nothing is
 * mounted and the app falls back to its in-browser relayer, as on GitHub Pages.
 */
function relayerService(rpcUrl: string, localnet: boolean): Plugin {
  const mount = (middlewares: Connect.Server) => {
    const configured = process.env.RELAYER_SECRET_KEY;
    if (process.env.RELAYER === "browser" || (!configured && !localnet)) return;
    const keypair = configured ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(configured))) : Keypair.generate();
    let chain: RelayChain = rpcChain(rpcUrl);
    if (!configured) {
      const rpc = chain;
      const connection = new Connection(rpcUrl, "confirmed");
      chain = {
        sendRawTransaction: rpc.sendRawTransaction,
        async getBalance(address) {
          if ((await rpc.getBalance(address)) < LAMPORTS_PER_SOL) {
            const signature = await connection.requestAirdrop(new PublicKey(address), 10 * LAMPORTS_PER_SOL);
            await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash()) }, "confirmed");
          }
          return rpc.getBalance(address);
        },
      };
      void chain.getBalance(keypair.publicKey.toBase58()).catch(() => {}); // fund up front when the validator is up
    }
    middlewares.use("/api/relay", relayHandler(createRelay({ secretKey: keypair.secretKey, chain })));
  };
  return {
    name: "sikrit-relayer",
    configureServer: (server) => mount(server.middlewares),
    configurePreviewServer: (server) => mount(server.middlewares),
  };
}

// The SDK in ../sdk is shared with the Anchor test suite. `dedupe` makes its bare imports
// (@solana/web3.js, noble, shamir) resolve to this app's node_modules, so there is exactly one
// copy of each library in the bundle and the app builds without the root workspace installed.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const rpcUrls = [env.VITE_RPC_URL, DEFAULT_RPC.localnet, "http://localhost:8899", DEFAULT_RPC.devnet].filter(
    (url): url is string => Boolean(url),
  );
  // Same rule as src/config.ts: VITE_CLUSTER, else localnet for `vite dev` and devnet for production builds/preview.
  const cluster = env.VITE_CLUSTER === "devnet" || env.VITE_CLUSTER === "localnet" ? env.VITE_CLUSTER : mode === "development" ? "localnet" : "devnet";
  const relayerRpc = process.env.RPC_URL || env.VITE_RPC_URL || DEFAULT_RPC[cluster];
  return {
    // Relative asset URLs + the hash router: the build runs from any static host or subpath
    // (Vercel, GitHub Pages project sites, IPFS) without rewrites.
    base: "./",
    plugins: [react(), tailwindcss(), contentSecurityPolicy(rpcUrls), relayerService(relayerRpc, cluster === "localnet")],
    resolve: {
      alias: { "@sdk": fileURLToPath(new URL("../sdk", import.meta.url)) },
      dedupe: ["@solana/web3.js", "@noble/ciphers", "@noble/curves", "@noble/hashes", "shamir-secret-sharing", "buffer"],
    },
    define: { global: "globalThis" },
    server: { fs: { allow: [".."] }, port: 5173 },
    build: { target: "es2022", sourcemap: true, chunkSizeWarningLimit: 1200 },
  };
});
