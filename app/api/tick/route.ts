import { after } from "next/server";
import { processAnchors } from "../../../lib/anchor-queue";
import { followedQuotes, runAutopilot } from "../../../lib/autopilot";
import { NextRequest, NextResponse } from "next/server";
import { resolve } from "../../../lib/engine";
import { geminiSnapshots, geminiResolutions } from "../../../lib/gemini";
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
    const followed = await transact("operator", desk => followedQuotes(desk, true));
    const [quotes, resolutions] = await Promise.all([geminiSnapshots(undefined, followed), geminiResolutions().catch(() => null)]);
    const inserted = await appendQuotes(quotes);
    const settled = resolutions ? await transact("operator", desk => {
      const held = new Set(desk.agents.flatMap(agent => Object.keys(agent.positions).filter(symbol => agent.positions[symbol] > 0)));
      const matches = resolutions.filter(entry => held.has(entry.instrumentSymbol) && !desk.settlements?.some(saved => saved.symbol === entry.instrumentSymbol));
      for (const entry of matches) resolve(desk, entry.instrumentSymbol, entry.resolutionSide, entry.resolvedAt, "Gemini Prediction Markets");
      return matches.length;
    }) : null;
    const runs = await runAutopilot(quotes);
    after(async () => { await processAnchors(); });
    return NextResponse.json({ fetched: quotes.length, inserted, runs, settled });
  } catch {
    return NextResponse.json({ error: "Quote collection unavailable." }, { status: 502 });
  }
}
export const POST = GET;
