/**
 * SIKRIT — client SDK tests (no validator needed).
 *
 * Known-answer vectors pin every primitive to an external reference, so the browser app, this
 * suite and any future port (Rust/WASM, mobile) must agree byte-for-byte:
 *   - sdk/hpke.ts    ← RFC 9180 Appendix A.2.1 (DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305)
 *   - sdk/shamir.ts  ← an independent GF(2^8) reference anchored to the FIPS-197 §4.2 examples
 *   - sdk/kit.ts     ← pinned vectors for the inbox-key derivation and the on-chain share hash
 */
import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { Keypair } from "@solana/web3.js";
import { expect } from "chai";

import * as hpke from "../sdk/hpke";
import * as kit from "../sdk/kit";
import * as liveness from "../sdk/liveness";
import * as shamir from "../sdk/shamir";

/** Reference GF(2^8) multiplication: shift-and-add modulo x⁸ + x⁴ + x³ + x + 1, no lookup tables. */
function gmul(a: number, b: number): number {
  let product = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) product ^= a;
    const carry = a & 0x80;
    a = (a << 1) & 0xff;
    if (carry) a ^= 0x1b;
    b >>= 1;
  }
  return product;
}

/** Horner evaluation of Σ coefficients[i]·xⁱ over GF(2^8). */
const evaluate = (coefficients: number[], x: number): number =>
  coefficients.reduceRight((acc, coefficient) => gmul(acc, x) ^ coefficient, 0);

/** All k-element subsets of `items`. */
function subsets<T>(items: T[], k: number): T[][] {
  if (k === 0) return [[]];
  return items.flatMap((item, i) => subsets(items.slice(i + 1), k - 1).map((rest) => [item, ...rest]));
}

const walletSignature = (wallet: Keypair, message: Uint8Array): Uint8Array =>
  ed25519.sign(message, wallet.secretKey.slice(0, 32));

const flipLastBit = (bytes: Uint8Array): Uint8Array => {
  const copy = Uint8Array.from(bytes);
  copy[copy.length - 1] ^= 0x01;
  return copy;
};

describe("SIKRIT SDK", () => {
  describe("HPKE (RFC 9180) — share encryption to heir & guardian inbox keys", () => {
    // RFC 9180 Appendix A.2.1, verbatim.
    const V = {
      info: "4f6465206f6e2061204772656369616e2055726e",
      ikmE: "909a9b35d3dc4713a5e72a4da274b55d3d3821a37e5d099e74a647db583a904b",
      pkEm: "1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a",
      skEm: "f4ec9b33b792c372c1d2c2063507b684ef925b8c75a42dbcbf57d63ccd381600",
      ikmR: "1ac01f181fdf9f352797655161c58b75c656a6cc2716dcb66372da835542e1df",
      pkRm: "4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a",
      skRm: "8057991eef8f1f1af18f4a9491d16a1ce333f695d4db8e38da75975c4478e0fb",
      enc: "1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a",
      sharedSecret: "0bbe78490412b4bbea4812666f7916932b828bba79942424abb65244930d69a7",
      key: "ad2744de8e17f4ebba575b3f5f5a8fa1f69c2a07f6e7500bc60ca6e3e3ec1c91",
      baseNonce: "5c4d98150661b848853b547f",
      exporterSecret: "a3b010d4994890e2c6968a36f64470d3c824c8f5029942feb11e7a74b2921922",
      pt: "4265617574792069732074727574682c20747275746820626561757479",
      encryptions: [
        { seq: 0, aad: "436f756e742d30", nonce: "5c4d98150661b848853b547f", ct: "1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db21993c62ce81883d2dd1b51a28" },
        { seq: 1, aad: "436f756e742d31", nonce: "5c4d98150661b848853b547e", ct: "6b53c051e4199c518de79594e1c4ab18b96f081549d45ce015be002090bb119e85285337cc95ba5f59992dc98c" },
        { seq: 2, aad: "436f756e742d32", nonce: "5c4d98150661b848853b547d", ct: "71146bd6795ccc9c49ce25dda112a48f202ad220559502cef1f34271e0cb4b02b4f10ecac6f48c32f878fae86b" },
        { seq: 4, aad: "436f756e742d34", nonce: "5c4d98150661b848853b547b", ct: "63357a2aa291f5a4e5f27db6baa2af8cf77427c7c1a909e0b37214dd47db122bb153495ff0b02e9e54a50dbe16" },
        { seq: 255, aad: "436f756e742d323535", nonce: "5c4d98150661b848853b5480", ct: "18ab939d63ddec9f6ac2b60d61d36a7375d2070c9b683861110757062c52b8880a5f6b3936da9cd6c23ef2a95c" },
        { seq: 256, aad: "436f756e742d323536", nonce: "5c4d98150661b848853b557f", ct: "7a4a13e9ef23978e2c520fd4d2e757514ae160cd0cd05e556ef692370ca53076214c0c40d4c728d6ed9e727a5b" },
      ],
      exports: [
        { context: "", value: "4bbd6243b8bb54cec311fac9df81841b6fd61f56538a775e7c80a9f40160606e" },
        { context: "00", value: "8c1df14732580e5501b00f82b10a1647b40713191b7c1240ac80e2b68808ba69" },
        { context: "54657374436f6e74657874", value: "5acb09211139c43b3090489a9da433e8a30ee7188ba8b0a9a1ccf0c229283e53" },
      ],
    };
    const info = hexToBytes(V.info);

    it("derives the RFC 9180 A.2.1 key pairs (DeriveKeyPair)", () => {
      const ephemeral = hpke.deriveKeyPair(hexToBytes(V.ikmE));
      const recipient = hpke.deriveKeyPair(hexToBytes(V.ikmR));
      expect(bytesToHex(ephemeral.secretKey)).to.equal(V.skEm);
      expect(bytesToHex(ephemeral.publicKey)).to.equal(V.pkEm);
      expect(bytesToHex(recipient.secretKey)).to.equal(V.skRm);
      expect(bytesToHex(recipient.publicKey)).to.equal(V.pkRm);
    });

    it("reproduces the A.2.1 key schedule on both the sender and the recipient side", () => {
      const sender = hpke.setupBaseS(hexToBytes(V.pkRm), info, hpke.deriveKeyPair(hexToBytes(V.ikmE)));
      const receiver = hpke.setupBaseR(hexToBytes(V.enc), hexToBytes(V.skRm), info);
      for (const ctx of [sender, receiver]) {
        expect(bytesToHex(ctx.enc)).to.equal(V.enc);
        expect(bytesToHex(ctx.sharedSecret)).to.equal(V.sharedSecret);
        expect(bytesToHex(ctx.key)).to.equal(V.key);
        expect(bytesToHex(ctx.baseNonce)).to.equal(V.baseNonce);
        expect(bytesToHex(ctx.exporterSecret)).to.equal(V.exporterSecret);
      }
    });

    it("reproduces every A.2.1 encryption (sequence numbers 0–256) and opens it again", () => {
      const sender = hpke.setupBaseS(hexToBytes(V.pkRm), info, hpke.deriveKeyPair(hexToBytes(V.ikmE)));
      const receiver = hpke.setupBaseR(hexToBytes(V.enc), hexToBytes(V.skRm), info);
      for (const { seq, aad, nonce, ct } of V.encryptions) {
        expect(bytesToHex(hpke.computeNonce(sender.baseNonce, seq))).to.equal(nonce);
        expect(bytesToHex(hpke.contextSeal(sender, hexToBytes(aad), hexToBytes(V.pt), seq))).to.equal(ct);
        expect(bytesToHex(hpke.contextOpen(receiver, hexToBytes(aad), hexToBytes(ct), seq))).to.equal(V.pt);
      }
    });

    it("reproduces the A.2.1 exported values", () => {
      const receiver = hpke.setupBaseR(hexToBytes(V.enc), hexToBytes(V.skRm), info);
      for (const { context, value } of V.exports) {
        expect(bytesToHex(hpke.contextExport(receiver, hexToBytes(context), 32))).to.equal(value);
      }
    });

    it("single-shot seal/open round-trips with a fresh ephemeral key per message", () => {
      const recipient = hpke.generateKeyPair();
      const plaintext = hexToBytes(V.pt);
      const a = hpke.seal(recipient.publicKey, info, plaintext);
      const b = hpke.seal(recipient.publicKey, info, plaintext);
      expect(a.length).to.equal(plaintext.length + hpke.SEAL_OVERHEAD);
      expect(bytesToHex(a.subarray(0, hpke.ENC_LENGTH))).to.not.equal(bytesToHex(b.subarray(0, hpke.ENC_LENGTH)));
      expect(bytesToHex(hpke.open(recipient.secretKey, info, a))).to.equal(V.pt);
      expect(bytesToHex(hpke.open(recipient.secretKey, info, b))).to.equal(V.pt);
    });

    it("refuses to open for the wrong key, info, aad, or a single flipped bit", () => {
      const recipient = hpke.generateKeyPair();
      const aad = hexToBytes("01");
      const box = hpke.seal(recipient.publicKey, info, hexToBytes(V.pt), aad);
      const flipped = Uint8Array.from(box);
      flipped[box.length - 1] ^= 0x01;
      const flippedEnc = Uint8Array.from(box);
      flippedEnc[0] ^= 0x01;

      expect(() => hpke.open(hpke.generateKeyPair().secretKey, info, box, aad)).to.throw();
      expect(() => hpke.open(recipient.secretKey, hexToBytes("00"), box, aad)).to.throw();
      expect(() => hpke.open(recipient.secretKey, info, box, hexToBytes("02"))).to.throw();
      expect(() => hpke.open(recipient.secretKey, info, flipped, aad)).to.throw();
      expect(() => hpke.open(recipient.secretKey, info, flippedEnc, aad)).to.throw();
      expect(() => hpke.open(recipient.secretKey, info, box.subarray(0, hpke.SEAL_OVERHEAD - 1), aad)).to.throw(/too short/);
    });

    it("rejects an all-zero (small-order) ephemeral key instead of deriving a public shared secret", () => {
      const recipient = hpke.generateKeyPair();
      const box = new Uint8Array(hpke.SEAL_OVERHEAD + 1); // enc = 0^32 → X25519 output would be all-zero
      expect(() => hpke.open(recipient.secretKey, info, box)).to.throw();
    });
  });

  describe("liveness key setup (sdk/liveness.ts)", () => {
    it("derives the owner's liveness key only from a deterministic signature by the owner's wallet", async () => {
      const wallet = Keypair.generate();
      const honest = async (message: Uint8Array) => walletSignature(wallet, message);
      const x = await liveness.deriveLivenessSecretFromWallet(wallet.publicKey.toBytes(), honest);
      expect(x).to.equal(liveness.deriveLivenessSecret(walletSignature(wallet, liveness.KEYGEN_MESSAGE)));

      const impostor = Keypair.generate();
      let calls = 0;
      const randomized = async (message: Uint8Array) => walletSignature(calls++ === 0 ? wallet : impostor, message);
      await expectRejection(liveness.deriveLivenessSecretFromWallet(wallet.publicKey.toBytes(), randomized), /deterministically/);
      await expectRejection(
        liveness.deriveLivenessSecretFromWallet(wallet.publicKey.toBytes(), async (m) => walletSignature(impostor, m)),
        /does not match the wallet/,
      );
    });
  });

  describe("Shamir's Secret Sharing over GF(2^8)", () => {
    // Pinned 3-of-5 vector, produced by the table-free reference above from a fixed polynomial
    // per byte: f(x) = secret[i] + a1[i]·x + a2[i]·x² over GF(2^8), share = f(x) bytes ‖ x.
    const KAT = {
      secret: "000102030405060708090a0b0c0d0e0f",
      a1: "f0e1d2c3b4a5968778695a4b3c2d1e0f",
      a2: "0123456789abcdeffedcba9876543210",
      shares: [
        "f1c395a7390b5d6f8ebcead84674221001",
        "ff54b21965ce28832d8660cbb71cfa5102",
        "0e9625bd58c073ebab338018fd65d64e03",
        "fdae5b08aaf90c5f8ad92c7fdd8e7b2804",
        "7295a740c32416f1d53200e76483b156ff",
      ],
    };

    it("anchors the reference field arithmetic to the FIPS-197 §4.2 examples", () => {
      expect(gmul(0x57, 0x83)).to.equal(0xc1);
      expect(gmul(0x57, 0x13)).to.equal(0xfe);
      for (let a = 1; a < 256; a++) expect(gmul(a, 1)).to.equal(a);
    });

    it("reproduces the pinned 3-of-5 vector and reconstructs it from every 3-share subset", async () => {
      const [secret, a1, a2] = [KAT.secret, KAT.a1, KAT.a2].map(hexToBytes);
      KAT.shares.forEach((expected, j) => {
        const x = hexToBytes(expected).at(-1)!;
        const y = Array.from(secret, (s, i) => evaluate([s, a1[i], a2[i]], x));
        expect(bytesToHex(Uint8Array.from([...y, x]))).to.equal(expected);
        expect(shamir.shareX(hexToBytes(expected))).to.equal(x);
      });

      const all = subsets(KAT.shares.map(hexToBytes), 3);
      expect(all).to.have.length(10);
      for (const subset of all) expect(bytesToHex(await shamir.combineShares(subset))).to.equal(KAT.secret);
    });

    it("k − 1 shares reveal nothing: one share of a 2-of-n split is consistent with all 256 secrets", async () => {
      const [share] = await shamir.splitSecret(Uint8Array.of(0x2a), 3, 2);
      const [y, x] = share;
      // For every candidate secret s there is exactly one line through (0, s) and (x, y); its value
      // at another point completes a valid 2-share set that "reconstructs" s.
      const other = x === 1 ? 2 : 1;
      const consistent = new Set<number>();
      for (let s = 0; s < 256; s++) {
        let slope = 0;
        while (gmul(slope, x) !== (y ^ s)) slope++;
        const virtualShare = Uint8Array.of(s ^ gmul(slope, other), other);
        consistent.add((await shamir.combineShares([share, virtualShare]))[0]);
      }
      expect(consistent.size).to.equal(256);
    });

    it("splits into distinct non-zero x-coordinates; any k shares reconstruct, k − 1 do not", async () => {
      const secret = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff);
      const shares = await shamir.splitSecret(secret, 5, 3);
      const xs = shares.map(shamir.shareX);
      expect(new Set(xs).size).to.equal(5);
      expect(xs).to.not.include(0);
      for (const share of shares) expect(share).to.have.length(secret.length + 1);

      for (const subset of subsets(shares, 3)) {
        expect(bytesToHex(await shamir.combineShares(subset))).to.equal(bytesToHex(secret));
      }
      for (const subset of subsets(shares, 2)) {
        expect(bytesToHex(await shamir.combineShares(subset))).to.not.equal(bytesToHex(secret));
      }
    });
  });

  describe("capsule kit — secret sealed to the heir and guardians (SIK-11 custody)", () => {
    const seedPhrase = utf8ToBytes(
      "abandon ability able about above absent absorb abstract absurd abuse access accident",
    );

    type Holder = Awaited<ReturnType<typeof newHolder>>;

    /** A heir or guardian onboarding with their own wallet (sign twice + certificate). */
    async function newHolder() {
      const wallet = Keypair.generate();
      const { keyPair, certificate } = await kit.createInbox(wallet.publicKey.toBytes(), async (message) =>
        walletSignature(wallet, message),
      );
      return { wallet, keyPair, certificate };
    }

    /** Owner + heir + three guardians. */
    async function family() {
      const ownerSecret = liveness.deriveLivenessSecret(
        walletSignature(Keypair.generate(), liveness.KEYGEN_MESSAGE),
      );
      return {
        commitment: liveness.commitmentFromSecret(ownerSecret),
        heir: await newHolder(),
        guardians: [await newHolder(), await newHolder(), await newHolder()],
      };
    }
    type Family = Awaited<ReturnType<typeof family>>;

    /** Heir holds share 0, guardian g holds share g + 1; heir + 2 of 3 guardians reconstruct. */
    const sealFor = (f: Family, secret = seedPhrase) =>
      kit.sealCapsuleKit({
        secret,
        commitment: f.commitment,
        heir: f.heir.certificate,
        guardians: f.guardians.map((g) => g.certificate),
        threshold: 3,
      });

    /** The capsule account as the chain would report it. */
    const chainState = (f: Family, sealed: kit.CapsuleKit, claimed: boolean): kit.CapsuleState => ({
      commitment: f.commitment,
      heir: f.heir.wallet.publicKey.toBytes(),
      guardians: f.guardians.map((g) => g.wallet.publicKey.toBytes()),
      shareHashes: sealed.shareHashes,
      claimed,
    });

    const openOwn = (sealed: kit.CapsuleKit, holder: Holder) =>
      kit.openShare(sealed, kit.findShareIndex(sealed, holder.keyPair.publicKey), holder.keyPair.secretKey);

    it("pins the inbox-key derivation and the on-chain share hash (cross-checked in Python)", () => {
      const inbox = kit.deriveInboxKeyPair(Uint8Array.from({ length: 64 }, (_, i) => i));
      expect(bytesToHex(inbox.secretKey)).to.equal("305c7d16ff5d61f77ac89f9921164984fe04572c2f3c5740b1125113b88f6ffb");
      expect(bytesToHex(inbox.publicKey)).to.equal("1d0f43a5e7cdd9394fa031e8be67b5b045078e8766cba0e9f8413ed546c24659");

      const hash = kit.shareHash(new Uint8Array(32).fill(0x11), Uint8Array.from({ length: 33 }, (_, i) => i));
      expect(bytesToHex(hash)).to.equal("8ad8125089c1977cebfec60ac65726e9ca317188336c273e4410924881fd3274");
    });

    it("derives inbox keys deterministically per wallet and independently of the liveness key", async () => {
      const holder = await newHolder();
      const again = kit.deriveInboxKeyPair(walletSignature(holder.wallet, kit.INBOX_MESSAGE));
      expect(bytesToHex(again.publicKey)).to.equal(bytesToHex(holder.keyPair.publicKey));
      expect(bytesToHex((await newHolder()).keyPair.publicKey)).to.not.equal(bytesToHex(holder.keyPair.publicKey));

      // Different message and domain from the liveness key: one signature never yields both keys.
      expect(bytesToHex(kit.INBOX_MESSAGE)).to.not.equal(bytesToHex(liveness.KEYGEN_MESSAGE));
      const sameSignature = walletSignature(holder.wallet, liveness.KEYGEN_MESSAGE);
      const livenessSecret = liveness.numberToBytesLE(liveness.deriveLivenessSecret(sameSignature));
      expect(bytesToHex(kit.deriveInboxKeyPair(sameSignature).secretKey)).to.not.equal(bytesToHex(livenessSecret));
      expect(() => kit.deriveInboxKeyPair(new Uint8Array(63))).to.throw(/64-byte/);
    });

    it("onboards only wallets that sign deterministically, and only for the wallet that signed", async () => {
      const wallet = Keypair.generate();
      const impostor = Keypair.generate();
      let calls = 0;
      const randomized = async (message: Uint8Array) =>
        walletSignature(calls++ === 0 ? wallet : impostor, message); // 2nd signature differs
      await expectRejection(kit.createInbox(wallet.publicKey.toBytes(), randomized), /deterministically/);
      await expectRejection(
        kit.createInbox(wallet.publicKey.toBytes(), async (message) => walletSignature(impostor, message)),
        /does not match the wallet/,
      );
    });

    it("carries inbox keys in wallet-signed invites; a swapped key or wallet is rejected", async () => {
      const holder = await newHolder();
      const invite = kit.encodeInboxCertificate(holder.certificate);
      expect(invite).to.match(/^sikrit-invite:v1:[0-9a-f]{256}$/);
      const decoded = kit.decodeInboxCertificate(` ${invite}\n`);
      expect(bytesToHex(decoded.inbox)).to.equal(bytesToHex(holder.keyPair.publicKey));
      expect(bytesToHex(decoded.wallet)).to.equal(bytesToHex(holder.wallet.publicKey.toBytes()));

      const attacker = await newHolder();
      const swappedInbox = kit.encodeInboxCertificate({ ...holder.certificate, inbox: attacker.keyPair.publicKey });
      const swappedWallet = kit.encodeInboxCertificate({ ...attacker.certificate, wallet: holder.certificate.wallet });
      expect(() => kit.decodeInboxCertificate(swappedInbox)).to.throw(/invalid/);
      expect(() => kit.decodeInboxCertificate(swappedWallet)).to.throw(/invalid/);
      expect(() => kit.decodeInboxCertificate(invite.replace("v1", "v2"))).to.throw(/not a SIKRIT invite/);
      expect(() => kit.decodeInboxCertificate(invite.slice(0, -2))).to.throw(/bytes/);
    });

    it("heir alone learns nothing; heir + guardian quorum recovers the secret after release", async () => {
      const f = await family();
      const sealed = await sealFor(f);
      expect(sealed.shares).to.have.length(4);
      expect(sealed.shareHashes).to.have.length(4);
      sealed.shares.forEach((entry) => expect(entry.sealed).to.have.length(kit.SEALED_SHARE_LENGTH));

      // The heir can open only share 0 — below the threshold, so no secret yet.
      const heirShare = openOwn(sealed, f.heir);
      await expectRejection(kit.recoverSecret(sealed, [heirShare]), /need 3 distinct shares, have 1/);
      await expectRejection(kit.recoverSecret(sealed, [heirShare, heirShare]), /have 1/);

      // After the on-chain claim, guardians #1 and #3 open their shares and re-seal them to the heir.
      const claimed = chainState(f, sealed, true);
      const releases = [0, 2].map((g) => {
        expect(kit.findShareIndex(sealed, f.guardians[g].keyPair.publicKey)).to.equal(g + 1);
        return kit.releaseShare(sealed, openOwn(sealed, f.guardians[g]), claimed);
      });
      const released = releases.map((release) => kit.openRelease(sealed, release, f.heir.keyPair.secretKey));

      await expectRejection(kit.recoverSecret(sealed, [heirShare, released[0]]), /have 2/);
      const recovered = await kit.recoverSecret(sealed, [heirShare, ...released]);
      expect(new TextDecoder().decode(recovered)).to.equal(new TextDecoder().decode(seedPhrase));

      // Any quorum works, including all three guardians without the heir's own share.
      const allGuardians = f.guardians.map((g) => openOwn(sealed, g));
      expect(bytesToHex(await kit.recoverSecret(sealed, allGuardians))).to.equal(bytesToHex(seedPhrase));
    });

    it("guardians release only after the claim, only to the on-chain heir, and only their own share", async () => {
      const f = await family();
      const sealed = await sealFor(f);
      const guardianShare = openOwn(sealed, f.guardians[0]);
      const attacker = await newHolder();

      // Too early: the capsule is still Active or ClaimPending.
      expect(() => kit.releaseShare(sealed, guardianShare, chainState(f, sealed, false))).to.throw(/not been claimed/);

      // A forged kit naming the attacker as heir does not match the heir registered on-chain.
      const forgedKit = { ...sealed, shares: [{ ...sealed.shares[0], holder: attacker.certificate }, ...sealed.shares.slice(1)] };
      expect(() => kit.releaseShare(forgedKit, guardianShare, chainState(f, sealed, true))).to.throw(/heir and guardians/);

      // A release target certified by any wallet other than the on-chain heir is refused.
      expect(() => kit.releaseShare(sealed, guardianShare, chainState(f, sealed, true), attacker.certificate)).to.throw(/on-chain heir/);
      const mislabeled = { ...attacker.certificate, wallet: f.heir.certificate.wallet };
      expect(() => kit.releaseShare(sealed, guardianShare, chainState(f, sealed, true), mislabeled)).to.throw(/on-chain heir/);

      // The heir's own share is never "released" by someone else.
      expect(() => kit.releaseShare(sealed, openOwn(sealed, f.heir), chainState(f, sealed, true))).to.throw(/not a guardian share/);

      // A heir who rotated inbox keys presents a fresh certificate from the same wallet.
      const rotatedKeys = hpke.generateKeyPair();
      const rotated: kit.InboxCertificate = {
        wallet: f.heir.certificate.wallet,
        inbox: rotatedKeys.publicKey,
        signature: walletSignature(f.heir.wallet, kit.inboxCertificateMessage(rotatedKeys.publicKey)),
      };
      const release = kit.releaseShare(sealed, guardianShare, chainState(f, sealed, true), rotated);
      expect(bytesToHex(kit.openRelease(sealed, release, rotatedKeys.secretKey))).to.equal(bytesToHex(guardianShare));
    });

    it("binds each sealed share to its holder, its position and its capsule", async () => {
      const f = await family();
      const sealed = await sealFor(f);
      // Wrong holder key.
      expect(() => kit.openShare(sealed, 1, f.heir.keyPair.secretKey)).to.throw();
      // Right key, wrong position (the index is HPKE associated data).
      const swapped = { ...sealed, shares: [sealed.shares[1], sealed.shares[0], ...sealed.shares.slice(2)] };
      expect(() => kit.openShare(swapped, 0, f.guardians[0].keyPair.secretKey)).to.throw();
      // Right key, same bytes, presented as another capsule's kit (P is in the HPKE info).
      const foreign = { ...sealed, commitment: (await family()).commitment };
      expect(() => kit.openShare(foreign, 1, f.guardians[0].keyPair.secretKey)).to.throw();
    });

    it("rejects a forged or foreign share by name instead of reconstructing garbage", async () => {
      const f = await family();
      const sealed = await sealFor(f);
      const heirShare = openOwn(sealed, f.heir);
      const guardianShare = openOwn(sealed, f.guardians[0]);

      // A malicious guardian hand-crafts a release of a corrupted share: HPKE opens it, the hash does not match.
      const corrupted = flipLastBit(guardianShare);
      expect(() => kit.releaseShare(sealed, corrupted, chainState(f, sealed, true))).to.throw(/not a guardian share/);
      const releaseInfo = concatBytes(utf8ToBytes("SIKRIT:release:v1"), sealed.commitment);
      const forged = hpke.seal(f.heir.keyPair.publicKey, releaseInfo, corrupted);
      expect(() => kit.openRelease(sealed, forged, f.heir.keyPair.secretKey)).to.throw(/does not match any committed hash/);
      const honest = hpke.seal(f.heir.keyPair.publicKey, releaseInfo, guardianShare);
      expect(bytesToHex(kit.openRelease(sealed, honest, f.heir.keyPair.secretKey))).to.equal(bytesToHex(guardianShare));
      await expectRejection(kit.recoverSecret(sealed, [heirShare, guardianShare, corrupted]), /does not match any committed hash/);

      // A genuine share of a different capsule is just as foreign.
      const other = await family();
      const otherKit = await sealFor(other);
      const otherShare = openOwn(otherKit, other.guardians[1]);
      await expectRejection(kit.recoverSecret(sealed, [heirShare, guardianShare, otherShare]), /does not match any committed hash/);
      const crossRelease = hpke.seal(f.heir.keyPair.publicKey, concatBytes(utf8ToBytes("SIKRIT:release:v1"), otherKit.commitment), otherShare);
      expect(() => kit.openRelease(sealed, crossRelease, f.heir.keyPair.secretKey)).to.throw();
    });

    it("verifies a kit against the capsule's commitment, share hashes, heir and guardians on-chain", async () => {
      const f = await family();
      const sealed = await sealFor(f);
      const state = chainState(f, sealed, false);
      expect(() => kit.verifyKit(sealed, state)).to.not.throw();

      const substitute = await sealFor(f); // same holders, fresh key and shares
      expect(() => kit.verifyKit(substitute, state)).to.throw(/share hashes/);
      const otherCommitment = (await family()).commitment;
      expect(() => kit.verifyKit(sealed, { ...state, commitment: otherCommitment })).to.throw(/different capsule/);
      expect(() => kit.verifyKit(sealed, { ...state, shareHashes: sealed.shareHashes.slice(1) })).to.throw(/share hashes/);
      expect(() => kit.verifyKit(sealed, { ...state, guardians: [...state.guardians].reverse() })).to.throw(/heir and guardians/);
      expect(() => kit.verifyKit(sealed, { ...state, heir: state.guardians[0] })).to.throw(/heir and guardians/);
      const badSignature = { ...sealed, shares: sealed.shares.map((entry, i) =>
        i === 2 ? { ...entry, holder: { ...entry.holder, signature: flipLastBit(entry.holder.signature) } } : entry) };
      expect(() => kit.verifyKit(badSignature, state)).to.throw(/invalid inbox certificate/);
    });

    it("authenticates the payload: a tampered threshold or ciphertext fails closed", async () => {
      const f = await family();
      const sealed = await sealFor(f);
      const shares = [openOwn(sealed, f.heir), openOwn(sealed, f.guardians[0]), openOwn(sealed, f.guardians[1])];
      await expectRejection(kit.recoverSecret({ ...sealed, threshold: 2 }, shares.slice(0, 2)), /payload authentication failed/);
      await expectRejection(kit.recoverSecret({ ...sealed, payload: flipLastBit(sealed.payload) }, shares), /payload authentication failed/);
      expect(bytesToHex(await kit.recoverSecret(sealed, shares))).to.equal(bytesToHex(seedPhrase));
    });

    it("refuses unsafe parameters", async () => {
      const f = await family();
      const guardians = f.guardians.map((g) => g.certificate);
      const base: kit.SealParams = { secret: seedPhrase, commitment: f.commitment, heir: f.heir.certificate, guardians, threshold: 3 };
      const extra = await Promise.all(Array.from({ length: 3 }, newHolder));
      const zeroInbox = new Uint8Array(32);
      const cases: [Partial<kit.SealParams>, RegExp][] = [
        [{ threshold: 1 }, /threshold/],
        [{ threshold: 5 }, /threshold/],
        [{ guardians: [] }, /guardians/],
        [{ guardians: [...guardians, ...extra.map((h) => h.certificate)] }, /guardians/],
        [{ guardians: [guardians[0], guardians[1], guardians[0]] }, /duplicate holder wallet/],
        [{ guardians: [guardians[0], guardians[1], f.heir.certificate] }, /duplicate holder wallet/],
        // Another wallet "certifying" a guardian's inbox key would put two shares in one inbox.
        [{ guardians: [guardians[0], guardians[1], { ...extra[0].certificate, inbox: guardians[0].inbox,
          signature: walletSignature(extra[0].wallet, kit.inboxCertificateMessage(guardians[0].inbox)) }] }, /duplicate holder inbox/],
        [{ guardians: [guardians[0], guardians[1], { ...guardians[2], signature: flipLastBit(guardians[2].signature) }] }, /invalid inbox certificate/],
        [{ secret: new Uint8Array(0) }, /secret/],
        [{ secret: new Uint8Array(kit.MAX_SECRET_LENGTH + 1) }, /secret/],
        [{ commitment: f.commitment.subarray(1) }, /commitment/],
        // A correctly certified all-zero (small-order) X25519 key would make the share key public.
        [{ guardians: [guardians[0], guardians[1], { wallet: extra[1].certificate.wallet, inbox: zeroInbox,
          signature: walletSignature(extra[1].wallet, kit.inboxCertificateMessage(zeroInbox)) }] }, /./],
      ];
      for (const [override, message] of cases) await expectRejection(kit.sealCapsuleKit({ ...base, ...override }), message);
    });

    it("round-trips through the portable JSON encoding; the parser is strict", async () => {
      const f = await family();
      const sealed = await sealFor(f);
      const text = kit.encodeKit(sealed);
      const decoded = kit.decodeKit(text);
      expect(kit.encodeKit(decoded)).to.equal(text);
      kit.verifyKit(decoded, chainState(f, sealed, false));
      const shares = [openOwn(decoded, f.heir), openOwn(decoded, f.guardians[0]), openOwn(decoded, f.guardians[2])];
      expect(bytesToHex(await kit.recoverSecret(decoded, shares))).to.equal(bytesToHex(seedPhrase));
      // A 12-word seed phrase sealed for a heir and three guardians is a ~3 KB file.
      expect(text.length).to.be.lessThan(4096);

      const json = JSON.parse(text);
      type Entry = { wallet: string; inbox: string; signature: string; sealed: string };
      const malformed: Record<string, unknown>[] = [
        { ...json, sikrit: "something-else" },
        { ...json, v: 2 },
        { ...json, threshold: 5 },
        { ...json, threshold: 1 },
        { ...json, commitment: json.commitment.toUpperCase() },
        { ...json, commitment: json.commitment.slice(2) },
        { ...json, payload: json.payload.slice(0, 60) },
        { ...json, shareHashes: json.shareHashes.slice(1) },
        { ...json, shares: [json.shares[0]] },
        { ...json, shares: json.shares.map((e: Entry) => ({ ...e, sealed: e.sealed.slice(2) })) },
        { ...json, shares: json.shares.map((e: Entry) => ({ ...e, wallet: "not-base58-0OIl" })) },
        { ...json, shares: json.shares.map((e: Entry) => ({ ...e, signature: e.signature.slice(2) })) },
      ];
      for (const bad of malformed) expect(() => kit.decodeKit(JSON.stringify(bad))).to.throw(/kit:/);
      expect(() => kit.decodeKit("null")).to.throw(/kit:/);
      expect(() => kit.decodeKit("{not json")).to.throw(/kit:/);
    });
  });
});

async function expectRejection(promise: Promise<unknown>, message: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect((error as Error).message).to.match(message);
    return;
  }
  expect.fail(`expected rejection matching ${message}`);
}
