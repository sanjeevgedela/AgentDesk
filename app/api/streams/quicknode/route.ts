import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyAnchor } from "../../../../lib/anchor";
import { matchesBearer, transact } from "../../../../lib/store";

const delivery = z.object({ signatures: z.array(z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/)).max(500) });

export async function POST(request: NextRequest) {
  if (!process.env.QUICKNODE_STREAM_TOKEN)
    return NextResponse.json({ error: "Stream delivery is disabled." }, { status: 503 });
  if (!matchesBearer(request.headers.get("authorization"), process.env.QUICKNODE_STREAM_TOKEN))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.text();
  if (body.length > 50_000) return NextResponse.json({ error: "Batch too large." }, { status: 413 });
  const raw: unknown = await new Response(body).json().catch(() => null);
  const batch = delivery.safeParse(raw && typeof raw === "object" && "data" in raw ? raw.data : raw);
  if (!batch.success) return NextResponse.json({ error: "Send an array of Solana signatures." }, { status: 400 });
  const signatures = new Set(batch.data.signatures);
  const pending = await transact("operator", desk => desk.decisions.filter(d =>
    d.anchor?.status === "pending" && d.anchor.signature && signatures.has(d.anchor.signature)).slice(0, 20));

  let verified = 0;
  for (const decision of pending) {
    const signature = decision.anchor!.signature!;
    // The stream only wakes verification. The RPC independently checks the memo.
    const proof = await verifyAnchor(decision, signature).catch(() => null);
    if (!proof || proof.state === "uncertain") continue;
    verified += await transact("operator", desk => {
      const anchor = desk.decisions.find(d => d.id === decision.id)?.anchor;
      if (!anchor || anchor.signature !== signature || anchor.status !== "pending") return 0;
      anchor.status = proof.state;
      if ("slot" in proof) anchor.slot = proof.slot;
      return 1;
    });
  }
  return NextResponse.json({ matched: pending.length, verified });
}
