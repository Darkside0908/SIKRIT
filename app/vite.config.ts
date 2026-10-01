import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";

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

// The SDK in ../sdk is shared with the Anchor test suite. `dedupe` makes its bare imports
// (@solana/web3.js, noble, shamir) resolve to this app's node_modules, so there is exactly one
// copy of each library in the bundle and the app builds without the root workspace installed.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const rpcUrls = [env.VITE_RPC_URL, DEFAULT_RPC.localnet, "http://localhost:8899", DEFAULT_RPC.devnet].filter(
    (url): url is string => Boolean(url),
  );
  return {
    // Relative asset URLs + the hash router: the build runs from any static host or subpath
    // (Vercel, GitHub Pages project sites, IPFS) without rewrites.
    base: "./",
    plugins: [react(), tailwindcss(), contentSecurityPolicy(rpcUrls)],
    resolve: {
      alias: { "@sdk": fileURLToPath(new URL("../sdk", import.meta.url)) },
      dedupe: ["@solana/web3.js", "@noble/ciphers", "@noble/curves", "@noble/hashes", "shamir-secret-sharing", "buffer"],
    },
    define: { global: "globalThis" },
    server: { fs: { allow: [".."] }, port: 5173 },
    build: { target: "es2022", sourcemap: true, chunkSizeWarningLimit: 1200 },
  };
});
