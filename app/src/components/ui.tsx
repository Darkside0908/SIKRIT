import { useState, type ReactNode } from "react";

import { explorerAddress, explorerTx } from "../config";
import { short } from "../lib/format";

export function Notice({ tone = "info", children, onClose }: { tone?: "info" | "error" | "success" | "warn"; children: ReactNode; onClose?: () => void }) {
  const styles = {
    info: "border-ink-600 bg-ink-850/80 text-bone-200",
    error: "border-seal-600/70 bg-seal-800/25 text-seal-300",
    success: "border-verdigris-500/60 bg-verdigris-800/30 text-verdigris-300",
    warn: "border-amber-glow/50 bg-amber-glow/5 text-amber-glow",
  }[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm leading-relaxed ${styles}`}>
      <div className="flex-1">{children}</div>
      {onClose && (
        <button className="btn-quiet -my-1 -mr-2" onClick={onClose} aria-label="Dismiss">
          ✕
        </button>
      )}
    </div>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return <span className={`inline-block size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent ${className}`} aria-hidden />;
}

/** Busy-aware button: shows the action's label while it runs. */
export function ActionButton({
  busy,
  label,
  busyLabel,
  className = "btn-seal",
  ...props
}: {
  busy?: string;
  label: ReactNode;
  busyLabel: string;
  className?: string;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className">) {
  const running = busy === busyLabel;
  return (
    <button {...props} className={className} disabled={props.disabled || Boolean(busy)}>
      {running && <Spinner />}
      {running ? `${busyLabel}…` : label}
    </button>
  );
}

export function Copyable({ text, display, className = "" }: { text: string; display?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`group inline-flex max-w-full items-center gap-2 text-left mono text-bone-200 hover:text-bone-50 ${className}`}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        });
      }}
      title="Copy"
    >
      <span className="truncate">{display ?? text}</span>
      <span className="shrink-0 text-[0.65rem] tracking-widest text-bone-500 uppercase group-hover:text-bone-300">{copied ? "copied" : "copy"}</span>
    </button>
  );
}

export function TxLink({ signature }: { signature: string }) {
  return (
    <a className="mono text-bone-300 underline decoration-ink-600 underline-offset-4 hover:text-bone-50" href={explorerTx(signature)} target="_blank" rel="noreferrer">
      tx {short(signature, 6, 6)} ↗
    </a>
  );
}

export function AddressLink({ address, label }: { address: string; label?: string }) {
  return (
    <a className="mono text-bone-300 underline decoration-ink-600 underline-offset-4 hover:text-bone-50" href={explorerAddress(address)} target="_blank" rel="noreferrer">
      {label ?? short(address)} ↗
    </a>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-2">
      <span className="eyebrow">{label}</span>
      {children}
      {hint && <span className="block text-xs leading-relaxed text-bone-500">{hint}</span>}
    </label>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="eyebrow">{label}</div>
      <div className="text-bone-50">{value}</div>
      {sub && <div className="text-xs text-bone-500">{sub}</div>}
    </div>
  );
}

export type StatusTone = "active" | "claimPending" | "claimed" | "none";

export function StatusChip({ status }: { status: StatusTone }) {
  const map = {
    active: ["Alive", "border-verdigris-500/60 text-verdigris-300", "bg-verdigris-400"],
    claimPending: ["Claim pending", "border-amber-glow/60 text-amber-glow", "bg-amber-glow"],
    claimed: ["Released", "border-seal-500/70 text-seal-300", "bg-seal-400"],
    none: ["Not created", "border-ink-600 text-bone-400", "bg-ink-600"],
  } as const;
  const [label, style, dot] = map[status];
  return (
    <span className={`chip ${style}`}>
      <span className={`size-1.5 rounded-full ${dot} ${status === "claimPending" ? "animate-flicker" : ""}`} />
      {label}
    </span>
  );
}

/** Section heading with an engraved rule. */
export function Heading({ eyebrow, title, children }: { eyebrow?: string; title: ReactNode; children?: ReactNode }) {
  return (
    <header className="space-y-3">
      {eyebrow && <div className="eyebrow">{eyebrow}</div>}
      <h1 className="font-display text-4xl leading-[1.05] text-bone-50 sm:text-5xl">{title}</h1>
      {children && <p className="max-w-2xl text-[0.95rem] leading-relaxed text-bone-300">{children}</p>}
    </header>
  );
}
