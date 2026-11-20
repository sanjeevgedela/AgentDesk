import {
  address, appendTransactionMessageInstruction, createKeyPairSignerFromBytes, createSolanaRpc,
  createTransactionMessage, getBase64EncodedWireTransaction, getSignatureFromTransaction, pipe,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
} from "@solana/kit";
import { z } from "zod";
import { canonicalJSON, sha256 } from "./canonical";
import type { Decision } from "./engine";
import type { Policy } from "./policy";

export const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const endpoint = "https://api.devnet.solana.com";
const rpc = createSolanaRpc(endpoint);
export type Anchor = { status: "pending" | "confirmed" | "mismatch" | "failed"; attempts: number; updated: number; policyHash: string; signature?: string; slot?: string; detail?: string };
export function anchorEnabled() { return Boolean(process.env.SOLANA_AGENT_KEYPAIR || process.env.SOLANA_DEVNET_KEYPAIR); }

function decisionHash({ anchor: _, validation: _validation, ...decision }: Decision) {
  void _;
  void _validation;
  return sha256(decision);
}
export function memoPayload(decision: Decision, policyHash: string) {
  return { v: 1, d: decision.id, a: decision.agent, n: decision.version, h: decisionHash(decision), p: policyHash };
}
export class AnchorSimulationError extends Error {}

export async function anchorDecision(decision: Decision, policy: Policy, onSigned: (signature: string) => Promise<void> = async () => {}, client = rpc) {
  const key = z.array(z.number().int().min(0).max(255)).length(64)
    .parse(JSON.parse(process.env.SOLANA_AGENT_KEYPAIR || process.env.SOLANA_DEVNET_KEYPAIR || "null"));
  const signer = await createKeyPairSignerFromBytes(Uint8Array.from(key));
  const signal = AbortSignal.timeout(12_000);
  const { value: blockhash } = await client.getLatestBlockhash({ commitment: "confirmed" }).send({ abortSignal: signal });
  const message = new TextEncoder().encode(canonicalJSON(memoPayload(decision, sha256(policy))));
  if (message.length >= 400) throw new Error("Memo exceeds size limit.");
  const compiled = pipe(
    createTransactionMessage({ version: 0 }),
    tx => setTransactionMessageFeePayerSigner(signer, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
    tx => appendTransactionMessageInstruction({ programAddress: address(MEMO), data: message }, tx),
  );
  const signed = await signTransactionMessageWithSigners(compiled);
  const wire = getBase64EncodedWireTransaction(signed);
  const simulation = await client.simulateTransaction(wire, { encoding: "base64", sigVerify: true, commitment: "confirmed" }).send({ abortSignal: signal });
  if (simulation.value.err) throw new AnchorSimulationError("Memo transaction failed simulation.");
  const signature = getSignatureFromTransaction(signed);
  await onSigned(signature);
  await client.sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 3n }).send({ abortSignal: signal });
  const result = await verifyAnchor(decision, signature, sha256(policy));
  return { signature, ...result };
}

const receipt = z.object({ result: z.object({
  slot: z.number().int().nonnegative(), meta: z.object({ err: z.unknown() }),
  transaction: z.object({ message: z.object({ instructions: z.array(z.object({ programId: z.string(), parsed: z.unknown() })) }) }),
}).nullable() });
export async function verifyAnchor(decision: Decision, signature: string, policyHash = decision.anchor?.policyHash) {
  if (!policyHash || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)) return { state: "failed" } as const;
  try {
    const response = await fetch(endpoint, {
      method: "POST", signal: AbortSignal.timeout(7000), headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [
        signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
      ] }),
    });
    if (!response.ok) return { state: "uncertain" } as const;
    const parsed = receipt.safeParse(await response.json());
    if (!parsed.success || !parsed.data.result) return { state: "uncertain" } as const;
    const tx = parsed.data.result;
    if (tx.meta.err) return { state: "failed" } as const;
    const expected = canonicalJSON(memoPayload(decision, policyHash));
    const match = tx.transaction.message.instructions.some(instruction => {
      if (instruction.programId !== MEMO || typeof instruction.parsed !== "string") return false;
      try { return canonicalJSON(JSON.parse(instruction.parsed)) === expected; } catch { return false; }
    });
    return { state: match ? "confirmed" : "mismatch", slot: String(tx.slot) } as const;
  } catch { return { state: "uncertain" } as const; }
}
