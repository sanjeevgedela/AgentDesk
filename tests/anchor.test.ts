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

test("failed simulation never submits a Solana memo and retry eligibility is bounded", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { anchorDecision, AnchorSimulationError } = await import("../lib/anchor");
  const { canAttemptAnchor } = await import("../lib/anchor-queue");
  const key = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const original = process.env.SOLANA_AGENT_KEYPAIR;
  process.env.SOLANA_AGENT_KEYPAIR = JSON.stringify([...Buffer.concat([
    Buffer.from(key.d!, "base64url"), Buffer.from(key.x!, "base64url"),
  ])]);
  const desk = newDesk();
  const decision = record(desk, desk.agents[0], currentSnapshot(desk)!, { action: "hold", reason: "Memo simulation test" }, []);
  let sent = false;
  const rpc = {
    getLatestBlockhash: () => ({ send: async () => ({ value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100n } }) }),
    simulateTransaction: () => ({ send: async () => ({ value: { err: "InsufficientFunds" } }) }),
    sendTransaction: () => { sent = true; throw new Error("must never send"); },
  } as unknown as NonNullable<Parameters<typeof anchorDecision>[3]>;
  try {
    await assert.rejects(() => anchorDecision(decision, parseInstructions(""), async () => {
      assert.fail("A failed simulation must not yield a signature");
    }, rpc), AnchorSimulationError);
    assert.equal(sent, false);
    const anchor = { status: "pending" as const, attempts: 4, updated: 1000, policyHash: sha256({}) };
    assert.equal(canAttemptAnchor(anchor, 60_999), false);
    assert.equal(canAttemptAnchor(anchor, 61_000), true);
    assert.equal(canAttemptAnchor({ ...anchor, attempts: 5 }, 120_000), false);
  } finally {
    if (original === undefined) delete process.env.SOLANA_AGENT_KEYPAIR;
    else process.env.SOLANA_AGENT_KEYPAIR = original;
  }
});
