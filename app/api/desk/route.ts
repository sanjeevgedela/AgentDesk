import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  advance, configSchema, currentSnapshot, evidenceFor, latest, newAgent, recommendation, record,
  REPLAY_SYMBOL, reserve, reserved, signal, type Agent, type Desk, type Purchase, type Snapshot, type Proposal,
} from "../../../lib/engine";
import { geminiSnapshots } from "../../../lib/gemini";
import { parseInstructions } from "../../../lib/policy";
import { evaluateInstructions } from "../../../lib/instructions";
import { interpret } from "../../../lib/model";
import { pay, PaymentError, paymentReady, verifyReceipt } from "../../../lib/payments";
import { operator, transact } from "../../../lib/store";
import { answer } from "../../../lib/supervisor";

const uuid = z.uuid();
const amount = z.number().int().min(0).max(10_000_000);
const action = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("advance") }),
  z.object({ kind: z.literal("demo-run") }),
  z.object({ kind: z.literal("mode"), mode: z.enum(["replay","live"]) }),
  z.object({ kind: z.literal("select"), symbol: z.string().max(120) }),
  z.object({ kind: z.literal("save"), id: uuid.optional(), config: configSchema }),
  z.object({ kind: z.literal("run"), id: uuid }),
  z.object({ kind: z.literal("ask"), question: z.string().trim().min(1).max(600) }),
  z.object({ kind: z.literal("propose"), id: uuid, cap: amount, budget: amount }),
  z.object({ kind: z.literal("confirm"), id: uuid }),
  z.object({ kind: z.literal("buy"), id: uuid, decision: uuid, requestId: uuid }),
  z.object({ kind: z.literal("reconcile"), id: uuid }),
  z.object({ kind: z.literal("apply-review"), id: uuid }),
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

function completeReview(desk: Desk, purchase: Purchase, snapshot: Snapshot, programs: readonly string[], evidence = evidenceFor(snapshot), simulated = false) {
  purchase.status = simulated ? "simulated" : "confirmed";
  if (!simulated) purchase.programs = [...programs];
  purchase.evidence = evidence.text;
  const decision = desk.decisions.find(d => d.id === purchase.decision);
  const version = agentFor(desk, purchase.agent).versions.find(v => v.number === decision?.version);
  const rules = version && evaluateInstructions(version.instructions, snapshot);
  purchase.after = evidence.spread > 5 || !rules || rules.notes.length ? "hold"
    : rules.matched?.action ?? (purchase.before === "hold" && snapshot.ask < 50 ? "buy" : purchase.before);
  purchase.reason = simulated ? "Demo purchase complete. Sample research is ready." : "Devnet USDC transfer confirmed. Research is ready.";
}

function evaluateRun(version: ReturnType<typeof latest>, snapshot: Snapshot, change: number | null) {
  const { matched, notes } = evaluateInstructions(version.instructions, snapshot);
  const unknown = parseInstructions(notes.join("\n")).unrecognized;
  const baseline = recommendation(version, change);
  return {
    matched, notes: unknown, baseline,
    proposal: matched ?? (unknown.length
      ? { action: "hold" as const, reason: "Some instructions require an enabled model. The run recorded a hold." }
      : baseline),
    source: matched ? "saved_instruction" : unknown.length ? "instructions_require_model" : "strategy_rule",
  };
}

function recordRun(desk: Desk, agent: Agent, snapshot: Snapshot, proposal: Proposal, source: string) {
  return record(desk, agent, snapshot, proposal, [
    { name: "market_snapshot", result: snapshot.source },
    { name: source, result: proposal.reason },
  ]);
}

export async function GET(req: NextRequest) {
  const { auth, owner, reply } = scope(req);
  if (req.headers.has("authorization") && !auth) return reply({ error: "Operator token rejected." }, 401);
  try {
    return reply({ desk: await transact(owner, desk => desk), auth, operatorAccess: process.env.AGENTDESK_SHOW_OPERATOR_ACCESS === "true", model: auth && !!process.env.OPENAI_API_KEY, voice: !!(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_AGENT_ID) });
  } catch { return reply({ error: "Workspace storage is unavailable. Check database setup." }, 503); }
}

export async function POST(req: NextRequest) {
  const { auth, owner, reply } = scope(req);
  if (req.headers.has("authorization") && !auth) return reply({ error: "Operator token rejected." }, 401);
  if (!req.headers.get("content-type")?.startsWith("application/json")) return reply({ error: "Use application/json." }, 415);
  const parsed = action.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return reply({ error: "Check the requested action and input values." }, 400);
  const input = parsed.data;
  if (["reconcile", "voice", "propose", "confirm"].includes(input.kind) && !auth)
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
        const result = reserve(desk, agent, decision, input.requestId, !auth || paymentReady(), !auth);
        if (!auth && result.fresh) completeReview(desk, result.purchase, decision.snapshot, [], evidenceFor(decision.snapshot), true);
        return { ...result, snapshot: decision.snapshot };
      });
      if (auth && work.fresh) {
        try {
          const result = await pay(work.snapshot, receipt => transact(owner, desk => {
            const purchase = desk.purchases.find(p => p.id === work.purchase.id)!;
            Object.assign(purchase, receipt);
          }));
          await transact(owner, desk => {
            completeReview(desk, desk.purchases.find(p => p.id === work.purchase.id)!, work.snapshot, result.programs, result.evidence);
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
    if (input.kind === "apply-review") {
      return reply(await transact(owner, desk => {
        const purchase = desk.purchases.find(p => p.id === input.id && p.status === (auth ? "confirmed" : "simulated"));
        if (!purchase?.after || purchase.after === "hold") throw new Error("There is no completed review with a trade recommendation.");
        const existing = desk.decisions.find(d => d.researchPurchase === purchase.id);
        if (existing) return { desk, decision: existing, reused: true };
        const original = desk.decisions.find(d => d.id === purchase.decision);
        const snapshot = currentSnapshot(desk);
        const agent = agentFor(desk, purchase.agent);
        if (!original || !snapshot || snapshot.id !== original.snapshot.id || latest(agent).number !== original.version)
          throw new Error("The review applies to its original quote and strategy version. Run the agent on the current quote.");
        const decision = record(desk, agent, snapshot, {
          action: purchase.after, reason: auth ? "Operator applied the confirmed quote review recommendation." : "Applied the simulated quote review recommendation.",
        }, [{ name: auth ? "confirmed_research" : "simulated_research", result: purchase.id }], purchase.id);
        return { desk, decision, reused: false };
      }));
    }
    if (input.kind === "reconcile") {
      const purchase = await transact(owner, desk => desk.purchases.find(p => p.id === input.id));
      if (!purchase || !["pending", "uncertain"].includes(purchase.status)) throw new Error("No unresolved purchase with that ID.");
      const result = await verifyReceipt(purchase);
      return reply({ desk: await transact(owner, desk => {
        const saved = desk.purchases.find(p => p.id === input.id)!;
        if (!["pending","uncertain"].includes(saved.status)) return desk;
        if (result.state === "confirmed") completeReview(desk, saved, desk.decisions.find(d => d.id === saved.decision)!.snapshot, result.programs);
        else if (result.state === "failed") { saved.status = "failed"; saved.reason = "Devnet recorded a failed transaction. Budget released."; }
        else { saved.reason = "No conclusive devnet receipt. Budget remains reserved and duplicate payment stays blocked."; }
        return desk;
      }) });
    }
    if (input.kind === "demo-run") {
      if (auth) return reply({ error: "The guided replay is available in the demo workspace." }, 400);
      return reply(await transact(owner, desk => {
        if (desk.mode !== "replay") throw new Error("Open replay to run the guided demo.");
        if (desk.replay === 0) advance(desk);
        const snapshot = currentSnapshot(desk);
        if (!snapshot) throw new Error("Replay quote unavailable.");
        const agents = desk.agents.filter(a => latest(a).active && latest(a).markets.includes(snapshot.symbol));
        if (!agents.length) throw new Error("Enable an agent for this replay market first.");
        const change = signal(desk, snapshot);
        for (const agent of agents) {
          const version = latest(agent);
          if (desk.decisions.some(d => d.agent === agent.id && d.snapshot.id === snapshot.id && d.version === version.number && !d.researchPurchase)) continue;
          const { proposal, source } = evaluateRun(version, snapshot, change);
          recordRun(desk, agent, snapshot, proposal, source);
        }
        return { desk };
      }));
    }
    const live = input.kind === "mode" && input.mode === "live" ? await geminiSnapshots() : null;
    if (input.kind === "run") {
      const original = await transact(owner, desk => {
        const agent = agentFor(desk, input.id);
        const snapshot = currentSnapshot(desk);
        if (!snapshot) throw new Error("Choose a market with a saved snapshot.");
        const version = latest(agent);
        if (!version.active) throw new Error("This agent is paused. Activate it in Edit.");
        if (!version.markets.includes(snapshot.symbol))
          throw new Error(`Allow ${snapshot.symbol} in this agent’s settings before running it.`);
        const existing = desk.decisions.find(d => d.agent === agent.id && d.snapshot.id === snapshot.id && d.version === version.number && !d.researchPurchase);
        const change = signal(desk, snapshot);
        return { snapshot, version, change, existing, desk };
      });
      if (original.existing) return reply({ desk: original.desk, decision: original.existing, reused: true });

      const { matched, notes, baseline, proposal: defaultProposal, source: defaultSource } = evaluateRun(original.version, original.snapshot, original.change);
      let proposal = defaultProposal;
      let source = defaultSource;
      if (!matched && auth && process.env.OPENAI_API_KEY) {
        try {
          proposal = await interpret({ ...original.version, instructions: notes.join("\n") }, original.snapshot, baseline, original.change);
          source = "model_interpretation";
        } catch {
          proposal = { action: "hold", reason: "The model did not return a valid response. The run recorded a hold." };
          source = "model_unavailable";
        }
      }

      return reply(await transact(owner, desk => {
        const agent = agentFor(desk, input.id);
        if (latest(agent).number !== original.version.number || currentSnapshot(desk)?.id !== original.snapshot.id)
          throw new Error("The strategy or market changed during this run. Try again.");
        const existing = desk.decisions.find(d => d.agent === agent.id && d.snapshot.id === original.snapshot.id && d.version === original.version.number && !d.researchPurchase);
        if (existing) return { desk, decision: existing, reused: true };
        const decision = recordRun(desk, agent, original.snapshot, proposal, source);
        return { desk, decision, reused: false };
      }));
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
