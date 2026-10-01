import { PROGRAM_ID } from "@sdk/client";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { CLUSTER, DEMO_ENABLED, RPC_URL } from "../config";
import { Persona, Role, relayerKeypair, resetDemo } from "../lib/actors";
import { RELAYER_EVENT, balanceSol, connection, ensureFunded } from "../lib/chain";
import { short } from "../lib/format";
import { useActor } from "../lib/identity";
import { href, Route } from "../lib/router";
import { Spinner } from "./ui";
import { Seal } from "./visuals";

const NAV: { route: Route; label: string; role?: Role }[] = [
  { route: { page: "owner" }, label: "Owner", role: "owner" },
  { route: { page: "heir" }, label: "Heir", role: "heir" },
  { route: { page: "guardian" }, label: "Guardian", role: "guardian" },
];

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 border-b border-ink-700/80 bg-ink-950/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-5 py-3">
          <a href="#/" className="group flex items-center gap-3">
            <Seal label="S" size={34} className="transition group-hover:rotate-[-8deg]" />
            <span className="leading-none">
              <span className="block font-display text-xl tracking-wide text-bone-50">SIKRIT</span>
              <span className="block text-[0.62rem] tracking-[0.2em] text-bone-500 uppercase">dead man's switch</span>
            </span>
          </a>
          <nav className="ml-4 hidden items-center gap-1 sm:flex">
            {NAV.map((item) => {
              const active = route.page === item.route.page;
              return (
                <a
                  key={item.label}
                  href={href(item.route)}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                    active ? "bg-ink-800 text-bone-50" : "text-bone-400 hover:text-bone-100"
                  }`}
                >
                  {item.label}
                </a>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <ClusterBadge />
            <RelayerBadge />
            <WalletButton />
          </div>
        </div>
        <nav className="flex gap-1 border-t border-ink-800 px-5 py-2 sm:hidden">
          {NAV.map((item) => (
            <a key={item.label} href={href(item.route)} className={`rounded-md px-3 py-1 text-sm ${route.page === item.route.page ? "bg-ink-800 text-bone-50" : "text-bone-400"}`}>
              {item.label}
            </a>
          ))}
        </nav>
      </header>

      <ProgramNotice />
      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-10">{children}</main>

      <footer className="border-t border-ink-800">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-6 text-xs text-bone-500">
          <span>
            SIKRIT · research prototype by a cryptography student at Politeknik Siber dan Sandi Negara · unaudited ·{" "}
            {CLUSTER} only
          </span>
          {DEMO_ENABLED && (
            <button
              className="btn-quiet"
              onClick={() => {
                if (confirm("Forget all demo keys, invites and kits stored in this browser?")) {
                  resetDemo();
                  location.reload();
                }
              }}
            >
              Reset demo
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

/** Explains up front when the cluster has no SIKRIT program (e.g. devnet before deployment). */
function ProgramNotice() {
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    connection
      .getAccountInfo(PROGRAM_ID, "confirmed")
      .then((info) => setMissing(!info?.executable))
      .catch(() => {});
  }, []);
  if (!missing) return null;
  return (
    <div className="border-b border-amber-glow/40 bg-amber-glow/10">
      <p className="mx-auto max-w-6xl px-5 py-3 text-sm leading-relaxed text-amber-glow">
        The SIKRIT program is not deployed on {CLUSTER} yet, so capsules cannot be created here. Run the full demo
        locally with <span className="mono">cd app &amp;&amp; npm run localnet</span> (see the README).
      </p>
    </div>
  );
}

function ClusterBadge() {
  return (
    <span className="chip hidden border-ink-600 text-bone-300 md:inline-flex" title={RPC_URL}>
      <span className={`size-1.5 rounded-full ${CLUSTER === "devnet" ? "bg-verdigris-400" : "bg-amber-glow"}`} />
      {CLUSTER}
    </span>
  );
}

/** The relayer pays every fee; on localnet/devnet it can top itself up from the faucet. */
function RelayerBadge() {
  const [balance, setBalance] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const relayer = relayerKeypair().publicKey;

  useEffect(() => {
    let live = true;
    const load = () => balanceSol(relayer).then((b) => live && setBalance(b)).catch(() => live && setBalance(undefined));
    // Localnet's faucet is unlimited: fund the relayer up front instead of on the first action.
    if (CLUSTER === "localnet") void ensureFunded(relayer, 0.5, 5).then(load, () => {});
    void load();
    const id = setInterval(load, 8000);
    window.addEventListener(RELAYER_EVENT, load);
    return () => {
      live = false;
      clearInterval(id);
      window.removeEventListener(RELAYER_EVENT, load);
    };
  }, [relayer]);

  const fund = async () => {
    setBusy(true);
    setFailed(false);
    try {
      setBalance(await ensureFunded(relayer, 0.5, CLUSTER === "devnet" ? 1 : 5));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const low = balance !== undefined && balance < 0.05;
  return (
    <button
      className={`chip hidden md:inline-flex ${low || failed ? "border-seal-500/60 text-seal-300" : "border-ink-600 text-bone-300"}`}
      onClick={fund}
      title={`Relayer ${relayer.toBase58()} pays all fees. Click to request a faucet top-up.${failed ? " Faucet request failed — send devnet SOL to this address." : ""}`}
    >
      {busy ? <Spinner /> : <span className="text-bone-500">relayer</span>}
      {balance === undefined ? "offline" : `${balance.toFixed(3)} SOL`}
    </button>
  );
}

function WalletButton() {
  const { wallets, select, publicKey, disconnect, connecting, wallet } = useWallet();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const installed = wallets.filter((w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable);

  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button className="btn-ghost py-1.5 text-xs" onClick={() => setOpen((o) => !o)}>
        {connecting ? <Spinner /> : null}
        {publicKey ? `${wallet?.adapter.name ?? "Wallet"} · ${short(publicKey)}` : "Connect wallet"}
      </button>
      {open && (
        <div className="card absolute right-0 z-50 mt-2 w-72 space-y-1 p-2 animate-rise">
          {publicKey ? (
            <button className="btn-ghost w-full" onClick={() => (void disconnect(), setOpen(false))}>
              Disconnect
            </button>
          ) : installed.length ? (
            installed.map((w) => (
              <button
                key={w.adapter.name}
                className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-bone-100 hover:bg-ink-800"
                onClick={() => (select(w.adapter.name), setOpen(false))}
              >
                {w.adapter.icon && <img src={w.adapter.icon} alt="" className="size-5" />}
                {w.adapter.name}
              </button>
            ))
          ) : (
            <p className="px-3 py-2 text-sm leading-relaxed text-bone-400">
              No Solana wallet detected. Use the demo cast, or install Phantom, Solflare or Backpack.
            </p>
          )}
          <p className="px-3 pt-1 pb-2 text-[0.7rem] leading-relaxed text-bone-500">
            Wallets only sign messages to derive keys and co-sign heir/guardian actions. They never pay fees and never
            appear in the owner's heartbeats.
          </p>
        </div>
      )}
    </div>
  );
}

/** "Acting as": pick a demo persona for this role, or your connected wallet. */
export function ActingAs({ role }: { role: Role }) {
  const { choice, setChoice, personas, actor } = useActor(role);
  const { publicKey } = useWallet();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="eyebrow mr-1">Acting as</span>
      {personas.map((persona: Persona) => (
        <button
          key={persona.id}
          onClick={() => setChoice(persona.id)}
          className={`flex items-center gap-2 rounded-full border py-1 pr-3 pl-1 text-sm transition ${
            choice === persona.id ? "border-bone-300 bg-ink-800 text-bone-50" : "border-ink-700 text-bone-400 hover:border-ink-600 hover:text-bone-200"
          }`}
          title={persona.blurb}
        >
          <Seal label={persona.initials} tone={role === "owner" ? "seal" : role === "heir" ? "bone" : "life"} size={26} />
          {persona.name}
        </button>
      ))}
      <button
        onClick={() => setChoice("wallet")}
        className={`rounded-full border px-3 py-1.5 text-sm transition ${
          choice === "wallet" ? "border-bone-300 bg-ink-800 text-bone-50" : "border-ink-700 text-bone-400 hover:border-ink-600 hover:text-bone-200"
        }`}
      >
        {publicKey ? `My wallet · ${short(publicKey)}` : "My wallet"}
      </button>
      {choice === "wallet" && !actor && <span className="text-xs text-amber-glow">Connect a wallet that supports message signing (top right).</span>}
    </div>
  );
}
