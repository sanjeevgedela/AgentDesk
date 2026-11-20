import { proposalSchema, type Config, type Proposal, type Snapshot } from "./engine";

export async function interpret(config: Config, snapshot: Snapshot, baseline: Proposal, change: number | null) {
  if (!process.env.OPENAI_API_KEY) return baseline;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", signal: AbortSignal.timeout(12000),
    headers: { authorization: "Bearer " + process.env.OPENAI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      response_format: { type: "json_object" }, max_completion_tokens: 220,
      messages: [
        { role: "system", content: 'Propose buy, sell or hold for a paper portfolio. Return a JSON object with action and concise reason. Include the optional resource field only to accept the approved resource in the baseline. Use the saved instructions to choose buy, sell, or hold. The baseline is context. If an approved review is requested, choose hold and preserve the resource. Use only the provided quote and midpoint change.' },
        { role: "user", content: JSON.stringify({ config, snapshot, baseline, change }) },
      ],
    }),
  });
  if (!res.ok) throw new Error("The configured model rejected this run.");
  const json = await res.json();
  const parsed = proposalSchema.parse(JSON.parse(json.choices[0].message.content));
  if (parsed.resource && parsed.resource !== baseline.resource) throw new Error("Model requested a resource outside the baseline.");
  if (!config.instructions && parsed.action !== baseline.action && parsed.action !== "hold") return baseline;
  return baseline.resource ? { ...baseline, reason: parsed.action === "hold" ? parsed.reason : baseline.reason } : parsed;
}
