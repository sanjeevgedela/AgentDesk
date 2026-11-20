import assert from "node:assert/strict";
import test from "node:test";
import { MEMO, memoPayload, verifyAnchor } from "../lib/anchor";
import { canonicalJSON, sha256 } from "../lib/canonical";
import { currentSnapshot, newDesk, record } from "../lib/engine";
import { parseInstructions } from "../lib/policy";

test("canonical anchor is compact, stable, and detects tampering", async t => {
  assert.equal(canonicalJSON({ b: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"b":1}');
  const desk = newDesk();
  const decision = record(desk, desk.agents[0], currentSnapshot(desk)!, { action: "hold", reason: "Audit test" }, []);
  const policyHash = sha256(parseInstructions(""));
  const memo = canonicalJSON(memoPayload(decision, policyHash));
  assert.ok(Buffer.byteLength(memo) < 400);
  t.mock.method(globalThis, "fetch", async () => Response.json({ result: {
    slot: 100, meta: { err: null }, transaction: { message: { instructions: [{ programId: MEMO, parsed: memo }] } },
  } }));
  const signature = "2".repeat(88);
  assert.equal((await verifyAnchor(decision, signature, policyHash)).state, "confirmed");
  assert.equal((await verifyAnchor({ ...decision, reason: "Tampered" }, signature, policyHash)).state, "mismatch");
});
