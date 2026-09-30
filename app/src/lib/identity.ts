import { useCallback, useSyncExternalStore } from "react";

import { DEMO_ENABLED } from "../config";
import { Actor, CAST, Persona, Role, personaActor } from "./actors";
import { useWalletActor } from "./hooks";

/** Per-role choice of who the user is acting as: a persona id or "wallet". */
const KEY = (role: Role) => `sikrit:acting:${role}`;
const EVENT = "sikrit:acting";

const subscribe = (onChange: () => void) => {
  window.addEventListener(EVENT, onChange);
  return () => window.removeEventListener(EVENT, onChange);
};

export function personasFor(role: Role): Persona[] {
  return DEMO_ENABLED ? CAST.filter((p) => p.role === role) : [];
}

export function useActor(role: Role) {
  const personas = personasFor(role);
  const fallback = personas[0]?.id ?? "wallet";
  const choice = useSyncExternalStore(subscribe, () => localStorage.getItem(KEY(role)) ?? fallback);
  const walletActor = useWalletActor();
  const persona = personas.find((p) => p.id === choice);
  const actor: Actor | undefined = choice === "wallet" ? walletActor : persona ? personaActor(persona) : undefined;
  const setChoice = useCallback(
    (next: string) => {
      localStorage.setItem(KEY(role), next);
      window.dispatchEvent(new Event(EVENT));
    },
    [role],
  );
  return { actor, choice, setChoice, personas, persona };
}
