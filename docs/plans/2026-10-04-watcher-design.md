# Watcher design (4 Oct 2026)

**Problem (R8).** A living owner who misses a heartbeat may not notice that a claim opened. The grace period exists so
they can cancel it, but only if something tells them. The app shows the state when it is open; nothing warns an owner
who is not looking.

**Constraint.** SIKRIT hides which capsule belongs to whom. A watcher that asks an RPC about one capsule every minute
tells that RPC (and anyone running the watcher as a service) "this IP cares about capsule C", the exact link the
protocol avoids. The program is live on devnet and must not change for this.

## Approaches considered

| | How it learns of a claim | Privacy towards the RPC | Robustness |
|---|---|---|---|
| A. Poll your capsule (`getAccountInfo`) | state of one account | **leaks** the capsule you care about, every poll | good |
| B. Subscribe to program logs (`logsSubscribe`) | `ClaimTriggered` events of every capsule, filtered locally | private | a dropped websocket misses events; log parsing must track the invocation stack or a foreign program can spoof events |
| C. **Scan every capsule** (`getProgramAccounts`) | state of every capsule, filtered locally | private | a missed poll is caught by the next one; state, not events |

**Chosen: C.** Grace periods are days in production, so a scan every few minutes is plenty, and a state-based check
cannot "miss" a claim. `status` and the timers sit after variable-length vectors in the account, so the scan downloads
whole accounts (637 bytes each, ~6 MB per scan at 10,000 capsules) and decodes them with the SDK's own decoder. The
server-side filters (`dataSize` 637 and the account discriminator) match every capsule alike.

## Shape

- `sdk/watch.ts`: `scanCapsules(connection)` (one `getProgramAccounts`, decoded locally) and a pure
  `checkCapsule(capsule, now, options, fired)` returning new alerts: heartbeat due soon, heartbeat overdue, claim open
  (with the deadline to cancel), claimable now, claimed, not found. Each alert fires once per liveness epoch or claim
  (keyed by `last_heartbeat` / `claim_triggered_at`), so a scan loop does not repeat itself.
- `scripts/watcher.ts` (`npm run watcher -- <capsule>… [--rpc URL] [--every s] [--remind s] [--notify URL] [--once]`):
  prints alerts and optionally POSTs them as plain text to a push URL (an ntfy topic or any webhook). The message never
  contains a capsule address.
- No hosted service. Self-hosting keeps the capsule list on the owner's machine.

## Honest limits

- The push service sees *when* an alert fires; on a quiet chain that time can be matched with a public
  `ClaimTriggered`. Self-host the push server if that matters.
- The RPC sees an IP scanning all SIKRIT capsules every few minutes, which says "SIKRIT user" but not which capsule.
- Scale: a full scan grows with the number of capsules. Past that, a public feed of state changes filtered on the
  device keeps the same property with less data.

## Tests

LiteSVM lifecycle with the real binary: alerts across active → due → overdue → claim open → heartbeat cancels →
claim open again → claimable → claimed, each firing once; the scan decodes real account bytes through a stand-in
connection and ignores other program accounts; no alert text contains the capsule address. Then `--once` against devnet.
