import "./polyfills";
import "./index.css";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { RPC_URL } from "./config";

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
