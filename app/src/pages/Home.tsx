import { Ecg, Seal } from "../components/visuals";
import { CAST } from "../lib/actors";
import { href } from "../lib/router";

const STEPS = [
  {
    numeral: "I",
    title: "Seal",
    body: "Your secret is encrypted in your browser under a one-time key. The key is split with Shamir's scheme — one share for your heir, one per guardian — and each share is sealed (HPKE, RFC 9180) to a key its holder's wallet has signed for.",
    detail: "Only share hashes go on-chain.",
  },
  {
    numeral: "II",
    title: "Prove you're alive",
    body: "A Schnorr zero-knowledge proof that you still hold your liveness key, verified on-chain with Solana's curve25519 syscalls. No wallet signs it, a relayer pays for it, and every proof is bound to a counter, so it works exactly once.",
    detail: "≈ 41,000 compute units.",
  },
  {
    numeral: "III",
    title: "Release on silence",
    body: "Miss your interval and anyone may open a claim. A heartbeat still cancels it; guardians can veto a false alarm. Once the grace period passes and a guardian quorum confirms, your heir claims — and only then do guardians release their shares.",
    detail: "The secret reassembles in the heir's browser.",
  },
];

export function Home() {
  return (
    <div className="space-y-28 pb-10">
      {/* Hero */}
      <section className="grid items-center gap-14 pt-6 lg:grid-cols-[1.25fr_1fr]">
        <div className="space-y-8">
          <div className="eyebrow animate-rise">Solana · zero-knowledge proof of life · Shamir + HPKE</div>
          <h1 className="font-display text-[clamp(3rem,7vw,5.6rem)] leading-[0.95] text-bone-50 animate-rise [animation-delay:80ms]">
            Don't take your keys <span className="text-seal-400 italic">to the grave.</span>
          </h1>
          <p className="max-w-xl text-lg leading-relaxed text-bone-300 animate-rise [animation-delay:160ms]">
            SIKRIT is a dead man's switch where proving you're alive says nothing about who you are. Your heir
            inherits your seed phrase only after you fall silent — and only with your guardians' consent.
          </p>
          <div className="flex flex-wrap gap-3 animate-rise [animation-delay:240ms]">
            <a href={href({ page: "owner" })} className="btn-seal px-6 py-3 text-base">
              Start the demo as Pak Arif
            </a>
            <a href="#how" className="btn-ghost px-6 py-3 text-base" onClick={(e) => (e.preventDefault(), document.getElementById("how")?.scrollIntoView({ behavior: "smooth" }))}>
              How it works
            </a>
          </div>
        </div>

        {/* The testament card */}
        <div className="relative animate-rise [animation-delay:200ms]">
          <div className="card ledger rotate-[1.5deg] space-y-5 p-7">
            <div className="flex items-center justify-between">
              <span className="eyebrow">Capsule · 9mXq…T2vA</span>
              <span className="chip border-verdigris-500/60 text-verdigris-300">
                <span className="size-1.5 animate-flicker rounded-full bg-verdigris-400" /> alive
              </span>
            </div>
            <dl className="space-y-3 text-sm">
              <Row label="Owner" value={<span className="redact w-32" />} />
              <Row label="Heir" value={<span className="mono text-bone-200">Fs3k…9hQe</span>} />
              <Row label="Guardians" value={<span className="text-bone-200">2 of 3 must confirm</span>} />
              <Row label="Last proof" value={<span className="mono text-verdigris-300">heartbeat(R, s) ✓</span>} />
              <Row label="Signed by owner" value={<span className="stamp border-verdigris-400 text-verdigris-300">never</span>} />
            </dl>
            <Ecg vital="alive" />
          </div>
          <Seal label="S" size={92} className="absolute -right-4 -bottom-8 rotate-[14deg] drop-shadow-[0_12px_18px_rgba(0,0,0,0.6)]" />
        </div>
      </section>

      {/* Tension */}
      <section className="grid gap-10 border-y border-ink-800 py-14 md:grid-cols-2">
        <p className="font-display text-3xl leading-snug text-bone-100 sm:text-4xl">
          Self-custody has no “forgot password” — and no next of kin.
        </p>
        <div className="space-y-4 text-bone-300">
          <p className="leading-relaxed">
            Your family must be able to open your wallet when you are gone, and must <em>never</em> be able to while you
            are alive. Existing dead man's switches solve this with a public check-in signed by your wallet — a
            broadcast, every week, that this address is alive and active.
          </p>
          <p className="leading-relaxed">
            SIKRIT replaces the check-in with a zero-knowledge proof from a key that is not your wallet, sent by a
            relayer. The chain learns that <em>someone who knows x</em> is alive. Not who.
          </p>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="scroll-mt-24 space-y-10">
        <div className="eyebrow">How it works</div>
        <div className="grid gap-6 md:grid-cols-3">
          {STEPS.map((step, i) => (
            <article key={step.numeral} className="card space-y-4 p-7 animate-rise" style={{ animationDelay: `${i * 90}ms` }}>
              <div className="font-display text-5xl text-seal-400/80">{step.numeral}</div>
              <h3 className="font-display text-2xl text-bone-50">{step.title}</h3>
              <p className="text-sm leading-relaxed text-bone-300">{step.body}</p>
              <p className="text-xs text-bone-500">{step.detail}</p>
            </article>
          ))}
        </div>
      </section>

      {/* What the chain sees */}
      <section className="space-y-8">
        <div className="space-y-3">
          <div className="eyebrow">What the chain sees, every heartbeat</div>
          <h2 className="font-display text-4xl text-bone-50">A proof, not a person.</h2>
        </div>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="card space-y-4 p-6">
            <div className="text-sm font-semibold text-bone-400">A typical on-chain check-in</div>
            <pre className="mono overflow-x-auto rounded-lg border border-ink-700 bg-ink-950/60 p-4 leading-relaxed text-bone-300">{`check_in()
  signer:   7xKp…owner wallet   ← public
  account:  vault of 7xKp…      ← derived from it
  → "7xKp… is alive, today"`}</pre>
          </div>
          <div className="card space-y-4 border-verdigris-500/30 p-6">
            <div className="text-sm font-semibold text-verdigris-300">A SIKRIT heartbeat</div>
            <pre className="mono overflow-x-auto rounded-lg border border-ink-700 bg-ink-950/60 p-4 leading-relaxed text-bone-200">{`heartbeat(R, s)
  signer:   relayer (fee payer only)
  account:  PDA("capsule", P)   ← P = x·G, not a wallet
  → "whoever knows x is alive"`}</pre>
          </div>
        </div>
        <p className="max-w-3xl text-sm leading-relaxed text-bone-500">
          Honest limits: the time of each heartbeat is public, and a family member becomes visible the moment they act
          (a guardian confirming, the heir claiming). What no observer can learn is which wallet, which person, the
          capsule belongs to, or who stands to inherit it before they claim. The full threat model and every self-audit
          finding are in the security review.
        </p>
      </section>

      {/* Numbers */}
      <section className="grid grid-cols-2 gap-6 md:grid-cols-4">
        {[
          ["41k", "compute units to verify a heartbeat proof"],
          ["0", "owner wallets in any capsule transaction"],
          ["5,000", "lamports per heartbeat — no token"],
          ["73", "tests, incl. RFC 9180 & FIPS-197 vectors"],
        ].map(([figure, caption], i) => (
          <div key={caption} className="space-y-2 border-l border-ink-700 pl-5 animate-rise" style={{ animationDelay: `${i * 80}ms` }}>
            <div className="font-display text-5xl text-bone-50">{figure}</div>
            <div className="text-sm leading-snug text-bone-400">{caption}</div>
          </div>
        ))}
      </section>

      {/* Cast */}
      <section className="card ledger grid gap-8 p-8 md:grid-cols-[1fr_1.2fr] md:items-center">
        <div className="space-y-4">
          <div className="eyebrow">The demo</div>
          <h2 className="font-display text-3xl text-bone-50">One family, five wallets, one browser.</h2>
          <p className="text-sm leading-relaxed text-bone-300">
            Pak Arif seals his seed phrase for his daughter Sari, with Budi, Dewi and Rizal as guardians. Each persona is
            a real keypair on {""}
            the cluster; switch between them with one click. Short demo intervals let a whole inheritance play out in
            a few minutes. Real wallets work too.
          </p>
          <a href={href({ page: "owner" })} className="btn-seal">
            Begin as Pak Arif
          </a>
        </div>
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {CAST.map((persona) => (
            <li key={persona.id} className="flex items-center gap-3">
              <Seal label={persona.initials} tone={persona.role === "owner" ? "seal" : persona.role === "heir" ? "bone" : "life"} size={44} />
              <div>
                <div className="text-sm font-semibold text-bone-100">{persona.name}</div>
                <div className="text-xs text-bone-500">{persona.role}</div>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-ink-700/60 pb-2">
      <dt className="text-bone-500">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
