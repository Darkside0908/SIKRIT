/**
 * Writes a program binary into an upgradeable-loader buffer at a pace the public devnet RPC accepts.
 *
 * `solana program write-buffer --use-rpc` fires every chunk at once and the public endpoint answers HTTP 429 ("Too
 * many requests from your IP"); on 2 Oct 2026 it wrote 15 of 394 chunks in 12 minutes. This sends at most a few
 * transactions per second, skips chunks the buffer already holds, and re-sends what did not land, until the buffer
 * matches the file byte for byte. Then upgrade from the buffer:
 *
 *   solana program deploy -u devnet --keypair ~/.config/solana/id.json \
 *     --program-id FJKqfFBf6Sw87eAfpgDbibiWUKhpmdVjFxexc9BTc45F --buffer <buffer keypair file>
 *
 *   node scripts/write-buffer.mjs <program.so> <buffer keypair file | buffer address>
 *
 *   RPC_URL    default https://api.devnet.solana.com
 *   AUTHORITY  buffer authority and fee payer (default ~/.config/solana/id.json)
 *   TPS        transactions per second (default 3; the public RPC allows ~40 calls per method per 10 s)
 *
 * Given a keypair file for a buffer that does not exist yet, it creates the buffer first (rent ≈ 2 SOL for this
 * program on devnet, returned when the upgrade consumes the buffer or by `solana program close`). Given an address, it
 * resumes an existing buffer, e.g. one a failed `solana program deploy` left behind.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";

const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const BUFFER_HEADER = 37; // UpgradeableLoaderState::Buffer { authority: Option<Pubkey> }
const CHUNK = 1000; // a Write with one signer fits 1012 bytes in a 1232-byte transaction

const [file, bufferArg] = process.argv.slice(2);
if (!file || !bufferArg) {
  console.error("usage: node scripts/write-buffer.mjs <program.so> <buffer keypair file | buffer address>");
  process.exit(2);
}
const readKeypair = (path) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
const program = readFileSync(file);
const bufferSigner = existsSync(bufferArg) ? readKeypair(bufferArg) : undefined;
const buffer = bufferSigner?.publicKey ?? new PublicKey(bufferArg);
const authority = readKeypair(process.env.AUTHORITY ?? `${homedir()}/.config/solana/id.json`);
const connection = new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const pause = 1000 / Number(process.env.TPS ?? 3);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries a read through HTTP 429s (web3.js already backs off; this outlasts a long throttle). */
async function patiently(read) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= 8) throw error;
      await sleep(5000);
    }
  }
}

function writeInstruction(offset, bytes) {
  const data = Buffer.alloc(16 + bytes.length);
  data.writeUInt32LE(1, 0); // UpgradeableLoaderInstruction::Write
  data.writeUInt32LE(offset, 4);
  data.writeBigUInt64LE(BigInt(bytes.length), 8);
  bytes.copy(data, 16);
  return new TransactionInstruction({
    programId: LOADER,
    keys: [
      { pubkey: buffer, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/** Offsets of the chunks the buffer does not hold yet. */
async function missingChunks() {
  const account = await patiently(() => connection.getAccountInfo(buffer));
  if (!account || !account.owner.equals(LOADER)) throw new Error(`${buffer.toBase58()} is not a loader buffer`);
  if (account.data.length !== BUFFER_HEADER + program.length) {
    throw new Error(`buffer holds ${account.data.length - BUFFER_HEADER} bytes, the program has ${program.length}`);
  }
  if (account.data[0] !== 1 || account.data[4] !== 1 || !authority.publicKey.equals(new PublicKey(account.data.subarray(5, 37)))) {
    throw new Error("buffer authority is not the AUTHORITY keypair");
  }
  const held = account.data.subarray(BUFFER_HEADER);
  const missing = [];
  for (let offset = 0; offset < program.length; offset += CHUNK) {
    const end = Math.min(offset + CHUNK, program.length);
    if (!program.subarray(offset, end).equals(held.subarray(offset, end))) missing.push(offset);
  }
  return missing;
}

if (bufferSigner && !(await patiently(() => connection.getAccountInfo(buffer)))) {
  const space = BUFFER_HEADER + program.length;
  const lamports = await patiently(() => connection.getMinimumBalanceForRentExemption(space));
  const create = new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: buffer, lamports, space, programId: LOADER }),
    new TransactionInstruction({
      programId: LOADER, // UpgradeableLoaderInstruction::InitializeBuffer, authority = AUTHORITY
      keys: [
        { pubkey: buffer, isSigner: false, isWritable: true },
        { pubkey: authority.publicKey, isSigner: false, isWritable: false },
      ],
      data: Buffer.alloc(4),
    }),
  );
  await sendAndConfirmTransaction(connection, create, [authority, bufferSigner]);
  console.log(`created buffer ${buffer.toBase58()} (${lamports / 1e9} SOL rent)`);
}

const total = Math.ceil(program.length / CHUNK);
for (let round = 1; ; round++) {
  const missing = await missingChunks();
  console.log(`round ${round}: ${total - missing.length}/${total} chunks in the buffer`);
  if (missing.length === 0) break;
  if (round > 6) throw new Error("buffer still incomplete after 6 rounds");

  let { blockhash, lastValidBlockHeight } = await patiently(() => connection.getLatestBlockhash());
  let fetchedAt = Date.now();
  const sent = [];
  for (const offset of missing) {
    if (Date.now() - fetchedAt > 30_000) {
      ({ blockhash, lastValidBlockHeight } = await patiently(() => connection.getLatestBlockhash()));
      fetchedAt = Date.now();
    }
    const tx = new Transaction({ feePayer: authority.publicKey, blockhash, lastValidBlockHeight });
    tx.add(writeInstruction(offset, program.subarray(offset, Math.min(offset + CHUNK, program.length))));
    tx.sign(authority);
    try {
      sent.push(await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true }));
    } catch (error) {
      console.log(`  send at offset ${offset} failed (${error.message.slice(0, 80)}); retried next round`);
    }
    await sleep(pause);
  }

  // Wait until every signature is final or its blockhash has certainly expired (~90 s), then re-read the buffer.
  const deadline = Date.now() + 100_000;
  let pending = sent;
  while (pending.length && Date.now() < deadline) {
    await sleep(4000);
    const next = [];
    for (let i = 0; i < pending.length; i += 256) {
      const batch = pending.slice(i, i + 256);
      const { value } = await patiently(() => connection.getSignatureStatuses(batch));
      value.forEach((status, j) => {
        if (!status || (status.confirmationStatus !== "confirmed" && status.confirmationStatus !== "finalized")) next.push(batch[j]);
      });
    }
    pending = next;
  }
  console.log(`  sent ${sent.length}, unconfirmed ${pending.length}`);
}
console.log(`buffer ${buffer.toBase58()} matches ${file} (${program.length} bytes)`);
