import "./polyfills";
import "./index.css";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { RPC_URL } from "./config";

// The app asks wallets to sign key-derivation messages, so it must never run inside someone else's
// frame (clickjacking). Vercel sends frame-ancestors 'none'; hosts without headers rely on this.
if (window.top !== window.self) throw new Error("SIKRIT refuses to run inside a frame");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: "confirmed" }}>
      {/* Wallet Standard wallets (Phantom, Solflare, Backpack…) are detected automatically. */}
      <WalletProvider wallets={[]} autoConnect>
        <App />
      </WalletProvider>
    </ConnectionProvider>
  </StrictMode>,
);
