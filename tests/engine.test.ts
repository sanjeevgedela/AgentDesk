import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST } from "../app/api/desk/route";
import { advance, currentSnapshot, latest, newDesk, PRICE, proposalSchema, recommendation, record, reserve, reserved, signal } from "../lib/engine";
import { verifyReceipt } from "../lib/payments";
import { operator, transact } from "../lib/store";

function trade(desk = newDesk()) {
  advance(desk);
  const agent = desk.agents[0];
  const snapshot = currentSnapshot(desk)!;
  const proposal = recommendation(latest(agent), signal(desk, snapshot));
  return { desk, agent, decision: record(desk, agent, snapshot, proposal, []) };
}

test("paper trade uses ask and fee, and cannot fill twice", () => {
  const { desk, agent, decision } = trade();
  assert.deepEqual(decision.fill, { price: 45, quantity: 5, fee: 1 });
  assert.equal(agent.cash, 99_774);
  assert.equal(agent.positions[decision.snapshot.symbol], 5);
  assert.throws(() => record(desk, agent, decision.snapshot, { action: "buy", reason: "Duplicate" }, []), /already ran/);
  advance(desk);
  assert.equal(record(desk, agent, currentSnapshot(desk)!, { action: "sell", reason: "Reduce exposure" }, []).fill?.price, 48);
  assert.equal(agent.cash, 100_013);
  assert.equal(agent.positions[decision.snapshot.symbol], 0);
  advance(desk);
  agent.cash = 1;
  assert.equal(record(desk, agent, currentSnapshot(desk)!, { action: "buy", reason: "No cash" }, []).fill, null);
  assert.equal(agent.cash, 1);
});

test("cap blocks, duplicate attempts return existing purchases, uncertain funds stay reserved", async () => {
  const { desk, agent, decision } = trade();
  const first = crypto.randomUUID();
  assert.equal(reserve(desk, agent, decision, first, true).purchase.status, "blocked");
  agent.cap = PRICE;
  assert.equal(reserve(desk, agent, decision, first, true).fresh, false);
  const result = reserve(desk, agent, decision, crypto.randomUUID(), true);
  result.purchase.status = "uncertain";
  assert.equal((await verifyReceipt(result.purchase)).state, "uncertain");
  assert.equal(reserved(desk, agent.id), PRICE);
  assert.equal(reserve(desk, agent, decision, crypto.randomUUID(), true).purchase.id, result.purchase.id);
});

test("concurrent budget reservations cannot overspend across distinct decisions", async () => {
  const owner = "test-" + crypto.randomUUID();
  try {
    const { id, keys } = await transact(owner, desk => {
      const { agent, decision } = trade(desk);
      advance(desk);
      const second = record(desk, agent, currentSnapshot(desk)!, { action: "hold", reason: "Test" }, []);
      agent.cap = agent.budget = PRICE;
      return { id: agent.id, keys: [decision.id, second.id] };
    });
    const results = await Promise.all(keys.map(key => transact(owner, desk =>
      reserve(desk, desk.agents.find(a => a.id === id)!, desk.decisions.find(d => d.id === key)!, crypto.randomUUID(), true))));
    assert.equal(results.filter(r => r.fresh).length, 1);
    assert.match(results.find(r => !r.fresh)!.purchase.reason, /remaining budget/);
  } finally {
    await rm(".agentdesk/" + owner + ".json", { force: true });
  }
});

test("invalid model actions and extra arguments fail validation", () => {
  assert.equal(proposalSchema.safeParse({ action: "transfer", reason: "Invalid" }).success, false);
  assert.equal(proposalSchema.safeParse({ action: "buy", reason: "Invalid", amount: 200 }).success, false);
});

test("anonymous spending, configuration confirmation and voice requests are rejected", async () => {
  assert.equal(operator("Bearer wrong"), false);
  const id = crypto.randomUUID();
  for (const body of [{ kind: "buy", id, decision: id, requestId: id }, { kind: "confirm", id }, { kind: "voice" }]) {
    const response = await POST(new NextRequest("http://localhost/api/desk", {
      method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
    }));
    assert.equal(response.status, 403);
  }
});
