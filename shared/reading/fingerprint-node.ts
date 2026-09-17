/**
 * Node-side content fingerprint (build checker and tests).
 *
 * Split out of `contract.ts` so the shared module that the browser reader loads
 * carries no `node:` import at all: the browser path uses Web Crypto, this path
 * uses `node:crypto`, and both hash the same payload (CONTRACT.md §2).
 */
import { createHash } from "node:crypto";
import { fingerprintPayload, type FingerprintInput } from "./contract.ts";

export async function fingerprintContentNode(input: FingerprintInput): Promise<string> {
  return createHash("sha256").update(fingerprintPayload(input)).digest("hex");
}
