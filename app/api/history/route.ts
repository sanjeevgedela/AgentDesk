import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { backfill } from "../../../lib/backfill";
import { loadBars, quoteSymbol } from "../../../lib/history";

const query = z.object({ symbol: quoteSymbol, limit: z.coerce.number().int().min(1).max(5000).default(250) });
export async function GET(request: NextRequest) {
  const search = request.nextUrl.searchParams;
  const parsed = query.safeParse({ symbol: search.get("symbol"), limit: search.get("limit") ?? undefined });
  if (!parsed.success) return NextResponse.json({ error: "Provide a valid symbol and observation limit." }, { status: 400 });
  try {
    const { symbol, limit } = parsed.data;
    const recorded = await loadBars(symbol, { limit });
    const source = recorded.source?.match(/^https:\/\/api\.gemini\.com\/v1\/prediction-markets\/events\/([\w-]{1,120})$/);
    return NextResponse.json({ ...recorded, backfill: source ? await backfill(symbol, source[1]) : undefined });
  } catch {
    return NextResponse.json({ error: "Quote history unavailable." }, { status: 503 });
  }
}
