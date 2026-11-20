import { anchorDecision, verifyAnchor } from "../lib/anchor";
import { currentSnapshot, newDesk, record } from "../lib/engine";
import { parseInstructions } from "../lib/policy";

const desk = newDesk();
const decision = record(desk, desk.agents[0], currentSnapshot(desk)!, { action: "hold", reason: "SYNTHETIC devnet memo verification probe" }, []);
const { signature } = await anchorDecision(decision, parseInstructions(""));
for (let i = 0; i < 8; i++) {
  const result = await verifyAnchor(decision, signature, (await import("../lib/canonical")).sha256(parseInstructions("")));
  if (result.state === "confirmed") {
    console.log(`https://explorer.solana.com/tx/${signature}?cluster=devnet`);
    process.exit(0);
  }
  if (result.state !== "uncertain") break;
  await new Promise(resolve => setTimeout(resolve, 1500));
}
throw new Error("Devnet memo confirmation could not be verified.");
