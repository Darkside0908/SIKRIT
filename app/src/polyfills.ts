// Must be the first import: @solana/web3.js expects a global Buffer in the browser.
import { Buffer } from "buffer";

const scope = globalThis as unknown as { Buffer?: typeof Buffer };
scope.Buffer ??= Buffer;
