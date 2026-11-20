import assert from "node:assert/strict";
import test from "node:test";
import { advance, currentSnapshot, latest, newDesk, recommendation, record, reserve, signal } from "../lib/engine";
import { applyReview, completeReview, evidenceFor } from "../lib/research";

test("historical evidence is causal and differs when prior quotes change", () => {
  const desk = newDesk();
  advance(desk);
  const quote = currentSnapshot(desk)!;
  const baseline = evidenceFor(quote, desk.snapshots);
  advance(desk);
  assert.deepEqual(evidenceFor(quote, desk.snapshots), baseline);
  assert.notEqual(evidenceFor(quote, [{ ...desk.snapshots[0], bid: 50, ask: 52 }]).volatility, baseline.volatility);
});
test("confirmed research creates exactly one policy-blocked follow-up", () => {
  const desk = newDesk();
  const agent = desk.agents[2];
  latest(agent).instructions = "max buy price: 40";
  advance(desk);
  const snapshot = currentSnapshot(desk)!;
  const original = record(desk, agent, snapshot, recommendation(latest(agent), signal(desk, snapshot)), []);
  const { purchase } = reserve(desk, agent, original, crypto.randomUUID(), true, true);
  completeReview(desk, purchase, snapshot, evidenceFor(snapshot, desk.snapshots), false, []);
  const followUp = desk.decisions.find(d => d.followUpOf === original.id)!;
  assert.equal(followUp.fill, null);
  assert.equal(followUp.validation?.at(-1)?.name, "policy");
  assert.equal(applyReview(desk, purchase)?.decision.id, followUp.id);
  assert.equal(desk.decisions.length, 2);
});
