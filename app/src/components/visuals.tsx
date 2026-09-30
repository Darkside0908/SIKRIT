import { useId } from "react";

import { clock } from "../lib/format";

type SealTone = "seal" | "life" | "bone" | "ash";

const SEAL_FILL: Record<SealTone, [string, string, string]> = {
  seal: ["#e8674a", "#b5341c", "#6e1c0f"],
  life: ["#9ccfb8", "#5c9c83", "#244a3c"],
  bone: ["#f3ead9", "#bfb198", "#6f6452"],
  ash: ["#5a5146", "#342e27", "#1b1814"],
};

/** Wax seal with a monogram: used for personas, sealed shares and the brand mark. */
export function Seal({
  label = "S",
  tone = "seal",
  size = 44,
  className = "",
  title,
}: {
  label?: string;
  tone?: SealTone;
  size?: number;
  className?: string;
  title?: string;
}) {
  const id = useId();
  const [light, mid, dark] = SEAL_FILL[tone];
  const ink = tone === "bone" ? "#3a3128" : "#fbeee4";
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} role="img" aria-label={title ?? label}>
      {title && <title>{title}</title>}
      <defs>
        <radialGradient id={`${id}-g`} cx="38%" cy="32%" r="75%">
          <stop offset="0" stopColor={light} />
          <stop offset="0.55" stopColor={mid} />
          <stop offset="1" stopColor={dark} />
        </radialGradient>
      </defs>
      <path
        fill={`url(#${id}-g)`}
        d="M32 3c3 0 4 3 7 3.5s6-1.5 8 .5 0 5 2 7.5 5.5 2 6.5 5-2 4.5-1.5 7.5 3.5 5 2.5 8-4.5 3-6 5.5-1 6-3.5 7.5-5.5-.5-8 1-3.5 4.5-7 4.5-4-3-7-3.5-6 1.5-8-.5 0-5-2-7.5-5.5-2-6.5-5 2-4.5 1.5-7.5S3.5 33 4.5 30s4.5-3 6-5.5 1-6 3.5-7.5 5.5.5 8-1S29 3 32 3z"
      />
      <circle cx="32" cy="32" r="18.5" fill="none" stroke={ink} strokeOpacity="0.35" strokeWidth="1.2" />
      <circle cx="32" cy="32" r="16" fill="none" stroke="#000" strokeOpacity="0.18" strokeWidth="1" />
      <text
        x="32"
        y="33"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="Gloock, Georgia, serif"
        fontSize={label.length > 1 ? 15 : 22}
        fill={ink}
        fillOpacity="0.92"
        letterSpacing={label.length > 1 ? "0.5" : "0"}
      >
        {label}
      </text>
    </svg>
  );
}

export type Vital = "alive" | "pending" | "flat" | "idle";

const BEAT = "L30,50 Q35,43 40,50 L46,50 L50,18 L55,80 L59,50 L70,50 Q78,38 86,50 L100,50";

/** Electrocardiogram trace: steady beats while alive, faltering when a claim is pending, flat when claimed. */
export function Ecg({ vital, beatKey = 0, className = "" }: { vital: Vital; beatKey?: number; className?: string }) {
  const id = useId();
  const segments = 6;
  let d = "M0,50";
  for (let i = 0; i < segments; i++) {
    const beat = BEAT.replace(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g, (_, x, y) => `${Number(x) + i * 100},${y}`);
    // Pending: only every other beat fires, and weaker.
    const weak = vital === "pending" && i % 2 === 1;
    d += " " + (vital === "flat" || vital === "idle" || weak ? `L${(i + 1) * 100},50` : beat);
  }
  const color =
    vital === "alive" ? "var(--color-verdigris-400)" : vital === "pending" ? "var(--color-amber-glow)" : vital === "flat" ? "var(--color-seal-500)" : "var(--color-ink-600)";
  const length = 1600;
  return (
    <svg viewBox="0 0 600 100" preserveAspectRatio="none" className={`h-16 w-full ${className}`} aria-hidden>
      <defs>
        <linearGradient id={`${id}-fade`} x1="0" x2="1">
          <stop offset="0" stopColor="#000" stopOpacity="1" />
          <stop offset="0.08" stopColor="#fff" stopOpacity="1" />
          <stop offset="0.92" stopColor="#fff" stopOpacity="1" />
          <stop offset="1" stopColor="#000" stopOpacity="1" />
        </linearGradient>
        <mask id={`${id}-mask`}>
          <rect width="600" height="100" fill={`url(#${id}-fade)`} />
        </mask>
      </defs>
      <g mask={`url(#${id}-mask)`}>
        <path d="M0,50 L600,50" stroke="var(--color-ink-700)" strokeWidth="1" strokeDasharray="2 6" />
        <path d={d} fill="none" stroke={color} strokeOpacity="0.28" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
        {vital !== "idle" && (
          <path
            key={beatKey}
            d={d}
            fill="none"
            stroke={color}
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            strokeDasharray={`140 ${length}`}
            style={{
              ["--trace-length" as string]: `${length + 140}`,
              animation: `trace ${vital === "flat" ? 5 : vital === "pending" ? 3.6 : 2.4}s linear infinite`,
              filter: `drop-shadow(0 0 6px ${color})`,
            }}
          />
        )}
      </g>
    </svg>
  );
}

/** Oversized countdown numerals. */
export function Countdown({ seconds, tone = "bone" }: { seconds: bigint | number; tone?: "bone" | "seal" | "life" | "amber" }) {
  const color =
    tone === "seal" ? "text-seal-400" : tone === "life" ? "text-verdigris-300" : tone === "amber" ? "text-amber-glow" : "text-bone-50";
  return <span className={`font-display text-5xl leading-none tabular-nums sm:text-6xl ${color}`}>{clock(seconds)}</span>;
}
