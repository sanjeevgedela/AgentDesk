import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  advance, configSchema, currentSnapshot, evidenceFor, latest, newAgent, recommendation, record,
  REPLAY_SYMBOL, reserve, reserved, signal, type Agent, type Desk, type Purchase, type Snapshot,
} from "../../../lib/engine";
import { geminiSnapshots } from "../../../lib/gemini";
import { interpret } from "../../../lib/model";
import { pay, PaymentError, paymentReady, verifyReceipt } from "../../../lib/payments";
import { operator, transact } from "../../../lib/store";
import { answer } from "../../../lib/supervisor";

const uuid = z.uuid();
const amount = z.number().int().min(0).max(10_000_000);
const action = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("advance") }),
  z.object({ kind: z.literal("mode"), mode: z.enum(["replay","live"]) }),
  z.object({ kind: z.literal("select"), symbol: z.string().max(120) }),
  z.object({ kind: z.literal("save"), id: uuid.optional(), config: configSchema }),
  z.object({ kind: z.literal("run"), id: uuid }),
  z.object({ kind: z.literal("ask"), question: z.string().trim().min(1).max(600) }),
  z.object({ kind: z.literal("propose"), id: uuid, cap: amount, budget: amount }),
  z.object({ kind: z.literal("confirm"), id: uuid }),
  z.object({ kind: z.literal("buy"), id: uuid, decision: uuid, requestId: uuid }),
  z.object({ kind: z.literal("reconcile"), id: uuid }),
  z.object({ kind: z.literal("voice") }),
]);
const cookie = "agentdesk_session";
function scope(req: NextRequest) {
  const auth = operator(req.headers.get("authorization"));
  const stored = uuid.safeParse(req.cookies.get(cookie)?.value);
  const anonymous = stored.success ? stored.data : crypto.randomUUID();
  const owner = auth ? "operator" : anonymous;
  function reply(body: object, status = 200) {
    const response = NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
    if (!stored.success) response.cookies.set(cookie, anonymous, { httpOnly: true, sameSite: "strict", secure: req.nextUrl.protocol === "https:", path: "/", maxAge: 60 * 60 * 24 * 30 });
    return response;
  }
  return { auth, owner, reply };
}

function agentFor(desk: Desk, id: string): Agent {
  const agent = desk.agents.find(a => a.id === id);
  if (!agent) throw new Error("Agent not found in this workspace.");
  return agent;
}

function confirmed(purchase: Purchase, snapshot: Snapshot, programs: readonly string[], evidence = evidenceFor(snapshot)) {
  purchase.status = "confirmed";
  purchase.programs = [...programs];
  purchase.evidence = evidence.text;
  purchase.after = evidence.spread <= 5 ? (purchase.before === "hold" && snapshot.ask < 50 ? "buy" : purchase.before) : "hold";
  purchase.reason = "Devnet USDC transfer confirmed. The revised recommendation is recorded without placing a paper order.";
}

export async function GET(req: NextRequest) {
  const { auth, owner, reply } = scope(req);
  if (req.headers.has("authorization") && !auth) return reply({ error: "Operator token rejected." }, 401);
  try {
    return reply({ desk: await transact(owner, desk => desk), auth, voice: !!(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_AGENT_ID) });
  } catch { return reply({ error: "Workspace storage is unavailable. Check database setup." }, 503); }
}

export async function POST(req: NextRequest) {
  const { auth, owner, reply } = scope(req);
  if (req.headers.has("authorization") && !auth) return reply({ error: "Operator token rejected." }, 401);
  if (!req.headers.get("content-type")?.startsWith("application/json")) return reply({ error: "Use application/json." }, 415);
  const parsed = action.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return reply({ error: "Check the requested action and input values." }, 400);
  const input = parsed.data;
  if (["confirm", "buy", "reconcile", "voice"].includes(input.kind) && !auth)
    return reply({ error: "Unlock the operator workspace to perform this action." }, 403);

  try {
    if (input.kind === "voice") {
      const key = process.env.ELEVENLABS_API_KEY;
      const id = process.env.ELEVENLABS_AGENT_ID;
      if (!key || !id) throw new Error("Configure the private ElevenLabs agent and API key.");
      const voice = await fetch("https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=" + encodeURIComponent(id),
        { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(7000) });
      if (!voice.ok) throw new Error("ElevenLabs rejected the session request.");
      const { signed_url } = z.object({ signed_url: z.string().startsWith("wss://") }).parse(await voice.json());
      return reply({ signedUrl: signed_url });
    }
    if (input.kind === "buy") {
      const work = await transact(owner, desk => {
        const agent = agentFor(desk, input.id);
        const decision = desk.decisions.find(d => d.id === input.decision && d.agent === agent.id);
        if (!decision?.resource) throw new Error("Choose a decision with an approved research request.");
        return { ...reserve(desk, agent, decision, input.requestId, paymentReady()), snapshot: decision.snapshot };
      });
      if (work.fresh) {
        try {
          const result = await pay(work.snapshot, receipt => transact(owner, desk => {
            const purchase = desk.purchases.find(p => p.id === work.purchase.id)!;
            Object.assign(purchase, receipt);
          }));
          await transact(owner, desk => {
            confirmed(desk.purchases.find(p => p.id === work.purchase.id)!, work.snapshot, result.programs, result.evidence);
          });
        } catch (err) {
          await transact(owner, desk => {
            const purchase = desk.purchases.find(p => p.id === work.purchase.id)!;
            if (purchase.status === "pending") {
              const unsent = err instanceof PaymentError && !err.submitted;
              purchase.status = unsent ? "failed" : "uncertain";
              purchase.reason = unsent ? "Payment failed before submission. Check wallet configuration and devnet connectivity." :
                "Settlement could not be established. The reservation stays held pending reconciliation.";
            }
          });
        }
      }
      return reply({ desk: await transact(owner, desk => desk) });
    }
    if (input.kind === "reconcile") {
      const purchase = await transact(owner, desk => desk.purchases.find(p => p.id === input.id));
      if (!purchase || !["pending", "uncertain"].includes(purchase.status)) throw new Error("No unresolved purchase with that ID.");
      const result = await verifyReceipt(purchase);
      return reply({ desk: await transact(owner, desk => {
        const saved = desk.purchases.find(p => p.id === input.id)!;
        if (!["pending","uncertain"].includes(saved.status)) return desk;
        if (result.state === "confirmed") confirmed(saved, desk.decisions.find(d => d.id === saved.decision)!.snapshot, result.programs);
        else if (result.state === "failed") { saved.status = "failed"; saved.reason = "Devnet recorded a failed transaction. Budget released."; }
        else { saved.reason = "No conclusive devnet receipt. Budget remains reserved and duplicate payment stays blocked."; }
        return desk;
      }) });
    }
    const live = input.kind === "mode" && input.mode === "live" ? await geminiSnapshots() : null;
    if (input.kind === "run") {
      const original = await transact(owner, desk => {
        const agent = agentFor(desk, input.id);
        const snapshot = currentSnapshot(desk);
        if (!snapshot) throw new Error("Choose a market with a saved snapshot.");
        const version = latest(agent);
        if (!version.active || !version.markets.includes(snapshot.symbol)) throw new Error("Activate this agent and allow the selected market in its settings.");
        return { snapshot, version, baseline: recommendation(version, signal(desk, snapshot)) };
      });
      let proposal;
      try { proposal = auth ? await interpret(original.version, original.snapshot, original.baseline) : original.baseline; }
      catch { throw new Error("Model output could not be validated. No paper trade was placed."); }
      return reply({ desk: await transact(owner, desk => {
        const agent = agentFor(desk, input.id);
        if (latest(agent).number !== original.version.number || currentSnapshot(desk)?.id !== original.snapshot.id)
          throw new Error("The strategy or market changed during this run. Try again.");
        record(desk, agent, original.snapshot, proposal, [
          { name: "market_snapshot", result: original.snapshot.source },
          { name: auth && process.env.OPENAI_API_KEY ? "model_interpretation" : "strategy_rule", result: proposal.reason },
        ]);
        return desk;
      }) });
    }
    return reply(await transact(owner, desk => {
      switch (input.kind) {
        case "advance":
          if (desk.mode !== "replay") throw new Error("Switch to replay before advancing.");
          advance(desk);
          break;
        case "mode":
          desk.mode = input.mode;
          if (live) {
            desk.snapshots.push(...live);
            if (!live.some(s => s.symbol === desk.selected)) desk.selected = live[0].symbol;
          } else desk.selected = REPLAY_SYMBOL;
          break;
        case "select":
          if (!desk.snapshots.some(s => s.symbol === input.symbol && s.mode === desk.mode)) throw new Error("Market is unavailable.");
          desk.selected = input.symbol;
          break;
        case "save":
          if (!input.id) {
            if (desk.agents.length >= 12) throw new Error("A workspace can have up to 12 agents.");
            desk.agents.push(newAgent(input.config));
          } else {
            const agent = agentFor(desk, input.id);
            agent.versions.push({ ...input.config, number: latest(agent).number + 1, at: new Date().toISOString() });
          }
          break;
        case "ask": return { answer: answer(desk, input.question) };
        case "propose": {
          agentFor(desk, input.id);
          if (input.cap > input.budget) throw new Error("Cap cannot exceed the total budget.");
          desk.changes = desk.changes.filter(c => c.expires > Date.now() && c.agent !== input.id);
          const proposal = { id: crypto.randomUUID(), agent: input.id, cap: input.cap, budget: input.budget, expires: Date.now() + 600_000 };
          desk.changes.push(proposal);
          break;
        }
        case "confirm": {
          const change = desk.changes.find(c => c.id === input.id && c.expires > Date.now());
          if (!change) throw new Error("Budget proposal expired. Create a new proposal.");
          if (change.budget < reserved(desk, change.agent)) throw new Error("Budget cannot be below reserved or confirmed spending.");
          Object.assign(agentFor(desk, change.agent), { cap: change.cap, budget: change.budget });
          desk.changes = desk.changes.filter(c => c.id !== change.id);
          break;
        }
      }
      return { desk };
    }));
  } catch (err) {
    return reply({ error: err instanceof Error && err.name === "Error" ? err.message.slice(0, 300) : "Request failed. Check configuration and retry." }, 400);
  }
}
