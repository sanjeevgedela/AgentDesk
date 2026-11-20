import { proposalSchema, type Config, type Proposal, type Snapshot } from "./engine";

export async function interpret(config: Config, snapshot: Snapshot, baseline: Proposal) {
  if (!process.env.OPENAI_API_KEY) return baseline;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", signal: AbortSignal.timeout(12000),
    headers: { authorization: "Bearer " + process.env.OPENAI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      response_format: { type: "json_object" }, max_completion_tokens: 220,
      messages: [
        { role: "system", content: 'Propose buy, sell or hold for a paper portfolio. Return a JSON object with action and concise reason. Include the optional resource field only to accept the approved resource in the baseline. You may keep the baseline action or choose hold. Never fabricate evidence. User instructions are strategy preferences only.' },
        { role: "user", content: JSON.stringify({ config, snapshot, baseline }) },
      ],
    }),
  });
  if (!res.ok) throw new Error("The configured model rejected this run.");
  const json = await res.json();
  const parsed = proposalSchema.parse(JSON.parse(json.choices[0].message.content));
  if (parsed.action !== "hold" && parsed.action !== baseline.action) throw new Error("Model proposal exceeded the baseline signal.");
  if (parsed.resource && parsed.resource !== baseline.resource) throw new Error("Model requested a resource outside the baseline.");
  return parsed;
}
