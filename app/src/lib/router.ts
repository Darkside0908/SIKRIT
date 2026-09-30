import { useSyncExternalStore } from "react";

/** Minimal hash router: static hosting (Vercel, IPFS) needs no rewrites. */
export type Route =
  | { page: "home" }
  | { page: "owner" }
  | { page: "heir" }
  | { page: "guardian" }
  | { page: "capsule"; address: string };

export function parseRoute(hash: string): Route {
  const [, page, arg] = hash.replace(/^#/, "").split("/");
  switch (page) {
    case "owner":
    case "heir":
    case "guardian":
      return { page };
    case "capsule":
      return arg ? { page: "capsule", address: arg } : { page: "home" };
    default:
      return { page: "home" };
  }
}

const subscribe = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseRoute(hash);
}

export const href = (route: Route): string =>
  route.page === "home" ? "#/" : route.page === "capsule" ? `#/capsule/${route.address}` : `#/${route.page}`;

export const navigate = (route: Route): void => {
  window.location.hash = href(route);
  window.scrollTo({ top: 0, behavior: "smooth" });
};
