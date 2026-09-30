/**
 * SIKRIT — full capsule lifecycle test suite.
 *
 * Executes the compiled SBF program (target/deploy/sikrit.so) inside LiteSVM, an in-process
 * Solana runtime with the real curve25519 syscalls, and warps the on-chain clock so months of
 * heartbeats, timeouts and grace periods run in milliseconds.
 *
 *   npm run build && npm test        (Node 24 LTS, see .nvmrc)
 */
import { AnchorProvider, BN, EventParser, IdlAccounts, IdlTypes, Program, Wallet } from "@anchor-lang/core";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { expect } from "chai";
import { readFileSync } from "fs";
import { FailedTransactionMetadata, LiteSVM, TransactionMetadata } from "litesvm";

import * as kit from "../sdk/kit";
import * as liveness from "../sdk/liveness";
import idl from "../target/idl/sikrit.json";
import type { Sikrit } from "../target/types/sikrit";

type CapsuleAccount = IdlAccounts<Sikrit>["capsule"];
type AnchorCapsuleConfig = IdlTypes<Sikrit>["capsuleConfig"];
type TxResult = TransactionMetadata | FailedTransactionMetadata;
type EventData = Record<string, any>;

const DAY = 86_400;
const START_TIME = 1_790_000_000n; // 2026-09-21T14:13:20Z
const PROGRAM_ID = new PublicKey(idl.address);
const PROGRAM_SO = readFileSync(`${__dirname}/../target/deploy/sikrit.so`);
const ERROR_CODES = new Map(idl.errors.map((e) => [e.name, e.code]));

/** Highest compute units observed per instruction, printed after the suite. */
const computeUnits = new Map<string, bigint>();

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------

interface Capsule {
  secret: bigint;
  commitment: Uint8Array;
  address: PublicKey;
  heir: Keypair;
  guardians: Keypair[];
  config: liveness.CapsuleConfigInput;
  registrationProof: liveness.SchnorrProof;
}

interface CapsuleOptions {
  secret?: bigint;
  /** Pre-made heir / guardian wallets (e.g. whose inbox keys a kit was already sealed to). */
  heir?: Keypair;
  guardianWallets?: Keypair[];
  guardians?: number;
  threshold?: number;
  interval?: number;
  grace?: number;
  shareHashes?: Uint8Array[];
  payer?: Keypair;
}

const toAnchorConfig = (config: liveness.CapsuleConfigInput): AnchorCapsuleConfig => ({
  heir: config.heir,
  heartbeatInterval: new BN(config.heartbeatInterval.toString()),
  gracePeriod: new BN(config.gracePeriod.toString()),
  guardians: config.guardians,
  guardianThreshold: config.guardianThreshold,
  shareHashes: config.shareHashes.map((hash) => Array.from(hash)),
});

const statusOf = (account: CapsuleAccount) => Object.keys(account.status)[0];

class Harness {
  readonly svm = new LiteSVM();
  readonly program: Program<Sikrit>;

  constructor() {
    this.svm.addProgram(PROGRAM_ID, PROGRAM_SO);
    // The Anchor client only builds instructions and decodes data; LiteSVM executes them.
    const provider = new AnchorProvider(
      new Connection("http://127.0.0.1:8899"),
      new Wallet(Keypair.generate()),
      {},
    );
    this.program = new Program(idl as Sikrit, provider);
    this.setTime(START_TIME);
  }

  wallet(sol = 1): Keypair {
    const keypair = Keypair.generate();
    this.svm.airdrop(keypair.publicKey, BigInt(sol * LAMPORTS_PER_SOL));
    return keypair;
  }

  now(): bigint {
    return this.svm.getClock().unixTimestamp;
  }

  setTime(unixTimestamp: bigint): void {
    const clock = this.svm.getClock();
    clock.unixTimestamp = unixTimestamp;
    this.svm.setClock(clock);
  }

  warp(seconds: number): void {
    this.setTime(this.now() + BigInt(seconds));
  }

  /** Sends one instruction; `signers[0]` pays the fee. */
  send(ix: TransactionInstruction, signers: Keypair[]): TxResult {
    // A fresh blockhash per transaction, so byte-identical replays are executed, not deduplicated.
    this.svm.expireBlockhash();
    const tx = new Transaction().add(ix);
    tx.feePayer = signers[0].publicKey;
    tx.recentBlockhash = this.svm.latestBlockhash();
    tx.sign(...signers);
    const result = this.svm.sendTransaction(tx);
    if (result instanceof TransactionMetadata) {
      const name = result.logs().find((l) => l.startsWith("Program log: Instruction: "))?.slice(26);
      const used = result.computeUnitsConsumed();
      if (name && used > (computeUnits.get(name) ?? 0n)) computeUnits.set(name, used);
    }
    return result;
  }

  capsule(address: PublicKey): CapsuleAccount {
    const account = this.svm.getAccount(address);
    if (!account) throw new Error(`capsule ${address.toBase58()} does not exist`);
    return this.program.coder.accounts.decode("capsule", Buffer.from(account.data));
  }

  events(result: TransactionMetadata): { name: string; data: EventData }[] {
    return [...new EventParser(PROGRAM_ID, this.program.coder).parseLogs(result.logs())];
  }

  sampleConfig(opts: CapsuleOptions = {}): { config: liveness.CapsuleConfigInput; heir: Keypair; guardians: Keypair[] } {
    const heir = opts.heir ?? this.wallet();
    const guardians = opts.guardianWallets ?? Array.from({ length: opts.guardians ?? 3 }, () => this.wallet());
    const config: liveness.CapsuleConfigInput = {
      heir: heir.publicKey,
      heartbeatInterval: BigInt(opts.interval ?? 30 * DAY),
      gracePeriod: BigInt(opts.grace ?? 7 * DAY),
      guardians: guardians.map((g) => g.publicKey),
      guardianThreshold: opts.threshold ?? Math.min(2, guardians.length),
      shareHashes: opts.shareHashes ?? [sha256(utf8ToBytes("share-1")), sha256(utf8ToBytes("share-2"))],
    };
    return { config, heir, guardians };
  }

  // --- instructions ----------------------------------------------------------

  async createCapsuleRaw(
    commitment: Uint8Array,
    config: liveness.CapsuleConfigInput,
    proof: liveness.SchnorrProof,
    payer: Keypair = this.wallet(),
  ): Promise<TxResult> {
    const [capsule] = liveness.capsulePda(PROGRAM_ID, commitment);
    const ix = await this.program.methods
      .createCapsule(Array.from(commitment), toAnchorConfig(config), proof)
      .accountsStrict({ capsule, payer: payer.publicKey, systemProgram: SystemProgram.programId })
      .instruction();
    return this.send(ix, [payer]);
  }

  async newCapsule(opts: CapsuleOptions = {}): Promise<{ capsule: Capsule; result: TxResult }> {
    const secret = opts.secret ?? liveness.generateLivenessSecret();
    const commitment = liveness.commitmentFromSecret(secret);
    const [address] = liveness.capsulePda(PROGRAM_ID, commitment);
    const { config, heir, guardians } = this.sampleConfig(opts);
    const registrationProof = liveness.proveRegistration(secret, PROGRAM_ID, address, config);
    const result = await this.createCapsuleRaw(commitment, config, registrationProof, opts.payer);
    return {
      capsule: { secret, commitment, address, heir, guardians, config, registrationProof },
      result,
    };
  }

  /** Creates a capsule and lets its heartbeat interval run out. */
  async expiredCapsule(opts: CapsuleOptions = {}): Promise<Capsule> {
    const { capsule, result } = await this.newCapsule(opts);
    expectSuccess(result);
    this.warp(Number(capsule.config.heartbeatInterval));
    return capsule;
  }

  /** Creates a capsule whose claim has already been triggered. */
  async pendingCapsule(opts: CapsuleOptions = {}): Promise<Capsule> {
    const capsule = await this.expiredCapsule(opts);
    expectSuccess(await this.triggerClaim(capsule));
    return capsule;
  }

  async heartbeatIx(capsule: Capsule, proof?: liveness.SchnorrProof): Promise<TransactionInstruction> {
    const nonce = this.capsule(capsule.address).heartbeatNonce.toString();
    return this.program.methods
      .heartbeat(proof ?? liveness.proveLiveness(capsule.secret, PROGRAM_ID, capsule.address, BigInt(nonce)))
      .accountsStrict({ capsule: capsule.address })
      .instruction();
  }

  /** Heartbeat relayed by a fresh fee payer that has no link to the owner. */
  async heartbeat(
    capsule: Capsule,
    opts: { proof?: liveness.SchnorrProof; relayer?: Keypair } = {},
  ): Promise<TxResult> {
    return this.send(await this.heartbeatIx(capsule, opts.proof), [opts.relayer ?? this.wallet()]);
  }

  async triggerClaim(capsule: Capsule, keeper: Keypair = this.wallet()): Promise<TxResult> {
    const ix = await this.program.methods
      .triggerClaim()
      .accountsStrict({ capsule: capsule.address })
      .instruction();
    return this.send(ix, [keeper]);
  }

  async guardianConfirm(capsule: Capsule, guardian: Keypair): Promise<TxResult> {
    const ix = await this.program.methods
      .guardianConfirm()
      .accountsStrict({ capsule: capsule.address, guardian: guardian.publicKey })
      .instruction();
    return this.send(ix, [guardian]);
  }

  async guardianVeto(capsule: Capsule, guardian: Keypair): Promise<TxResult> {
    const ix = await this.program.methods
      .guardianVeto()
      .accountsStrict({ capsule: capsule.address, guardian: guardian.publicKey })
      .instruction();
    return this.send(ix, [guardian]);
  }

  async claim(capsule: Capsule, heir: Keypair = capsule.heir): Promise<TxResult> {
    const ix = await this.program.methods
      .claim()
      .accountsStrict({ capsule: capsule.address, heir: heir.publicKey })
      .instruction();
    return this.send(ix, [heir]);
  }
}

// -----------------------------------------------------------------------------
// Assertions
// -----------------------------------------------------------------------------

function logsOf(result: FailedTransactionMetadata): string {
  return result.meta().logs().join("\n");
}

function expectSuccess(result: TxResult): TransactionMetadata {
  if (result instanceof FailedTransactionMetadata) {
    expect.fail(`transaction failed: ${result.err()}\n${logsOf(result)}`);
  }
  return result;
}

/** Asserts the program rejected the transaction with the given `SikritError`. */
function expectError(result: TxResult, name: string): void {
  const code = ERROR_CODES.get(name);
  expect(code, `unknown error name ${name}`).to.not.be.undefined;
  if (!(result instanceof FailedTransactionMetadata)) {
    expect.fail(`expected ${name}, but the transaction succeeded`);
  }
  expect(logsOf(result)).to.include(`Error Code: ${name}. Error Number: ${code}.`);
}

/** Asserts a failure raised outside the program's own error enum (e.g. by the System Program). */
function expectFailure(result: TxResult, logFragment: string): void {
  if (!(result instanceof FailedTransactionMetadata)) {
    expect.fail(`expected a failure containing "${logFragment}", but the transaction succeeded`);
  }
  expect(logsOf(result)).to.include(logFragment);
}

/** 32-byte encoding that does not decompress to a curve point. */
function notACurvePoint(): Uint8Array {
  for (let y = 2; y < 256; y++) {
    const bytes = new Uint8Array(32);
    bytes[0] = y;
    try {
      ed25519.Point.fromBytes(bytes);
    } catch {
      return bytes;
    }
  }
  throw new Error("unreachable");
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("SIKRIT — privacy-preserving dead man's switch", () => {
  let h: Harness;

  before(() => {
    // litesvm's linux-x64 napi binding corrupts the V8 heap on Node 22 (ABI 127) and aborts the
    // process with `std::bad_alloc` mid-suite (https://github.com/LiteSVM/litesvm/issues/171).
    if (process.platform === "linux" && process.versions.modules === "127") {
      throw new Error(
        "Node 22 crashes LiteSVM (litesvm#171: std::bad_alloc). Run the tests on Node 24 LTS: `nvm install 24 && nvm use 24`.",
      );
    }
  });

  beforeEach(() => {
    h = new Harness();
  });

  after(() => {
    const rows = [...computeUnits].map(([ix, cu]) => `      ${ix.padEnd(16)} ${cu.toString().padStart(7)} CU`);
    console.log(`\n    Compute units (max observed, default budget 200000):\n${rows.join("\n")}\n`);
  });

  describe("client prover (sdk/liveness.ts)", () => {
    it("reproduces the cross-language known-answer vector verified by the Rust unit tests", () => {
      const x = liveness.bytesToNumberLE(
        hexToBytes("cc06ce634561e95bfc9b213fde6df570604f9e98e971825808f84ddcac1ffc00"),
      );
      const programId = new PublicKey(new Uint8Array(32).fill(0x11));
      const capsule = new PublicKey(new Uint8Array(32).fill(0x22));
      const proof = liveness.proveLiveness(x, programId, capsule, 7n, new Uint8Array(32));

      expect(bytesToHex(liveness.commitmentFromSecret(x))).to.equal(
        "bf8a3946a4fa347da1c7998a0847d8c7adc04d2a4fc2a6ad184745ee1a3109ef",
      );
      expect(bytesToHex(Uint8Array.from(proof.r))).to.equal(
        "2454b89413395d1bef1a6985528da3f5d695ee8f5beb61759a1fb2596e9b4aef",
      );
      expect(bytesToHex(Uint8Array.from(proof.s))).to.equal(
        "0d46bc22561827abfefa34595e3e3b44ebe5fec47b4d58b2e68e1dfbde0b4a05",
      );
    });

    it("encodes CapsuleConfig byte-for-byte like the Anchor coder (proof-of-possession transcript)", () => {
      const { config } = h.sampleConfig({ guardians: 5, threshold: 3 });
      const anchorBytes = h.program.coder.types.encode("capsuleConfig", toAnchorConfig(config));
      expect(Buffer.from(liveness.encodeCapsuleConfig(config)).equals(anchorBytes)).to.equal(true);
    });

    it("keeps its protocol constants in sync with the on-chain IDL", () => {
      const constant = (name: string) =>
        JSON.parse(idl.constants.find((c) => c.name === name)!.value) as number[];
      expect(constant("CAPSULE_SEED")).to.deep.equal(Array.from(liveness.CAPSULE_SEED));
      expect(constant("REGISTER_DOMAIN")).to.deep.equal(Array.from(liveness.REGISTER_DOMAIN));
      expect(constant("LIVENESS_DOMAIN")).to.deep.equal(Array.from(liveness.LIVENESS_DOMAIN));
    });

    it("derives a stable liveness key from a wallet signature that is unrelated to the wallet key", () => {
      const wallet = Keypair.generate();
      const sign = () => ed25519.sign(liveness.KEYGEN_MESSAGE, wallet.secretKey.slice(0, 32));
      const x = liveness.deriveLivenessSecret(sign());

      expect(liveness.deriveLivenessSecret(sign())).to.equal(x);
      expect(bytesToHex(liveness.commitmentFromSecret(x))).to.not.equal(bytesToHex(wallet.publicKey.toBytes()));
    });
  });

  describe("create_capsule", () => {
    it("creates a capsule addressed only by its liveness commitment (no wallet identity on-chain)", async () => {
      const ownerWallet = h.wallet();
      const { capsule, result } = await h.newCapsule({ guardians: 3, threshold: 2, payer: ownerWallet });
      const tx = expectSuccess(result);
      const account = h.capsule(capsule.address);

      expect(capsule.address.equals(liveness.capsulePda(PROGRAM_ID, capsule.commitment)[0])).to.equal(true);
      expect(bytesToHex(Uint8Array.from(account.commitment))).to.equal(bytesToHex(capsule.commitment));
      expect(account.heir.equals(capsule.heir.publicKey)).to.equal(true);
      expect(account.guardians.map((g) => g.toBase58())).to.deep.equal(
        capsule.guardians.map((g) => g.publicKey.toBase58()),
      );
      expect(account.guardianThreshold).to.equal(2);
      expect(account.heartbeatInterval.toNumber()).to.equal(30 * DAY);
      expect(account.gracePeriod.toNumber()).to.equal(7 * DAY);
      expect(account.lastHeartbeat.toString()).to.equal(h.now().toString());
      expect(account.heartbeatNonce.toNumber()).to.equal(0);
      expect(account.approvals).to.equal(0);
      expect(account.vetoes).to.equal(0);
      expect(account.shareHashes.map((s) => bytesToHex(Uint8Array.from(s)))).to.deep.equal(
        capsule.config.shareHashes.map(bytesToHex),
      );
      expect(statusOf(account)).to.equal("active");

      // The wallet that paid rent is recorded neither in capsule state nor in the event.
      const raw = Buffer.from(h.svm.getAccount(capsule.address)!.data);
      expect(raw.includes(ownerWallet.publicKey.toBuffer())).to.equal(false);
      const [event] = h.events(tx);
      expect(event.name).to.equal("capsuleCreated");
      expect(JSON.stringify(event.data)).to.not.include(ownerWallet.publicKey.toBase58());
    });

    it("rejects a proof-of-possession made without the secret (cannot register someone else's key)", async () => {
      const victimCommitment = liveness.commitmentFromSecret(liveness.generateLivenessSecret());
      const [address] = liveness.capsulePda(PROGRAM_ID, victimCommitment);
      const { config } = h.sampleConfig();
      const forged = liveness.proveRegistration(liveness.generateLivenessSecret(), PROGRAM_ID, address, config);

      expectError(await h.createCapsuleRaw(victimCommitment, config, forged), "ProofVerificationFailed");
    });

    it("rejects a front-runner replaying the owner's proof-of-possession with a different heir", async () => {
      const secret = liveness.generateLivenessSecret();
      const commitment = liveness.commitmentFromSecret(secret);
      const [address] = liveness.capsulePda(PROGRAM_ID, commitment);
      const { config } = h.sampleConfig();
      const proof = liveness.proveRegistration(secret, PROGRAM_ID, address, config);

      const hijacked = { ...config, heir: Keypair.generate().publicKey };
      expectError(await h.createCapsuleRaw(commitment, hijacked, proof), "ProofVerificationFailed");
      expectSuccess(await h.createCapsuleRaw(commitment, config, proof));
    });

    it("rejects identity, small-order, mixed-torsion and non-canonical commitments", async () => {
      const identity = ed25519.Point.ZERO.toBytes();
      const orderFour = new Uint8Array(32); // y = 0 decodes to a point of order 4
      const mixedTorsion = ed25519.Point.BASE.multiply(liveness.generateLivenessSecret())
        .add(ed25519.Point.fromBytes(orderFour))
        .toBytes();
      const nonCanonical = new Uint8Array(32).fill(0xff); // y = 2^255 - 19
      nonCanonical[0] = 0xed;
      nonCanonical[31] = 0x7f;
      const dummyProof = { r: Array.from(ed25519.Point.BASE.toBytes()), s: new Array(32).fill(0) };

      for (const commitment of [identity, orderFour, mixedTorsion, nonCanonical]) {
        const { config } = h.sampleConfig();
        expectError(await h.createCapsuleRaw(commitment, config, dummyProof), "InvalidCommitment");
      }
    });

    it("rejects invalid configurations", async () => {
      const heir = Keypair.generate().publicKey;
      const g = () => Keypair.generate().publicKey;
      const guardian = g();
      const cases: [string, Partial<liveness.CapsuleConfigInput>][] = [
        ["HeartbeatIntervalTooShort", { heartbeatInterval: 59n }],
        ["GracePeriodTooShort", { gracePeriod: 59n }],
        ["InvalidHeir", { heir: PublicKey.default }],
        ["TooManyGuardians", { guardians: [g(), g(), g(), g(), g(), g()], guardianThreshold: 1 }],
        ["InvalidGuardianThreshold", { guardians: [g()], guardianThreshold: 2 }],
        ["InvalidGuardian", { guardians: [PublicKey.default], guardianThreshold: 1 }],
        ["DuplicateGuardian", { guardians: [guardian, guardian], guardianThreshold: 1 }],
        ["HeirCannotBeGuardian", { heir, guardians: [heir], guardianThreshold: 1 }],
        ["TooManyShares", { shareHashes: Array.from({ length: 11 }, () => new Uint8Array(32)) }],
      ];

      for (const [error, override] of cases) {
        const config = { ...h.sampleConfig().config, ...override };
        const secret = liveness.generateLivenessSecret();
        const commitment = liveness.commitmentFromSecret(secret);
        const [address] = liveness.capsulePda(PROGRAM_ID, commitment);
        const proof = liveness.proveRegistration(secret, PROGRAM_ID, address, config);
        expectError(await h.createCapsuleRaw(commitment, config, proof), error);
      }
    });

    it("cannot create the same capsule twice", async () => {
      const { capsule, result } = await h.newCapsule();
      expectSuccess(result);
      expectFailure(
        await h.createCapsuleRaw(capsule.commitment, capsule.config, capsule.registrationProof),
        "already in use",
      );
    });
  });

  describe("heartbeat — ZK proof-of-liveness", () => {
    it("accepts a proof relayed by an unrelated fee payer and resets the dead man's timer", async () => {
      const { capsule, result } = await h.newCapsule();
      expectSuccess(result);
      h.warp(10 * DAY);

      const ix = await h.heartbeatIx(capsule);
      // The instruction carries only the capsule: no owner, heir or guardian identity.
      expect(ix.keys.map((k) => k.pubkey.toBase58())).to.deep.equal([capsule.address.toBase58()]);
      expect(ix.keys[0].isSigner).to.equal(false);

      const relayer = h.wallet();
      const tx = expectSuccess(h.send(ix, [relayer]));
      const account = h.capsule(capsule.address);
      expect(account.lastHeartbeat.toString()).to.equal(h.now().toString());
      expect(account.heartbeatNonce.toNumber()).to.equal(1);

      const [event] = h.events(tx);
      expect(event.name).to.equal("heartbeatVerified");
      expect(event.data.nonce.toNumber()).to.equal(0);
      expect(event.data.claimCancelled).to.equal(false);
      expect(Number(tx.computeUnitsConsumed())).to.be.below(200_000);
    });

    it("rejects a replayed proof, so nobody can keep a dead owner 'alive'", async () => {
      const { capsule, result } = await h.newCapsule();
      expectSuccess(result);
      const proof = liveness.proveLiveness(capsule.secret, PROGRAM_ID, capsule.address, 0n);
      expectSuccess(await h.heartbeat(capsule, { proof }));

      // The proof is public in the transaction; an attacker replays it once the owner goes silent.
      h.warp(30 * DAY);
      expectError(await h.heartbeat(capsule, { proof }), "ProofVerificationFailed");
      expect(h.capsule(capsule.address).heartbeatNonce.toNumber()).to.equal(1);
      expectSuccess(await h.triggerClaim(capsule));
    });

    it("rejects proofs bound to a stale or future nonce", async () => {
      const { capsule, result } = await h.newCapsule();
      expectSuccess(result);
      expectSuccess(await h.heartbeat(capsule));

      for (const nonce of [0n, 2n]) {
        const proof = liveness.proveLiveness(capsule.secret, PROGRAM_ID, capsule.address, nonce);
        expectError(await h.heartbeat(capsule, { proof }), "ProofVerificationFailed");
      }
      const current = liveness.proveLiveness(capsule.secret, PROGRAM_ID, capsule.address, 1n);
      expectSuccess(await h.heartbeat(capsule, { proof: current }));
    });

    it("rejects a proof made with the wrong secret", async () => {
      const { capsule, result } = await h.newCapsule();
      expectSuccess(result);
      const forged = liveness.proveLiveness(liveness.generateLivenessSecret(), PROGRAM_ID, capsule.address, 0n);
      expectError(await h.heartbeat(capsule, { proof: forged }), "ProofVerificationFailed");
    });

    it("rejects the registration proof-of-possession replayed as a heartbeat (domain separation)", async () => {
      const { capsule, result } = await h.newCapsule();
      expectSuccess(result);
      expectError(await h.heartbeat(capsule, { proof: capsule.registrationProof }), "ProofVerificationFailed");
    });

    it("rejects malformed proofs: R off the curve and non-canonical s", async () => {
      const { capsule, result } = await h.newCapsule();
      expectSuccess(result);
      const valid = liveness.proveLiveness(capsule.secret, PROGRAM_ID, capsule.address, 0n);

      const badR = { ...valid, r: Array.from(notACurvePoint()) };
      expectError(await h.heartbeat(capsule, { proof: badR }), "InvalidProofR");

      const badS = { ...valid, s: new Array(32).fill(0xff) };
      expectError(await h.heartbeat(capsule, { proof: badS }), "InvalidProofS");
    });
  });

  describe("trigger_claim", () => {
    it("cannot be triggered while the last heartbeat is still fresh", async () => {
      const { capsule, result } = await h.newCapsule({ interval: 7 * DAY });
      expectSuccess(result);
      h.warp(7 * DAY - 1);
      expectError(await h.triggerClaim(capsule), "HeartbeatNotExpired");
    });

    it("can be triggered by any keeper exactly when the interval elapses", async () => {
      const capsule = await h.expiredCapsule({ interval: 7 * DAY });
      const keeper = h.wallet();
      const tx = expectSuccess(await h.triggerClaim(capsule, keeper));

      const account = h.capsule(capsule.address);
      expect(statusOf(account)).to.equal("claimPending");
      expect(account.claimTriggeredAt.toString()).to.equal(h.now().toString());
      const [event] = h.events(tx);
      expect(event.name).to.equal("claimTriggered");
    });

    it("restarts the countdown on every heartbeat", async () => {
      const { capsule, result } = await h.newCapsule({ interval: 7 * DAY });
      expectSuccess(result);
      h.warp(7 * DAY - 60);
      expectSuccess(await h.heartbeat(capsule));
      h.warp(120);
      expectError(await h.triggerClaim(capsule), "HeartbeatNotExpired");
    });

    it("cannot be triggered twice", async () => {
      const capsule = await h.pendingCapsule();
      expectError(await h.triggerClaim(capsule), "CapsuleNotActive");
    });
  });

  describe("guardian_confirm", () => {
    it("rejects confirmations while no claim is pending", async () => {
      const { capsule, result } = await h.newCapsule();
      expectSuccess(result);
      expectError(await h.guardianConfirm(capsule, capsule.guardians[0]), "ClaimNotPending");
    });

    it("rejects signers that are not registered guardians, including the heir", async () => {
      const capsule = await h.pendingCapsule();
      expectError(await h.guardianConfirm(capsule, capsule.heir), "UnauthorizedGuardian");
      expectError(await h.guardianConfirm(capsule, h.wallet()), "UnauthorizedGuardian");
    });

    it("counts each guardian once, so one guardian cannot satisfy a 2-of-3 threshold alone", async () => {
      const capsule = await h.pendingCapsule({ guardians: 3, threshold: 2 });
      const [guardian] = capsule.guardians;

      const tx = expectSuccess(await h.guardianConfirm(capsule, guardian));
      expect(h.events(tx)[0].data.totalApprovals).to.equal(1);
      expectError(await h.guardianConfirm(capsule, guardian), "GuardianAlreadyApproved");
      expect(h.capsule(capsule.address).approvals).to.equal(0b001);

      h.warp(7 * DAY);
      expectError(await h.claim(capsule), "InsufficientGuardianApprovals");
    });
  });

  describe("guardian_veto", () => {
    it("rejects vetoes from non-guardians", async () => {
      const capsule = await h.pendingCapsule();
      expectError(await h.guardianVeto(capsule, capsule.heir), "UnauthorizedGuardian");
      expectError(await h.guardianVeto(capsule, h.wallet()), "UnauthorizedGuardian");
    });

    it("cancels a false trigger and gives the owner a full new interval", async () => {
      const capsule = await h.pendingCapsule({ guardians: 2, threshold: 1, interval: 7 * DAY, grace: 3 * DAY });
      const [first, second] = capsule.guardians;
      expectSuccess(await h.guardianConfirm(capsule, first));
      h.warp(DAY);

      const tx = expectSuccess(await h.guardianVeto(capsule, second));
      const account = h.capsule(capsule.address);
      expect(statusOf(account)).to.equal("active");
      expect(account.lastHeartbeat.toString()).to.equal(h.now().toString());
      expect(account.claimTriggeredAt.toNumber()).to.equal(0);
      expect(account.approvals).to.equal(0);
      expect(account.vetoes).to.equal(0b10);
      const [event] = h.events(tx);
      expect(event.name).to.equal("claimVetoed");
      expect(event.data.guardian.equals(second.publicKey)).to.equal(true);

      expectError(await h.triggerClaim(capsule), "HeartbeatNotExpired");
      h.warp(7 * DAY);
      expectSuccess(await h.triggerClaim(capsule));
    });

    it("gives each guardian one veto until the owner proves liveness again (bounded griefing)", async () => {
      // Two colluding guardians try to block the inheritance forever.
      const capsule = await h.pendingCapsule({ guardians: 2, threshold: 0, interval: 7 * DAY, grace: 3 * DAY });
      const [first, second] = capsule.guardians;

      expectSuccess(await h.guardianVeto(capsule, first));
      h.warp(7 * DAY);
      expectSuccess(await h.triggerClaim(capsule));
      expectError(await h.guardianVeto(capsule, first), "GuardianAlreadyVetoed");
      expectSuccess(await h.guardianVeto(capsule, second));

      h.warp(7 * DAY);
      expectSuccess(await h.triggerClaim(capsule));
      expectError(await h.guardianVeto(capsule, first), "GuardianAlreadyVetoed");
      expectError(await h.guardianVeto(capsule, second), "GuardianAlreadyVetoed");
      h.warp(3 * DAY);
      expectSuccess(await h.claim(capsule));
    });

    it("restores veto rights once the owner proves liveness", async () => {
      const capsule = await h.pendingCapsule({ guardians: 1, threshold: 0, interval: 7 * DAY, grace: 3 * DAY });
      const [guardian] = capsule.guardians;
      expectSuccess(await h.guardianVeto(capsule, guardian));
      expectSuccess(await h.heartbeat(capsule));
      expect(h.capsule(capsule.address).vetoes).to.equal(0);

      h.warp(7 * DAY);
      expectSuccess(await h.triggerClaim(capsule));
      expectSuccess(await h.guardianVeto(capsule, guardian));
    });

    it("closes the veto window when the grace period ends", async () => {
      const capsule = await h.pendingCapsule({ guardians: 2, threshold: 1, grace: 3 * DAY });
      const [first, second] = capsule.guardians;
      expectSuccess(await h.guardianConfirm(capsule, first));
      h.warp(3 * DAY);

      expectError(await h.guardianVeto(capsule, second), "VetoWindowClosed");
      expectSuccess(await h.claim(capsule));
    });
  });

  describe("owner revival", () => {
    it("a heartbeat cancels a pending claim — even after the grace period, until the heir claims", async () => {
      const capsule = await h.pendingCapsule({ guardians: 3, threshold: 2 });
      expectSuccess(await h.guardianConfirm(capsule, capsule.guardians[0]));
      expectSuccess(await h.guardianConfirm(capsule, capsule.guardians[1]));
      h.warp(8 * DAY);

      const tx = expectSuccess(await h.heartbeat(capsule));
      expect(h.events(tx)[0].data.claimCancelled).to.equal(true);
      const account = h.capsule(capsule.address);
      expect(statusOf(account)).to.equal("active");
      expect(account.approvals).to.equal(0);
      expect(account.claimTriggeredAt.toNumber()).to.equal(0);
      expect(account.heartbeatNonce.toNumber()).to.equal(1);

      expectError(await h.claim(capsule), "ClaimNotPending");
    });
  });

  describe("claim", () => {
    it("rejects anyone but the registered heir", async () => {
      const capsule = await h.pendingCapsule({ guardians: 1, threshold: 0 });
      h.warp(7 * DAY);
      expectError(await h.claim(capsule, capsule.guardians[0]), "UnauthorizedHeir");
      expectError(await h.claim(capsule, h.wallet()), "UnauthorizedHeir");
    });

    it("rejects claims before the grace period ends", async () => {
      const capsule = await h.pendingCapsule({ guardians: 0, threshold: 0, grace: 7 * DAY });
      h.warp(7 * DAY - 1);
      expectError(await h.claim(capsule), "GracePeriodNotExpired");
    });

    it("releases the capsule to the heir once the grace period and guardian threshold are met", async () => {
      const capsule = await h.pendingCapsule({ guardians: 3, threshold: 2 });
      expectSuccess(await h.guardianConfirm(capsule, capsule.guardians[0]));
      expectSuccess(await h.guardianConfirm(capsule, capsule.guardians[2]));
      h.warp(7 * DAY);

      const tx = expectSuccess(await h.claim(capsule));
      expect(statusOf(h.capsule(capsule.address))).to.equal("claimed");
      const [event] = h.events(tx);
      expect(event.name).to.equal("capsuleClaimed");
      expect(event.data.heir.equals(capsule.heir.publicKey)).to.equal(true);
    });

    it("supports guardian-less capsules as a pure time-lock", async () => {
      const capsule = await h.pendingCapsule({ guardians: 0, threshold: 0 });
      h.warp(7 * DAY);
      expectSuccess(await h.claim(capsule));
    });

    it("is terminal: no second claim, heartbeat, trigger or guardian action afterwards", async () => {
      const capsule = await h.pendingCapsule({ guardians: 2, threshold: 1 });
      const [guardian] = capsule.guardians;
      expectSuccess(await h.guardianConfirm(capsule, guardian));
      h.warp(7 * DAY);
      expectSuccess(await h.claim(capsule));

      expectError(await h.claim(capsule), "ClaimNotPending");
      expectError(await h.heartbeat(capsule), "CapsuleAlreadyClaimed");
      expectError(await h.triggerClaim(capsule), "CapsuleNotActive");
      expectError(await h.guardianConfirm(capsule, guardian), "ClaimNotPending");
      expectError(await h.guardianVeto(capsule, guardian), "ClaimNotPending");
    });
  });

  describe("end-to-end: the 'Bapak A' inheritance story", () => {
    it("seed phrase → sealed kit → 6 months of heartbeats → silence → guardians 2-of-3 → release → heir recovers the seed", async () => {
      // Bapak A derives his liveness key from a wallet signature: nothing extra to back up.
      const sign = (wallet: Keypair) => async (message: Uint8Array) => ed25519.sign(message, wallet.secretKey.slice(0, 32));
      const secret = liveness.deriveLivenessSecret(await sign(Keypair.generate())(liveness.KEYGEN_MESSAGE));
      const commitment = liveness.commitmentFromSecret(secret);

      // His heir and three guardians each derive an inbox key from their own wallet and send him a
      // wallet-signed invite; he checks every invite before sealing anything to it.
      const heir = h.wallet();
      const guardians = [h.wallet(), h.wallet(), h.wallet()];
      const inboxes = await Promise.all(
        [heir, ...guardians].map((wallet) => kit.createInbox(wallet.publicKey.toBytes(), sign(wallet))),
      );
      const [heirInbox, ...guardianInboxes] = inboxes;
      const invites = inboxes.map(({ certificate }) => kit.encodeInboxCertificate(certificate));
      const [heirCertificate, ...guardianCertificates] = invites.map(kit.decodeInboxCertificate);

      // The seed phrase is encrypted under a random key; the key is split so that the heir's share
      // plus any 2 of the 3 guardians' shares rebuild it (k = 3), and every share is sealed to its
      // holder. Only the share hashes go on-chain; the kit itself travels off-chain.
      const seedPhrase = "abandon ability able about above absent absorb abstract absurd abuse access accident";
      const sealed = await kit.sealCapsuleKit({
        secret: utf8ToBytes(seedPhrase),
        commitment,
        heir: heirCertificate,
        guardians: guardianCertificates,
        threshold: 3,
      });
      const portableKit = kit.encodeKit(sealed);
      const { capsule, result } = await h.newCapsule({
        secret,
        heir,
        guardianWallets: guardians,
        threshold: 2,
        interval: 30 * DAY,
        grace: 7 * DAY,
        shareHashes: sealed.shareHashes,
      });
      expectSuccess(result);

      /** What any participant reads from the chain before acting on the kit. */
      const chainState = (): kit.CapsuleState => {
        const account = h.capsule(capsule.address);
        return {
          commitment: Uint8Array.from(account.commitment),
          heir: account.heir.toBytes(),
          guardians: account.guardians.map((guardian) => guardian.toBytes()),
          shareHashes: account.shareHashes.map((hash) => Uint8Array.from(hash)),
          claimed: statusOf(account) === "claimed",
        };
      };

      // Alive: a heartbeat every month, each relayed by a different throwaway fee payer.
      for (let month = 0; month < 6; month++) {
        h.warp(29 * DAY);
        expectError(await h.triggerClaim(capsule), "HeartbeatNotExpired");
        expectSuccess(await h.heartbeat(capsule));
      }
      expect(h.capsule(capsule.address).heartbeatNonce.toNumber()).to.equal(6);

      // The heir checks the kit against the chain, but their own share alone reveals nothing,
      // and no guardian client will release while the capsule is not claimed.
      const heirKit = kit.decodeKit(portableKit);
      kit.verifyKit(heirKit, chainState());
      const heirShare = kit.openShare(heirKit, 0, heirInbox.keyPair.secretKey);
      let early: Error | undefined;
      await kit.recoverSecret(heirKit, [heirShare]).catch((error: Error) => (early = error));
      expect(early?.message).to.match(/need 3 distinct shares/);
      const eagerShare = kit.openShare(heirKit, 1, guardianInboxes[0].keyPair.secretKey);
      expect(() => kit.releaseShare(heirKit, eagerShare, chainState())).to.throw(/not been claimed/);

      // Silence: the timer runs out and a keeper bot opens the claim.
      h.warp(30 * DAY);
      expectSuccess(await h.triggerClaim(capsule));

      // Two of the three guardians vouch; nobody vetoes during the grace period.
      expectSuccess(await h.guardianConfirm(capsule, guardians[0]));
      expectSuccess(await h.guardianConfirm(capsule, guardians[2]));
      expect(() => kit.releaseShare(heirKit, eagerShare, chainState())).to.throw(/not been claimed/);
      h.warp(7 * DAY);
      expectSuccess(await h.claim(capsule));
      expect(statusOf(h.capsule(capsule.address))).to.equal("claimed");

      // Seeing `Claimed` on-chain, guardians #1 and #3 open their shares and re-seal them to the
      // inbox key certified by the on-chain heir.
      const releases = [0, 2].map((g) => {
        const guardianKit = kit.decodeKit(portableKit);
        const inbox = guardianInboxes[g].keyPair;
        const share = kit.openShare(guardianKit, kit.findShareIndex(guardianKit, inbox.publicKey), inbox.secretKey);
        return kit.releaseShare(guardianKit, share, chainState());
      });

      // The heir authenticates both releases against the committed hashes and recovers the seed.
      const released = releases.map((release) => kit.openRelease(heirKit, release, heirInbox.keyPair.secretKey));
      const recovered = await kit.recoverSecret(heirKit, [heirShare, ...released]);
      expect(new TextDecoder().decode(recovered)).to.equal(seedPhrase);
    });
  });
});
