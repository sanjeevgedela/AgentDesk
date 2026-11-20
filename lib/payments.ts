import { timingSafeEqual, createHash } from "node:crypto";
import { address, createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Client } from "@x402/core/client";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { wrapFetchWithPayment } from "@x402/fetch";
import { withX402, x402ResourceServer } from "@x402/next";
import { toClientSvmSigner } from "@x402/svm";
import { ExactSvmScheme as Client } from "@x402/svm/exact/client";
import { ExactSvmScheme as Server } from "@x402/svm/exact/server";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { evidenceSchema, researchFor } from "./research";
import { PRICE, type Purchase, type Snapshot } from "./engine";

export const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const RPC = "https://api.devnet.solana.com";
const FACILITATOR = "https://x402.org/facilitator";
const receiptPattern = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;
const snapshotSchema = z.object({
  id: z.string().max(160), symbol: z.string().max(120), title: z.string().max(350),
  bid: z.number().int().min(1).max(99), ask: z.number().int().min(1).max(99),
  at: z.iso.datetime(), source: z.string().max(500), mode: z.enum(["live", "replay"]),
}).refine(s => s.bid <= s.ask);


export function paymentReady() {
  return Boolean(process.env.SOLANA_DEVNET_KEYPAIR && process.env.RESEARCH_RECIPIENT &&
    (process.env.RESEARCH_INTERNAL_TOKEN?.length ?? 0) >= 32);
}

function internalAuth(value: string | null) {
  const secret = process.env.RESEARCH_INTERNAL_TOKEN;
  if (!secret || secret.length < 32 || !value) return false;
  const hash = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(hash(value), hash(secret));
}

let paywall: ReturnType<typeof withX402> | undefined;
export async function research(request: NextRequest) {
  if (!internalAuth(request.headers.get("x-agentdesk-internal"))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const recipient = process.env.RESEARCH_RECIPIENT;
  if (!recipient) return NextResponse.json({ error: "Recipient unavailable" }, { status: 503 });
  paywall ??= withX402(async (req): Promise<NextResponse> => {
    const parsed = snapshotSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid snapshot" }, { status: 400 });
    return NextResponse.json(await researchFor(parsed.data));
  }, {
    accepts: [{ scheme: "exact", price: { amount: String(PRICE), asset: MINT, extra: {} }, network: NETWORK, payTo: address(recipient) }],
    description: "AgentDesk quote quality research, operated by AgentDesk",
  }, new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR })).register(NETWORK, new Server()));
  return paywall(request);
}

export class PaymentError extends Error {
  constructor(readonly submitted: boolean) { super("Research payment did not complete."); }
}

export async function pay(snapshot: Snapshot, onReceipt: (receipt: Pick<Purchase, "recipient" | "signature" | "mint">) => Promise<void>) {
  let submitted = false;
  try {
    const recipient = address(process.env.RESEARCH_RECIPIENT!);
    const key = z.array(z.number().int().min(0).max(255)).length(64).parse(JSON.parse(process.env.SOLANA_DEVNET_KEYPAIR!));
    const signer = await createKeyPairSignerFromBytes(Uint8Array.from(key));
    if (signer.address === recipient) throw new Error("Research recipient must differ from the payer.");
    const client = new x402Client().register(NETWORK, new Client(toClientSvmSigner(signer), { rpcUrl: RPC }));
    client.registerPolicy((version, choices) => version === 2 ? choices.filter(r =>
      r.network === NETWORK && r.scheme === "exact" && r.asset === MINT && r.amount === String(PRICE) && r.payTo === recipient) : []);
    const localFetch: typeof fetch = async (input, init) => {
      const request = new NextRequest(input, { ...init, signal: init?.signal ?? undefined });
      if (request.headers.has("payment-signature")) {
        if (submitted) throw new Error("A signed payment has already been submitted.");
        submitted = true;
      }
      const response = await research(request);
      const header = response.headers.get("payment-response");
      if (submitted && header) {
        const settlement = decodePaymentResponseHeader(header);
        if (settlement.network === NETWORK && receiptPattern.test(settlement.transaction))
          await onReceipt({ signature: settlement.transaction, recipient, mint: MINT });
      }
      return response;
    };
    const response = await wrapFetchWithPayment(localFetch, client)("https://agentdesk.internal/api/research", {
      method: "POST", body: JSON.stringify(snapshot),
      headers: { "content-type": "application/json", "x-agentdesk-internal": process.env.RESEARCH_INTERNAL_TOKEN! },
    });
    const header = response.headers.get("payment-response");
    if (!header || !response.ok) throw new Error("Facilitator did not confirm settlement.");
    const settled = decodePaymentResponseHeader(header);
    if (!settled.success || settled.network !== NETWORK) throw new Error("Settlement is not confirmed.");
    const evidence = evidenceSchema.parse(await response.json());
    const verified = await verifyReceipt({ signature: settled.transaction, recipient, mint: MINT });
    if (verified.state !== "confirmed") throw new Error("Devnet RPC has not confirmed the transfer.");
    return { evidence, programs: verified.programs };
  } catch {
    throw new PaymentError(submitted);
  }
}

const tokenBalance = z.object({
  accountIndex: z.number(), mint: z.string(), owner: z.string().optional(),
  uiTokenAmount: z.object({ amount: z.string().regex(/^\d+$/) }),
});
const transaction = z.object({
  meta: z.object({ err: z.unknown(), preTokenBalances: z.array(tokenBalance), postTokenBalances: z.array(tokenBalance) }),
  transaction: z.object({ message: z.object({ instructions: z.array(z.object({ programId: z.string() })) }) }),
});
export async function verifyReceipt(purchase: Pick<Purchase, "signature" | "recipient" | "mint">) {
  if (!purchase.signature || !receiptPattern.test(purchase.signature) || purchase.mint !== MINT || !purchase.recipient)
    return { state: "uncertain" } as const;
  const response = await fetch(RPC, {
    method: "POST", signal: AbortSignal.timeout(7000), headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [
      purchase.signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    ] }),
  });
  if (!response.ok) return { state: "uncertain" } as const;
  const payload = await response.json();
  if (payload.result?.meta?.err) return { state: "failed" } as const;
  const parsed = transaction.safeParse(payload.result);
  if (!parsed.success) return { state: "uncertain" } as const;
  const { meta } = parsed.data;
  const received = meta.postTokenBalances.filter(b => b.mint === MINT && b.owner === purchase.recipient)
    .reduce((sum, b) => {
      const before = meta.preTokenBalances.find(p => p.accountIndex === b.accountIndex && p.mint === MINT);
      return sum + BigInt(b.uiTokenAmount.amount) - BigInt(before?.uiTokenAmount.amount ?? "0");
    }, 0n);
  if (received !== BigInt(PRICE)) return { state: "uncertain" } as const;
  return { state: "confirmed", programs: [...new Set(parsed.data.transaction.message.instructions.map(i => i.programId))] } as const;
}
