// Creates (or, if ELEVENLABS_AGENT_ID is set, updates) the AgentDesk Supervisor agent in ElevenLabs
// with the client tools the dashboard implements. Usage:
//   npx tsx --env-file=.env scripts/create-elevenlabs-agent.ts
// The API key needs ElevenAgents write access. Prints the agent id for ELEVENLABS_AGENT_ID.
const key = process.env.ELEVENLABS_API_KEY;
if (!key) { console.error("Set ELEVENLABS_API_KEY first."); process.exit(1); }

type Prop = { type: "string" | "number" | "boolean"; description: string };
const tool = (name: string, description: string, properties: Record<string, Prop> = {}, required: string[] = []) => ({
  type: "client", name, description, expects_response: true, response_timeout_secs: 30,
  parameters: { type: "object", required, properties },
});
const str = (description: string): Prop => ({ type: "string", description });
const num = (description: string): Prop => ({ type: "number", description });
const AGENT = str("Agent name, for example Trend Scout, Mean Reverter or Evidence Analyst.");

const tools = [
  tool("describe_screen", "Describe the current mode, selected market, replay step, agents and counts."),
  tool("navigate", "Scroll to a section of the site.", { section: str("overview, agents, training, decisions, research or supervisor") }, ["section"]),
  tool("set_mode", "Switch between synthetic replay and live Gemini markets.", { mode: str("replay or live") }, ["mode"]),
  tool("advance_replay", "Advance the replay to the next price snapshot."),
  tool("refresh_quotes", "Fetch fresh live Gemini quotes."),
  tool("select_market", "Select a live market by symbol or title words.", { market: str("Symbol or part of the market title.") }, ["market"]),
  tool("run_agents", "Run one agent, or all active agents, on the current quote and report each decision.", { agent_name: str("An agent name, or all.") }),
  tool("guided_demo", "Perform the next step of the guided replay demo."),
  tool("create_agent", "Create a new paper-trading agent on the selected market.", {
    name: str("Agent name."), strategy: str("Momentum, Contrarian or Evidence-driven."), instructions: str("Optional plain-language rules, one per line."),
    threshold: num("Move in cents that triggers a trade, 1 to 40."), position_limit: num("Maximum contracts to hold."),
  }, ["name"]),
  tool("update_agent", "Change an agent's settings, pause or resume it, or allow another market.", {
    agent_name: AGENT, new_name: str("New name."), strategy: str("Momentum, Contrarian or Evidence-driven."), instructions: str("Replacement rules."),
    threshold: num("Threshold in cents."), position_limit: num("Position limit."), stop_loss_pct: num("Stop-loss percent, 1 to 99. 0 turns it off."),
    active: { type: "boolean", description: "false pauses the agent, true resumes it." }, auto: { type: "boolean", description: "Whether it runs automatically on fresh live quotes." },
    add_market: str("Market symbol to add to the allowed markets."),
  }, ["agent_name"]),
  tool("request_quote_review", "Buy a quote quality review for an Evidence-driven agent's latest decision with simulated test USDC.", { agent_name: AGENT }, ["agent_name"]),
  tool("apply_review", "Apply the agent's quote review recommendation as a paper order.", { agent_name: AGENT }, ["agent_name"]),
  tool("train_agent", "Train the agent's strategy parameters on the selected market's data.", { agent_name: AGENT }, ["agent_name"]),
  tool("fit_model", "Fit a forecast model for the agent.", { agent_name: AGENT, horizon: num("Prediction horizon in observations, 1 to 10."), ridge: num("Ridge regularization.") }, ["agent_name"]),
  tool("activate_model", "Activate the agent's latest fitted forecast model.", { agent_name: AGENT }, ["agent_name"]),
  tool("propose_budget", "Set an agent's research spending limits. Takes effect immediately.", {
    agent_name: AGENT, per_purchase_usdc: num("Maximum USDC per purchase."), total_usdc: num("Total USDC budget."),
  }, ["agent_name", "per_purchase_usdc", "total_usdc"]),
  tool("ask_training", "Answer a question about an agent's saved training or fitted model.", { agent_name: AGENT, question: str("The question.") }, ["agent_name", "question"]),
  tool("desk_query", "Read saved decisions, agent status, comparisons, exposure, training and spending.", { question: str("The user's question.") }, ["question"]),
];

const instructions = `You are the AgentDesk Supervisor: a voice assistant that can operate the whole AgentDesk site on the user's behalf. All trading is simulated paper trading and all payments are simulated test USDC.
When the user asks you to do something on the site, call the matching tool and then say briefly what happened, using the tool's result. You can switch modes, advance the replay, refresh and select markets, run agents, create or edit agents, pause or resume them, request and apply quote reviews, train and fit models, set research budgets and scroll to any section.
Always call desk_query (or ask_training) before stating facts about agents, decisions, positions, training or spending, and never guess. If a tool reports an error, explain it plainly and suggest the fix.
Do not ask for confirmation before acting unless a request is ambiguous. Keep replies short and spoken-friendly.`;

const config = {
  conversation_config: { agent: {
    first_message: "AgentDesk supervisor here. Tell me what you'd like to do or ask.", language: "en",
    prompt: { prompt: instructions, tools },
  } },
  platform_settings: { auth: { enable_auth: true } },
};

const id = process.env.ELEVENLABS_AGENT_ID;
const response = await fetch(id ? `https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(id)}` : "https://api.elevenlabs.io/v1/convai/agents/create", {
  method: id ? "PATCH" : "POST", headers: { "xi-api-key": key, "content-type": "application/json" },
  body: JSON.stringify(id ? config : { name: "AgentDesk Supervisor", ...config }),
});
const text = await response.text();
if (!response.ok) { console.error(`ElevenLabs returned ${response.status}: ${text}`); process.exit(1); }
console.log((id ? "Updated agent " : "Created agent. Set ELEVENLABS_AGENT_ID=") + (id ?? (JSON.parse(text) as { agent_id: string }).agent_id));

export {};
