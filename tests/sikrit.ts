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
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils";
import {
  Connection,
  GetProgramAccountsConfig,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { expect } from "chai";
import { readFileSync } from "fs";
import { Readable } from "stream";
import { FailedTransactionMetadata, LiteSVM, TransactionMetadata } from "litesvm";

import * as relayService from "../app/api/relay";
import * as client from "../sdk/client";
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
  /** Salts of the member commitments (in a real capsule they travel in the kit). */
  heirSalt: Uint8Array;
  guardianSalts: Uint8Array[];
  config: liveness.CapsuleConfigInput;
  registrationProof: liveness.SchnorrProof;
}

interface CapsuleOptions {
  secret?: bigint;
  /** Pre-made heir / guardian wallets (e.g. whose inbox keys a kit was already sealed to). */
  heir?: Keypair;
  guardianWallets?: Keypair[];
  /** Pre-made salts (e.g. the kit's), so the on-chain commitments match the kit's roster. */
  heirSalt?: Uint8Array;
  guardianSalts?: Uint8Array[];
  guardians?: number;
  threshold?: number;
  interval?: number;
  grace?: number;
  shareHashes?: Uint8Array[];
  payer?: Keypair;
}

/** A heartbeat as the app sends it: the proof and the expiry it is bound to. */
interface Beat {
  proof: liveness.SchnorrProof;
  expiresAt: bigint;
}

const toAnchorConfig = (config: liveness.CapsuleConfigInput): AnchorCapsuleConfig => ({
  heirCommitment: Array.from(config.heirCommitment),
  heartbeatInterval: new BN(config.heartbeatInterval.toString()),
  gracePeriod: new BN(config.gracePeriod.toString()),
  guardianCommitments: config.guardianCommitments.map((c) => Array.from(c)),
  guardianThreshold: config.guardianThreshold,
  shareHashes: config.shareHashes.map((hash) => Array.from(hash)),
});

const { heir: HEIR, guardian: GUARDIAN } = liveness.MemberRole;

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

  /** A config for capsule `commitment` (P), its heir and guardians hidden behind fresh salted commitments. */
  sampleConfig(opts: CapsuleOptions = {}, commitment: Uint8Array = randomBytes(32)) {
    const heir = opts.heir ?? this.wallet();
    const guardians = opts.guardianWallets ?? Array.from({ length: opts.guardians ?? 3 }, () => this.wallet());
    const heirSalt = opts.heirSalt ?? randomBytes(32);
    const guardianSalts = opts.guardianSalts ?? guardians.map(() => randomBytes(32));
    const config: liveness.CapsuleConfigInput = {
      heirCommitment: liveness.memberCommitment(commitment, HEIR, heir.publicKey, heirSalt),
      heartbeatInterval: BigInt(opts.interval ?? 30 * DAY),
      gracePeriod: BigInt(opts.grace ?? 7 * DAY),
      guardianCommitments: guardians.map((g, i) => liveness.memberCommitment(commitment, GUARDIAN, g.publicKey, guardianSalts[i])),
      guardianThreshold: opts.threshold ?? Math.min(2, guardians.length),
      shareHashes: opts.shareHashes ?? [sha256(utf8ToBytes("share-1")), sha256(utf8ToBytes("share-2"))],
    };
    return { config, heir, guardians, heirSalt, guardianSalts };
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
    const { config, heir, guardians, heirSalt, guardianSalts } = this.sampleConfig(opts, commitment);
    const registrationProof = liveness.proveRegistration(secret, PROGRAM_ID, address, config);
    const result = await this.createCapsuleRaw(commitment, config, registrationProof, opts.payer);
    return {
      capsule: { secret, commitment, address, heir, guardians, heirSalt, guardianSalts, config, registrationProof },
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

  /** A heartbeat for the capsule's current nonce, valid for the app's default lifetime from the cluster clock. */
  beat(capsule: Capsule, opts: { nonce?: bigint; expiresAt?: bigint; secret?: bigint } = {}): Beat {
    const nonce = opts.nonce ?? BigInt(this.capsule(capsule.address).heartbeatNonce.toString());
    const expiresAt = opts.expiresAt ?? this.now() + liveness.DEFAULT_PROOF_LIFETIME;
    const proof = liveness.proveLiveness(opts.secret ?? capsule.secret, PROGRAM_ID, capsule.address, nonce, expiresAt);
    return { proof, expiresAt };
  }

  async heartbeatIx(capsule: Capsule, beat: Beat = this.beat(capsule)): Promise<TransactionInstruction> {
    return this.program.methods
      .heartbeat(beat.proof, new BN(beat.expiresAt.toString()))
      .accountsStrict({ capsule: capsule.address })
      .instruction();
  }

  /** Heartbeat relayed by a fresh fee payer that has no link to the owner. */
  async heartbeat(capsule: Capsule, opts: { beat?: Beat; relayer?: Keypair } = {}): Promise<TxResult> {
    return this.send(await this.heartbeatIx(capsule, opts.beat), [opts.relayer ?? this.wallet()]);
  }

  /** The guardian's own opening (slot + salt from the kit); a wallet that is no guardian borrows slot 0's. */
  opening(capsule: Capsule, guardian: Keypair): { slot: number; salt: Uint8Array } {
    const slot = capsule.guardians.findIndex((g) => g.publicKey.equals(guardian.publicKey));
    return slot >= 0 ? { slot, salt: capsule.guardianSalts[slot] } : { slot: 0, salt: capsule.guardianSalts[0] ?? randomBytes(32) };
  }

  async triggerClaim(capsule: Capsule, keeper: Keypair = this.wallet()): Promise<TxResult> {
    const ix = await this.program.methods
      .triggerClaim()
      .accountsStrict({ capsule: capsule.address })
      .instruction();
    return this.send(ix, [keeper]);
  }

  async guardianConfirm(capsule: Capsule, guardian: Keypair, opening = this.opening(capsule, guardian)): Promise<TxResult> {
    const ix = await this.program.methods
      .guardianConfirm(opening.slot, Array.from(opening.salt))
      .accountsStrict({ capsule: capsule.address, guardian: guardian.publicKey })
      .instruction();
    return this.send(ix, [guardian]);
  }

  async guardianVeto(capsule: Capsule, guardian: Keypair, opening = this.opening(capsule, guardian)): Promise<TxResult> {
    const ix = await this.program.methods
      .guardianVeto(opening.slot, Array.from(opening.salt))
      .accountsStrict({ capsule: capsule.address, guardian: guardian.publicKey })
      .instruction();
    return this.send(ix, [guardian]);
  }

  async claim(capsule: Capsule, heir: Keypair = capsule.heir, salt: Uint8Array = capsule.heirSalt): Promise<TxResult> {
    const ix = await this.program.methods
      .claim(Array.from(salt))
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

async function expectRejection(promise: Promise<unknown>, message: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect((error as Error).message).to.match(message);
    return;
  }
  expect.fail(`expected rejection matching ${message}`);
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
      const proof = liveness.proveLiveness(x, programId, capsule, 7n, 1_790_000_600n, new Uint8Array(32));

      expect(bytesToHex(liveness.commitmentFromSecret(x))).to.equal(
        "bf8a3946a4fa347da1c7998a0847d8c7adc04d2a4fc2a6ad184745ee1a3109ef",
      );
      expect(bytesToHex(Uint8Array.from(proof.r))).to.equal(
        "0debb193d37e14f122354eefb14a6542da19c37d5297ac9085651ea87ecae994",
      );
      expect(bytesToHex(Uint8Array.from(proof.s))).to.equal(
        "c47c8c123ecda4316a7433533f57a48da2e9d1390b3e3fda7669d3c5d0f0af00",
      );
    });

    it("computes member commitments like the program (vector shared with the Rust tests, checked in Python)", () => {
      const [p, wallet, salt] = [0x33, 0x44, 0x55].map((byte) => new Uint8Array(32).fill(byte));
      expect(bytesToHex(liveness.memberCommitment(p, GUARDIAN, wallet, salt))).to.equal(
        "e34bf422e0d0e276e1519a96931ee0574e6a0b8b9629048ebc5e3690453820d8",
      );
      expect(bytesToHex(liveness.memberCommitment(p, HEIR, new PublicKey(wallet), salt))).to.equal(
        "cadedb6934386496c3d769d40f491534b2e682333e674ac18b9a66625e18a709",
      );
      expect(() => liveness.memberCommitment(p, HEIR, wallet, salt.subarray(1))).to.throw(/32 bytes/);
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
      expect(constant("MEMBER_DOMAIN")).to.deep.equal(Array.from(liveness.MEMBER_DOMAIN));
      expect(BigInt(idl.constants.find((c) => c.name === "MAX_PROOF_LIFETIME")!.value)).to.equal(liveness.MAX_PROOF_LIFETIME);
      expect(liveness.DEFAULT_PROOF_LIFETIME < liveness.MAX_PROOF_LIFETIME).to.equal(true);
    });

    it("derives a stable liveness key from a wallet signature that is unrelated to the wallet key", () => {
      const wallet = Keypair.generate();
      const sign = () => ed25519.sign(liveness.KEYGEN_MESSAGE, wallet.secretKey.slice(0, 32));
      const x = liveness.deriveLivenessSecret(sign());

      expect(liveness.deriveLivenessSecret(sign())).to.equal(x);
      expect(bytesToHex(liveness.commitmentFromSecret(x))).to.not.equal(bytesToHex(wallet.publicKey.toBytes()));
    });
  });

  describe("browser client (sdk/client.ts) — byte-identical to the Anchor client", () => {
    it("derives the IDL's discriminators, error table and exact account size", async () => {
      const byName = new Map(idl.instructions.map((ix) => [ix.name, ix.discriminator]));
      const expected: Record<string, keyof typeof client.DISCRIMINATORS> = {
        create_capsule: "createCapsule",
        heartbeat: "heartbeat",
        trigger_claim: "triggerClaim",
        guardian_confirm: "guardianConfirm",
        guardian_veto: "guardianVeto",
        claim: "claim",
      };
      expect([...byName.keys()].sort()).to.deep.equal(Object.keys(expected).sort());
      for (const [name, key] of Object.entries(expected)) {
        expect(Array.from(client.DISCRIMINATORS[key])).to.deep.equal(byName.get(name));
      }
      expect(Array.from(client.DISCRIMINATORS.capsuleAccount)).to.deep.equal(idl.accounts[0].discriminator);
      expect(client.PROGRAM_ERRORS.map((e, i) => [6000 + i, e.name])).to.deep.equal(idl.errors.map((e) => [e.code, e.name]));
      expect(client.PROGRAM_ID.equals(PROGRAM_ID)).to.equal(true);

      const { capsule } = await h.newCapsule();
      expect(h.svm.getAccount(capsule.address)!.data.length).to.equal(client.CAPSULE_ACCOUNT_SIZE);
    });

    it("builds every instruction exactly like the Anchor client (data and account metas)", async () => {
      const { capsule } = await h.newCapsule();
      const payer = h.wallet();
      const { proof, expiresAt } = h.beat(capsule);
      const guardian = capsule.guardians[1].publicKey;
      const [slot, salt] = [1, capsule.guardianSalts[1]];
      const pairs: [TransactionInstruction, TransactionInstruction][] = [
        [
          client.createCapsuleIx({ payer: payer.publicKey, commitment: capsule.commitment, config: capsule.config, proof: capsule.registrationProof }),
          await h.program.methods
            .createCapsule(Array.from(capsule.commitment), toAnchorConfig(capsule.config), capsule.registrationProof)
            .accountsStrict({ capsule: capsule.address, payer: payer.publicKey, systemProgram: SystemProgram.programId })
            .instruction(),
        ],
        [
          client.heartbeatIx({ capsule: capsule.address, proof, expiresAt }),
          await h.program.methods.heartbeat(proof, new BN(expiresAt.toString())).accountsStrict({ capsule: capsule.address }).instruction(),
        ],
        [
          client.triggerClaimIx({ capsule: capsule.address }),
          await h.program.methods.triggerClaim().accountsStrict({ capsule: capsule.address }).instruction(),
        ],
        [
          client.guardianConfirmIx({ capsule: capsule.address, guardian, slot, salt }),
          await h.program.methods.guardianConfirm(slot, Array.from(salt)).accountsStrict({ capsule: capsule.address, guardian }).instruction(),
        ],
        [
          client.guardianVetoIx({ capsule: capsule.address, guardian, slot, salt }),
          await h.program.methods.guardianVeto(slot, Array.from(salt)).accountsStrict({ capsule: capsule.address, guardian }).instruction(),
        ],
        [
          client.claimIx({ capsule: capsule.address, heir: capsule.heir.publicKey, salt: capsule.heirSalt }),
          await h.program.methods
            .claim(Array.from(capsule.heirSalt))
            .accountsStrict({ capsule: capsule.address, heir: capsule.heir.publicKey })
            .instruction(),
        ],
      ];
      for (const [ours, anchor] of pairs) {
        expect(ours.programId.equals(anchor.programId)).to.equal(true);
        expect(bytesToHex(ours.data)).to.equal(bytesToHex(anchor.data));
        expect(ours.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).to.deep.equal(
          anchor.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
        );
      }
      expect(() => client.guardianConfirmIx({ capsule: capsule.address, guardian, slot: 5, salt })).to.throw(/slot/);
      expect(() => client.claimIx({ capsule: capsule.address, heir: guardian, salt: salt.subarray(1) })).to.throw(/salt/);
    });

    it("runs a whole lifecycle with its own instructions and decodes every state like the Anchor coder", async () => {
      const heir = h.wallet();
      const guardians = [h.wallet(), h.wallet()];
      const secret = liveness.generateLivenessSecret();
      const commitment = liveness.commitmentFromSecret(secret);
      const [address] = liveness.capsulePda(PROGRAM_ID, commitment);
      const [heirSalt, ...salts] = [randomBytes(32), randomBytes(32), randomBytes(32)];
      const config: liveness.CapsuleConfigInput = {
        heirCommitment: liveness.memberCommitment(commitment, HEIR, heir.publicKey, heirSalt),
        heartbeatInterval: 60n,
        gracePeriod: 60n,
        guardianCommitments: guardians.map((g, i) => liveness.memberCommitment(commitment, GUARDIAN, g.publicKey, salts[i])),
        guardianThreshold: 1,
        shareHashes: [sha256(utf8ToBytes("a")), sha256(utf8ToBytes("b")), sha256(utf8ToBytes("c"))],
      };
      const opening = (g: number) => ({ capsule: address, guardian: guardians[g].publicKey, slot: g, salt: salts[g] });
      const decodeBoth = () => {
        const raw = Uint8Array.from(h.svm.getAccount(address)!.data);
        const ours = client.decodeCapsule(raw);
        const anchor = h.capsule(address);
        expect(bytesToHex(ours.commitment)).to.equal(bytesToHex(Uint8Array.from(anchor.commitment)));
        expect(bytesToHex(ours.heirCommitment)).to.equal(bytesToHex(Uint8Array.from(anchor.heirCommitment)));
        expect((ours.heir ?? PublicKey.default).equals(anchor.heir)).to.equal(true);
        expect(ours.guardianCommitments.map(bytesToHex)).to.deep.equal(
          anchor.guardianCommitments.map((c) => bytesToHex(Uint8Array.from(c))));
        expect([ours.guardianThreshold, ours.approvals, ours.vetoes, ours.bump]).to.deep.equal(
          [anchor.guardianThreshold, anchor.approvals, anchor.vetoes, anchor.bump]);
        expect([ours.heartbeatInterval, ours.gracePeriod, ours.lastHeartbeat, ours.claimTriggeredAt, ours.heartbeatNonce].map(String))
          .to.deep.equal([anchor.heartbeatInterval, anchor.gracePeriod, anchor.lastHeartbeat, anchor.claimTriggeredAt, anchor.heartbeatNonce].map(String));
        expect(ours.shareHashes.map(bytesToHex)).to.deep.equal(anchor.shareHashes.map((x) => bytesToHex(Uint8Array.from(x))));
        expect(ours.status).to.equal(statusOf(anchor));
        return ours;
      };

      const proof = liveness.proveRegistration(secret, PROGRAM_ID, address, config);
      const payer = h.wallet();
      expectSuccess(h.send(client.createCapsuleIx({ payer: payer.publicKey, commitment, config, proof }), [payer]));
      expect(decodeBoth()).to.include({ status: "active", heir: null });

      h.warp(30);
      const expiresAt = h.now() + liveness.DEFAULT_PROOF_LIFETIME;
      const beat = liveness.proveLiveness(secret, PROGRAM_ID, address, decodeBoth().heartbeatNonce, expiresAt);
      expectSuccess(h.send(client.heartbeatIx({ capsule: address, proof: beat, expiresAt }), [h.wallet()]));
      expect(client.timeline(decodeBoth(), h.now()).canTrigger).to.equal(false);
      expectError(h.send(client.triggerClaimIx({ capsule: address }), [h.wallet()]), "HeartbeatNotExpired");

      h.warp(60);
      expect(client.timeline(decodeBoth(), h.now()).canTrigger).to.equal(true);
      expectSuccess(h.send(client.triggerClaimIx({ capsule: address }), [h.wallet()]));
      expectSuccess(h.send(client.guardianVetoIx(opening(1)), [guardians[1]]));
      expect(decodeBoth().vetoes).to.equal(0b10);

      h.warp(60);
      expectSuccess(h.send(client.triggerClaimIx({ capsule: address }), [h.wallet()]));
      expectSuccess(h.send(client.guardianConfirmIx(opening(0)), [guardians[0]]));
      let state = decodeBoth();
      expect(state.approvals).to.equal(0b01);
      expect(client.timeline(state, h.now())).to.include({ canVeto: true, canClaim: false, approvalCount: 1 });
      const early = h.send(client.claimIx({ capsule: address, heir: heir.publicKey, salt: heirSalt }), [heir]);
      expectError(early, "GracePeriodNotExpired");
      expect(client.explainError(new Error(logsOf(early as FailedTransactionMetadata)))).to.match(/grace period has not ended/);

      h.warp(60);
      state = decodeBoth();
      expect(client.timeline(state, h.now())).to.include({ canVeto: false, canClaim: true });
      expectSuccess(h.send(client.claimIx({ capsule: address, heir: heir.publicKey, salt: heirSalt }), [heir]));
      state = decodeBoth();
      expect(state.status).to.equal("claimed");
      expect(state.heir?.equals(heir.publicKey)).to.equal(true);
      expect(() => client.decodeCapsule(new Uint8Array(client.CAPSULE_ACCOUNT_SIZE))).to.throw(/not a SIKRIT capsule/);
      const legacy = Uint8Array.from(h.svm.getAccount(address)!.data).subarray(0, client.CAPSULE_ACCOUNT_SIZE - 32);
      expect(() => client.decodeCapsule(legacy)).to.throw(/older protocol version/);
    });

    it("loads the capsules named in kits with one getMultipleAccounts per 100 addresses", async () => {
      const { capsule } = await h.newCapsule();
      const missing = Keypair.generate().publicKey;
      const foreign = h.wallet().publicKey; // exists, but is not a SIKRIT account
      const calls: number[] = [];
      const rpc = {
        async getMultipleAccountsInfo(keys: PublicKey[]) {
          calls.push(keys.length);
          return keys.map((key) => {
            const account = h.svm.getAccount(key);
            return account && { data: Buffer.from(account.data), owner: account.owner };
          });
        },
      } as unknown as Connection;

      const addresses = [capsule.address, ...Array.from({ length: 100 }, () => missing)];
      const found = await client.fetchCapsules(rpc, addresses);
      expect(calls).to.deep.equal([100, 1]);
      expect(found).to.have.length(101);
      expect(found[0].capsule?.status).to.equal("active");
      expect(found.slice(1).every(({ address, capsule }) => address.equals(missing) && capsule === null)).to.equal(true);
      await expectRejection(client.fetchCapsules(rpc, [foreign]), /not owned by the SIKRIT program/);
    });
  });

  describe("relayer service (app/api/relay.ts)", () => {
    // The service's chain is LiteSVM, so "relayed" means the real program binary accepted the transaction.
    const serviceFor = (keypair: Keypair, limits?: relayService.RelayOptions["limits"]) =>
      relayService.createRelay({
        secretKey: keypair.secretKey,
        limits,
        chain: {
          async sendRawTransaction(raw) {
            const tx = Transaction.from(Buffer.from(raw));
            const result = h.svm.sendTransaction(tx);
            if (result instanceof FailedTransactionMetadata) {
              throw Object.assign(new Error("Transaction simulation failed"), { logs: result.meta().logs() });
            }
            return bytesToHex(tx.signature!);
          },
          async getBalance(address) {
            return Number(h.svm.getBalance(new PublicKey(address)) ?? 0n);
          },
        },
      });
    /** What the app posts: the relayer as fee payer, co-signed by `signers`, the relayer's signature still missing. */
    const posted = (ixs: TransactionInstruction[], feePayer: PublicKey, signers: Keypair[] = []) => {
      h.svm.expireBlockhash();
      const tx = new Transaction().add(...ixs);
      tx.feePayer = feePayer;
      tx.recentBlockhash = h.svm.latestBlockhash();
      if (signers.length) tx.partialSign(...signers);
      return tx.serialize({ requireAllSignatures: false }).toString("base64");
    };
    const newCapsuleIx = (payer: PublicKey, guardians: PublicKey[], heir: PublicKey) => {
      const secret = liveness.generateLivenessSecret();
      const commitment = liveness.commitmentFromSecret(secret);
      const [address] = liveness.capsulePda(PROGRAM_ID, commitment);
      const heirSalt = randomBytes(32);
      const salts = guardians.map(() => randomBytes(32));
      const config: liveness.CapsuleConfigInput = {
        heirCommitment: liveness.memberCommitment(commitment, HEIR, heir, heirSalt),
        heartbeatInterval: 60n,
        gracePeriod: 60n,
        guardianCommitments: guardians.map((g, i) => liveness.memberCommitment(commitment, GUARDIAN, g, salts[i])),
        guardianThreshold: 1,
        shareHashes: [],
      };
      const proof = liveness.proveRegistration(secret, PROGRAM_ID, address, config);
      const confirm = (slot: number) => client.guardianConfirmIx({ capsule: address, guardian: guardians[slot], slot, salt: salts[slot] });
      return { secret, address, heirSalt, confirm, ix: client.createCapsuleIx({ payer, commitment, config, proof }) };
    };
    const beatIx = (capsule: { secret: bigint; address: PublicKey }, nonce = 0n) => {
      const expiresAt = h.now() + liveness.DEFAULT_PROOF_LIFETIME;
      const proof = liveness.proveLiveness(capsule.secret, PROGRAM_ID, capsule.address, nonce, expiresAt);
      return client.heartbeatIx({ capsule: capsule.address, proof, expiresAt });
    };

    it("pays for a whole inheritance while signing only as fee payer and rent payer", async () => {
      const relayer = h.wallet(2);
      const service = serviceFor(relayer);
      const [heir, guardian] = [h.wallet(0), h.wallet(0)]; // no SOL: the relayer pays everything
      const capsule = newCapsuleIx(relayer.publicKey, [guardian.publicKey], heir.publicKey);
      const ok = async (base64: string) => {
        const reply = await service.relay(base64);
        expect(reply.status, JSON.stringify(reply.body)).to.equal(200);
      };

      await ok(posted([capsule.ix], relayer.publicKey));
      await ok(posted([beatIx(capsule)], relayer.publicKey));
      h.warp(60);
      await ok(posted([client.triggerClaimIx({ capsule: capsule.address })], relayer.publicKey));
      await ok(posted([capsule.confirm(0)], relayer.publicKey, [guardian]));
      h.warp(60);
      await ok(posted([client.claimIx({ capsule: capsule.address, heir: heir.publicKey, salt: capsule.heirSalt })], relayer.publicKey, [heir]));

      expect(client.decodeCapsule(Uint8Array.from(h.svm.getAccount(capsule.address)!.data)).status).to.equal("claimed");
      expect(Number(h.svm.getBalance(heir.publicKey) ?? 0n) + Number(h.svm.getBalance(guardian.publicKey) ?? 0n)).to.equal(0);
    });

    it("refuses every transaction that could spend its SOL on anything else", async () => {
      const relayer = h.wallet(2);
      const service = serviceFor(relayer);
      const attacker = h.wallet(0);
      const guardian = h.wallet(0);
      const capsule = newCapsuleIx(relayer.publicKey, [relayer.publicKey, guardian.publicKey], attacker.publicKey);
      expect((await service.relay(posted([capsule.ix], relayer.publicKey))).status).to.equal(200);
      const before = h.svm.getBalance(relayer.publicKey);
      const beat = () => beatIx(capsule);
      // Accounts the program ignores, signed by throwaway keys: each signature is another 5 000-lamport fee.
      const extra = Array.from({ length: 8 }, () => Keypair.generate());
      const padded = (ix: TransactionInstruction, signers: Keypair[]) =>
        new TransactionInstruction({
          programId: ix.programId,
          data: ix.data,
          keys: [...ix.keys, ...signers.map(({ publicKey }) => ({ pubkey: publicKey, isSigner: true, isWritable: false }))],
        });

      const refusals: [string, unknown, RegExp][] = [
        ["a heartbeat padded with 8 extra signers (9× the fee)", posted([padded(beat(), extra)], relayer.publicKey, extra), /takes exactly 1 account/],
        ["a confirmation padded with one extra signer", posted([padded(capsule.confirm(1), [extra[0]])], relayer.publicKey, [guardian, extra[0]]), /takes exactly 2 accounts/],
        ["a heartbeat that asks for a second signature",
          posted([new TransactionInstruction({ ...beat(), keys: [{ pubkey: capsule.address, isSigner: true, isWritable: true }] })], relayer.publicKey),
          /too many signatures/],
        ["drain through a System transfer",
          posted([SystemProgram.transfer({ fromPubkey: relayer.publicKey, toPubkey: attacker.publicKey, lamports: LAMPORTS_PER_SOL })], relayer.publicKey),
          /only SIKRIT instructions/],
        ["SIKRIT instruction smuggling a second one", posted([beat(), beat()], relayer.publicKey), /exactly one instruction/],
        ["someone else as fee payer", posted([beat()], attacker.publicKey, [attacker]), /must be the fee payer/],
        ["the relayer as a guardian (it was listed as one)", posted([capsule.confirm(0)], relayer.publicKey), /signs only as fee payer/],
        ["an unknown SIKRIT instruction",
          posted([new TransactionInstruction({ programId: PROGRAM_ID, keys: [], data: Buffer.alloc(8, 7) })], relayer.publicKey),
          /unknown SIKRIT instruction/],
        ["a missing co-signature", posted([capsule.confirm(1)], relayer.publicKey), /signature is missing or invalid/],
        ["not a transaction", "bm90IGEgdHJhbnNhY3Rpb24=", /expected \{ transaction/],
        ["not even a string", { transaction: 1 }, /expected \{ transaction/],
      ];
      for (const [what, body, error] of refusals) {
        const reply = await service.relay(body);
        expect(reply.status, what).to.equal(400);
        expect(reply.body.error, what).to.match(error);
      }
      expect(h.svm.getBalance(relayer.publicKey), "nothing was sent").to.equal(before);
    });

    it("hands program errors back with their logs, so the app can name them", async () => {
      const relayer = h.wallet(2);
      const service = serviceFor(relayer);
      const capsule = newCapsuleIx(relayer.publicKey, [h.wallet(0).publicKey], h.wallet(0).publicKey);
      await service.relay(posted([capsule.ix], relayer.publicKey));
      const stale = beatIx(capsule, 5n); // wrong nonce
      const reply = await service.relay(posted([stale], relayer.publicKey));
      expect(reply.status).to.equal(422);
      expect(client.explainError(Object.assign(new Error(reply.body.error), { logs: reply.body.logs }))).to.match(/ProofVerificationFailed/);
    });

    it("rate-limits each client, caps new capsules, and says when it is out of SOL", async () => {
      const relayer = h.wallet(2);
      const service = serviceFor(relayer, { perMinute: 3, capsulesPerHour: 1 });
      const people = (): [PublicKey[], PublicKey] => [[h.wallet(0).publicKey], h.wallet(0).publicKey];
      expect((await service.relay(posted([newCapsuleIx(relayer.publicKey, ...people()).ix], relayer.publicKey), "a")).status).to.equal(200);
      const second = await service.relay(posted([newCapsuleIx(relayer.publicKey, ...people()).ix], relayer.publicKey), "a");
      expect([second.status, second.body.error]).to.deep.equal([429, "relayer: too many requests from this address, try again in a minute"]);
      expect((await service.relay(posted([newCapsuleIx(relayer.publicKey, ...people()).ix], relayer.publicKey), "b")).status).to.equal(200);

      const keeper = (address: PublicKey) => posted([client.triggerClaimIx({ capsule: address })], relayer.publicKey);
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) statuses.push((await service.relay(keeper(Keypair.generate().publicKey), "c")).status);
      expect(statuses, "program errors still count; the fourth request in a minute is refused").to.deep.equal([422, 422, 422]);
      expect((await service.relay(keeper(Keypair.generate().publicKey), "c")).status).to.equal(429);

      const broke = serviceFor(Keypair.generate());
      const reply = await broke.relay(posted([client.triggerClaimIx({ capsule: Keypair.generate().publicKey })], broke.publicKey));
      expect(reply.status).to.equal(503);
      expect(reply.body.error).to.include(`out of test SOL, send devnet SOL to ${broke.publicKey.toBase58()}`);
    });

    it("knows the same instructions as the SDK and serves Vercel and plain Node requests alike", async () => {
      const names: Record<string, keyof typeof client.DISCRIMINATORS> = {
        create_capsule: "createCapsule", heartbeat: "heartbeat", trigger_claim: "triggerClaim",
        guardian_confirm: "guardianConfirm", guardian_veto: "guardianVeto", claim: "claim",
      };
      for (const { name, discriminator } of relayService.RELAYED) {
        expect(bytesToHex(discriminator), name).to.equal(bytesToHex(client.DISCRIMINATORS[names[name]]));
      }

      const relayer = h.wallet(2);
      const handler = relayService.relayHandler(serviceFor(relayer));
      const call = async (method: string, body?: unknown, parsedByPlatform = false) => {
        const text = typeof body === "string" ? body : JSON.stringify(body);
        const raw = body === undefined || parsedByPlatform ? [] : [Buffer.from(text)];
        const req = Object.assign(Readable.from(raw), { method, headers: {}, ...(parsedByPlatform ? { body } : {}) });
        const res = { statusCode: 0, text: "", headers: {} as Record<string, string>,
          setHeader(name: string, value: string) { this.headers[name] = value; }, end(text: string) { this.text = text; } };
        await handler(req as never, res as never);
        expect(res.headers["cache-control"]).to.equal("no-store");
        return { status: res.statusCode, body: JSON.parse(res.text) };
      };
      expect(await call("GET")).to.deep.equal({ status: 200, body: { relayer: relayer.publicKey.toBase58() } });
      const tx = () => posted([client.triggerClaimIx({ capsule: Keypair.generate().publicKey })], relayer.publicKey);
      expect((await call("POST", { transaction: tx() })).status, "streamed body (vite dev/preview)").to.equal(422);
      expect((await call("POST", { transaction: tx() }, true)).status, "parsed body (Vercel)").to.equal(422);
      expect((await call("POST", "{oops")).status).to.equal(400);
      expect((await call("PUT")).status).to.equal(405);

      const unconfigured = relayService.relayHandler(undefined);
      const res = { statusCode: 0, text: "", setHeader() {}, end(text: string) { this.text = text; } };
      await unconfigured(Object.assign(Readable.from([]), { method: "GET", headers: {} }) as never, res as never);
      expect([res.statusCode, JSON.parse(res.text).error]).to.deep.equal([503, "relayer not configured (RELAYER_SECRET_KEY)"]);
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
      expect(bytesToHex(Uint8Array.from(account.heirCommitment))).to.equal(bytesToHex(capsule.config.heirCommitment));
      expect(account.heir.equals(PublicKey.default)).to.equal(true);
      expect(account.guardianCommitments.map((c) => bytesToHex(Uint8Array.from(c)))).to.deep.equal(
        capsule.config.guardianCommitments.map(bytesToHex),
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

      // Neither the wallet that paid rent nor any family wallet is recorded in capsule state or the event.
      const raw = Buffer.from(h.svm.getAccount(capsule.address)!.data);
      const event = h.events(tx)[0];
      expect(event.name).to.equal("capsuleCreated");
      for (const wallet of [ownerWallet, capsule.heir, ...capsule.guardians]) {
        expect(raw.includes(wallet.publicKey.toBuffer())).to.equal(false);
        expect(JSON.stringify(event.data)).to.not.include(wallet.publicKey.toBase58());
      }
      expect(event.data).to.not.have.property("heir");
    });

    it("hides the heir and guardians behind salted commitments that link to no wallet and no other capsule", async () => {
      // The same family guards two capsules: nothing on-chain says so.
      const heir = h.wallet();
      const guardians = [h.wallet(), h.wallet()];
      const first = (await h.newCapsule({ heir, guardianWallets: guardians })).capsule;
      const second = (await h.newCapsule({ heir, guardianWallets: guardians })).capsule;
      const [a, b] = [h.capsule(first.address), h.capsule(second.address)];
      expect(bytesToHex(Uint8Array.from(a.heirCommitment))).to.not.equal(bytesToHex(Uint8Array.from(b.heirCommitment)));
      const shared = a.guardianCommitments.map((c) => bytesToHex(Uint8Array.from(c)))
        .filter((c) => b.guardianCommitments.some((d) => bytesToHex(Uint8Array.from(d)) === c));
      expect(shared).to.deep.equal([]);

      // Without the salt a guess of the wallet does not reproduce the commitment, even with the right P and role.
      const guess = liveness.memberCommitment(first.commitment, HEIR, heir.publicKey, new Uint8Array(32));
      expect(bytesToHex(guess)).to.not.equal(bytesToHex(Uint8Array.from(a.heirCommitment)));
      expect(bytesToHex(liveness.memberCommitment(first.commitment, HEIR, heir.publicKey, first.heirSalt)))
        .to.equal(bytesToHex(Uint8Array.from(a.heirCommitment)));
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

      const hijacked = { ...config, heirCommitment: h.sampleConfig({}, commitment).config.heirCommitment };
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
      const heir = randomBytes(32);
      const g = () => randomBytes(32);
      const guardian = g();
      const cases: [string, Partial<liveness.CapsuleConfigInput>][] = [
        ["HeartbeatIntervalTooShort", { heartbeatInterval: 59n }],
        ["GracePeriodTooShort", { gracePeriod: 59n }],
        ["InvalidHeir", { heirCommitment: new Uint8Array(32) }],
        ["TooManyGuardians", { guardianCommitments: [g(), g(), g(), g(), g(), g()], guardianThreshold: 1 }],
        ["InvalidGuardianThreshold", { guardianCommitments: [g()], guardianThreshold: 2 }],
        ["InvalidGuardian", { guardianCommitments: [new Uint8Array(32)], guardianThreshold: 1 }],
        ["DuplicateGuardian", { guardianCommitments: [guardian, guardian], guardianThreshold: 1 }],
        ["HeirCannotBeGuardian", { heirCommitment: heir, guardianCommitments: [heir], guardianThreshold: 1 }],
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
      const beat = h.beat(capsule);
      expectSuccess(await h.heartbeat(capsule, { beat }));

      // The proof is public in the transaction: replayed at once, the nonce has moved on; replayed once the owner
      // goes silent, it has expired as well.
      expectError(await h.heartbeat(capsule, { beat }), "ProofVerificationFailed");
      h.warp(30 * DAY);
      expectError(await h.heartbeat(capsule, { beat }), "ProofExpired");
      expect(h.capsule(capsule.address).heartbeatNonce.toNumber()).to.equal(1);
      expectSuccess(await h.triggerClaim(capsule));
    });

    it("rejects proofs bound to a stale or future nonce", async () => {
      const { capsule, result } = await h.newCapsule();
      expectSuccess(result);
      expectSuccess(await h.heartbeat(capsule));

      for (const nonce of [0n, 2n]) {
        expectError(await h.heartbeat(capsule, { beat: h.beat(capsule, { nonce }) }), "ProofVerificationFailed");
      }
      expectSuccess(await h.heartbeat(capsule, { beat: h.beat(capsule, { nonce: 1n }) }));
    });

    it("binds every proof to a short expiry: a withheld proof dies, and nobody can stretch it", async () => {
      const { capsule, result } = await h.newCapsule();
      expectSuccess(result);

      // A relayer holds the owner's proof back instead of sending it…
      const withheld = h.beat(capsule);
      h.warp(Number(liveness.DEFAULT_PROOF_LIFETIME) + 1);
      expectError(await h.heartbeat(capsule, { beat: withheld }), "ProofExpired");
      // …and cannot move the expiry, which the challenge covers.
      expectError(await h.heartbeat(capsule, { beat: { ...withheld, expiresAt: h.now() + 60n } }), "ProofVerificationFailed");

      // At most MAX_PROOF_LIFETIME ahead of the cluster clock, inclusive at both ends.
      const max = liveness.MAX_PROOF_LIFETIME;
      expectError(await h.heartbeat(capsule, { beat: h.beat(capsule, { expiresAt: h.now() + max + 1n }) }), "ProofExpiryTooFar");
      expectSuccess(await h.heartbeat(capsule, { beat: h.beat(capsule, { expiresAt: h.now() + max }) }));
      expectSuccess(await h.heartbeat(capsule, { beat: h.beat(capsule, { expiresAt: h.now() }) }));
      expectError(await h.heartbeat(capsule, { beat: h.beat(capsule, { expiresAt: h.now() - 1n }) }), "ProofExpired");
      expect(h.capsule(capsule.address).heartbeatNonce.toNumber()).to.equal(2);
    });

    it("rejects a proof made with the wrong secret", async () => {
      const { capsule, result } = await h.newCapsule();
      expectSuccess(result);
      const forged = h.beat(capsule, { secret: liveness.generateLivenessSecret() });
      expectError(await h.heartbeat(capsule, { beat: forged }), "ProofVerificationFailed");
    });

    it("rejects the registration proof-of-possession replayed as a heartbeat (domain separation)", async () => {
      const { capsule, result } = await h.newCapsule();
      expectSuccess(result);
      const beat = { proof: capsule.registrationProof, expiresAt: h.now() + 60n };
      expectError(await h.heartbeat(capsule, { beat }), "ProofVerificationFailed");
    });

    it("rejects malformed proofs: R off the curve and non-canonical s", async () => {
      const { capsule, result } = await h.newCapsule();
      expectSuccess(result);
      const valid = h.beat(capsule);

      const badR = { ...valid, proof: { ...valid.proof, r: Array.from(notACurvePoint()) } };
      expectError(await h.heartbeat(capsule, { beat: badR }), "InvalidProofR");

      const badS = { ...valid, proof: { ...valid.proof, s: new Array(32).fill(0xff) } };
      expectError(await h.heartbeat(capsule, { beat: badS }), "InvalidProofS");
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
      expectError(await h.guardianConfirm(capsule, capsule.heir, { slot: 0, salt: capsule.heirSalt }), "UnauthorizedGuardian");
      expectError(await h.guardianConfirm(capsule, h.wallet()), "UnauthorizedGuardian");
    });

    it("makes each guardian open its own commitment: no other slot, no wrong salt, no copied opening", async () => {
      const capsule = await h.pendingCapsule({ guardians: 3, threshold: 2 });
      const [first, second] = capsule.guardians;
      const own = h.opening(capsule, first);

      expectError(await h.guardianConfirm(capsule, first, h.opening(capsule, second)), "UnauthorizedGuardian");
      expectError(await h.guardianConfirm(capsule, first, { slot: own.slot, salt: randomBytes(32) }), "UnauthorizedGuardian");
      expectError(await h.guardianConfirm(capsule, first, { slot: 3, salt: own.salt }), "UnauthorizedGuardian");
      // A front-runner who saw the opening (slot + salt are public in the guardian's transaction) still lacks the
      // guardian's signature.
      expectError(await h.guardianConfirm(capsule, h.wallet(), own), "UnauthorizedGuardian");

      const tx = expectSuccess(await h.guardianConfirm(capsule, first, own));
      const [event] = h.events(tx);
      expect(event.data.guardian.equals(first.publicKey)).to.equal(true);
      expect(h.capsule(capsule.address).approvals).to.equal(0b001);
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
    it("rejects anyone but the committed heir, and the heir without the kit's salt", async () => {
      const capsule = await h.pendingCapsule({ guardians: 1, threshold: 0 });
      h.warp(7 * DAY);
      expectError(await h.claim(capsule, capsule.guardians[0]), "UnauthorizedHeir");
      expectError(await h.claim(capsule, capsule.guardians[0], capsule.guardianSalts[0]), "UnauthorizedHeir");
      expectError(await h.claim(capsule, h.wallet()), "UnauthorizedHeir");
      expectError(await h.claim(capsule, capsule.heir, randomBytes(32)), "UnauthorizedHeir");
      expect(h.capsule(capsule.address).heir.equals(PublicKey.default)).to.equal(true);
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

      expect(h.capsule(capsule.address).heir.equals(PublicKey.default)).to.equal(true);
      const tx = expectSuccess(await h.claim(capsule));
      const account = h.capsule(capsule.address);
      expect(statusOf(account)).to.equal("claimed");
      // The claim reveals the heir, so guardians can match the inbox they release to.
      expect(account.heir.equals(capsule.heir.publicKey)).to.equal(true);
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
      // The kit also carries a random salt per holder; the chain gets only the salted commitments to the heir
      // and guardians, so nobody can look the family up by wallet.
      const portableKit = kit.encodeKit(sealed);
      const { capsule, result } = await h.newCapsule({
        secret,
        heir,
        guardianWallets: guardians,
        heirSalt: sealed.shares[0].salt,
        guardianSalts: sealed.shares.slice(1).map((entry) => entry.salt),
        threshold: 2,
        interval: 30 * DAY,
        grace: 7 * DAY,
        shareHashes: sealed.shareHashes,
      });
      expectSuccess(result);
      const roster = kit.rosterCommitments(sealed);
      expect(bytesToHex(roster.heir)).to.equal(bytesToHex(capsule.config.heirCommitment));
      expect(roster.guardians.map(bytesToHex)).to.deep.equal(capsule.config.guardianCommitments.map(bytesToHex));

      /** What any participant reads from the chain before acting on the kit. */
      const chainState = (): kit.CapsuleState => {
        const account = h.capsule(capsule.address);
        return {
          commitment: Uint8Array.from(account.commitment),
          heirCommitment: Uint8Array.from(account.heirCommitment),
          guardianCommitments: account.guardianCommitments.map((c) => Uint8Array.from(c)),
          shareHashes: account.shareHashes.map((hash) => Uint8Array.from(hash)),
          claimed: statusOf(account) === "claimed",
          heir: account.heir.equals(PublicKey.default) ? null : account.heir.toBytes(),
        };
      };
      /** Family wallets stored in the capsule account. */
      const walletsOnChain = () => {
        const raw = Buffer.from(h.svm.getAccount(capsule.address)!.data);
        return [heir, ...guardians].filter((wallet) => raw.includes(wallet.publicKey.toBuffer()));
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
      expect(walletsOnChain()).to.deep.equal([]);

      // Two of the three guardians vouch, each opening their own commitment with the salt from their copy of the
      // kit; nobody vetoes during the grace period.
      for (const g of [0, 2]) {
        const member = kit.membership(kit.decodeKit(portableKit), guardians[g].publicKey.toBytes())!;
        expect(member).to.include({ role: "guardian", slot: g, index: g + 1 });
        expectSuccess(await h.guardianConfirm(capsule, guardians[g], member));
      }
      expect(() => kit.releaseShare(heirKit, eagerShare, chainState())).to.throw(/not been claimed/);
      h.warp(7 * DAY);
      const heirMember = kit.membership(heirKit, heir.publicKey.toBytes())!;
      expect(heirMember).to.include({ role: "heir", slot: -1, index: 0 });
      expectSuccess(await h.claim(capsule, heir, heirMember.salt));
      expect(statusOf(h.capsule(capsule.address))).to.equal("claimed");
      // Only the claim put a family wallet into the capsule: the heir's. Guardian #2 never appears anywhere.
      expect(walletsOnChain()).to.deep.equal([heir]);

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
