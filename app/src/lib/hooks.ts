import { CapsuleAccount, decodeCapsule, explainError, fetchCapsule } from "@sdk/client";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import type { Actor } from "./actors";
import { connection, readChainTime } from "./chain";

// --- Cluster clock -------------------------------------------------------------
// Countdowns follow the chain's Clock sysvar (what the program enforces), re-synced every 15 s
// and interpolated locally in between.

let offsetMs: number | undefined;
let tick = 0;
const clockListeners = new Set<() => void>();

async function syncClock(): Promise<void> {
  try {
    const chainTime = await readChainTime();
    offsetMs = Number(chainTime) * 1000 - Date.now();
  } catch {
    // RPC unreachable: keep the last offset; the UI shows a connection notice elsewhere.
  }
}

let clockStarted = false;
function startClock(): void {
  if (clockStarted) return;
  clockStarted = true;
  void syncClock();
  setInterval(() => void syncClock(), 15_000);
  setInterval(() => {
    tick++;
    clockListeners.forEach((listener) => listener());
  }, 1000);
}

const subscribeClock = (listener: () => void) => {
  startClock();
  clockListeners.add(listener);
  return () => clockListeners.delete(listener);
};

/** Current cluster unix time in seconds (undefined until the first sync). */
export function useChainNow(): bigint | undefined {
  useSyncExternalStore(subscribeClock, () => tick);
  return offsetMs === undefined ? undefined : BigInt(Math.floor((Date.now() + offsetMs) / 1000));
}

export const resyncClock = syncClock;

// --- Capsule account -----------------------------------------------------------

/** Live view of one capsule: undefined while loading, null if it does not exist. */
export function useCapsule(address: PublicKey | undefined) {
  const key = address?.toBase58();
  const [capsule, setCapsule] = useState<CapsuleAccount | null | undefined>(undefined);
  const [error, setError] = useState<string>();
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!key) {
      setCapsule(undefined);
      return;
    }
    const target = new PublicKey(key);
    let live = true;
    fetchCapsule(connection, target)
      .then((value) => live && (setCapsule(value), setError(undefined)))
      .catch((e) => live && setError(explainError(e)));
    const subscription = connection.onAccountChange(
      target,
      (info) => {
        try {
          setCapsule(decodeCapsule(info.data));
        } catch {
          /* ignore non-capsule data */
        }
      },
      "confirmed",
    );
    return () => {
      live = false;
      void connection.removeAccountChangeListener(subscription);
    };
  }, [key, version]);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  return { capsule, error, refresh };
}

/**
 * Polls an async loader (capsule lists), with manual refresh. Public RPCs rate-limit `getProgramAccounts`, so a tick
 * is skipped while the last load is still running (web3.js retries a 429 with backoff) or the tab is hidden.
 * Capsules already on screen stay live through `useCapsule`'s subscription; polling only discovers new ones.
 */
export function usePolling<T>(load: (() => Promise<T>) | undefined, deps: unknown[], everyMs = 15_000) {
  const [value, setValue] = useState<T>();
  const [error, setError] = useState<string>();
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!load) {
      setValue(undefined);
      return;
    }
    let live = true;
    let loading = false;
    const run = () => {
      if (loading || document.visibilityState === "hidden") return;
      loading = true;
      load()
        .then((v) => live && (setValue(v), setError(undefined)))
        .catch((e) => live && setError(explainError(e)))
        .finally(() => (loading = false));
    };
    run();
    const id = setInterval(run, everyMs);
    document.addEventListener("visibilitychange", run);
    return () => {
      live = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", run);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);
  return { value, error, refresh: useCallback(() => setVersion((v) => v + 1), []) };
}

// --- Actions ---------------------------------------------------------------------

/** Runs one user action at a time with a busy label and a human-readable error. */
export function useAction() {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const run = useCallback(async <T,>(label: string, action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(label);
    setError(undefined);
    try {
      return await action();
    } catch (e) {
      console.error(e);
      setError(explainError(e));
      return undefined;
    } finally {
      setBusy(undefined);
    }
  }, []);
  return { busy, error, run, clearError: useCallback(() => setError(undefined), []) };
}

// --- Wallet adapter → Actor -------------------------------------------------------------

export function useWalletActor(): Actor | undefined {
  const { publicKey, signMessage, signTransaction, wallet } = useWallet();
  return useMemo(() => {
    if (!publicKey || !signMessage || !signTransaction) return undefined;
    return {
      kind: "wallet",
      id: "wallet",
      name: wallet?.adapter.name ?? "Wallet",
      publicKey,
      signMessage,
      signTransaction,
    } satisfies Actor;
  }, [publicKey, signMessage, signTransaction, wallet]);
}
