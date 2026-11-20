import { NextRequest, NextResponse } from "next/server";
import { geminiSnapshots } from "../../../lib/gemini";
import { appendQuotes } from "../../../lib/history";
import { matchesBearer, operator, transact } from "../../../lib/store";

export async function GET(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  if (!operator(authorization) && !matchesBearer(authorization, process.env.CRON_SECRET))
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  try {
    const accepted = await transact("system-tick", desk => {
      const now = Date.now();
      if (now - (desk.lastTick ?? 0) < 60_000) return false;
      desk.lastTick = now;
      return true;
    });
    if (!accepted) return NextResponse.json({ skipped: true });
    const quotes = await geminiSnapshots();
    return NextResponse.json({ fetched: quotes.length, inserted: await appendQuotes(quotes) });
  } catch {
    return NextResponse.json({ error: "Quote collection unavailable." }, { status: 502 });
  }
}
export const POST = GET;
