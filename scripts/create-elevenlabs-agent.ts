// Creates the private AgentDesk Supervisor agent in ElevenLabs with the two client tools the dashboard handles.
// Usage: npx tsx --env-file=.env.local scripts/create-elevenlabs-agent.ts
// Prints the new agent id; put it in ELEVENLABS_AGENT_ID. The API key needs Conversational AI write access.
const key = process.env.ELEVENLABS_API_KEY;
if (!key) { console.error("Set ELEVENLABS_API_KEY first."); process.exit(1); }

const instructions = `You are the AgentDesk Supervisor, a voice assistant for a paper-trading dashboard of prediction-market agents.
Always call desk_query before stating any fact about agents, decisions, positions, training or research spending, and cite the decision or purchase ids it returns.
If desk_query returns no records, say so; never guess. All trading is simulated paper trading.
To change research spending, ask for both the per-purchase and total USDC limits, then call propose_budget. It only creates a draft: tell the operator they must confirm it in the Research panel.
Keep answers short and spoken-friendly.`;

const body = {
  name: "AgentDesk Supervisor",
  conversation_config: {
    agent: {
      first_message: "AgentDesk supervisor here. What would you like to know about your agents?",
      language: "en",
      prompt: {
        prompt: instructions,
        tools: [
          { type: "client", name: "desk_query", expects_response: true, response_timeout_secs: 20,
            description: "Read saved AgentDesk decisions, agent status, comparisons, exposure, training and spending for the current workspace.",
            parameters: { type: "object", required: ["question"], properties: { question: { type: "string", description: "The user's question, optionally naming an agent such as Trend Scout." } } } },
          { type: "client", name: "propose_budget", expects_response: true, response_timeout_secs: 20,
            description: "Draft a research budget change for one agent. The operator must confirm it in the dashboard.",
            parameters: { type: "object", required: ["agent_name", "per_purchase_usdc", "total_usdc"], properties: {
              agent_name: { type: "string", description: "Exact agent name." },
              per_purchase_usdc: { type: "number", description: "Maximum USDC per purchase." },
              total_usdc: { type: "number", description: "Total USDC budget." } } } },
        ],
      },
    },
  },
  platform_settings: { auth: { enable_auth: true } },
};

const response = await fetch("https://api.elevenlabs.io/v1/convai/agents/create", {
  method: "POST", headers: { "xi-api-key": key, "content-type": "application/json" }, body: JSON.stringify(body),
});
const text = await response.text();
if (!response.ok) { console.error(`ElevenLabs returned ${response.status}: ${text}`); process.exit(1); }
console.log("Created agent. Set ELEVENLABS_AGENT_ID=" + (JSON.parse(text) as { agent_id: string }).agent_id);

export {};
