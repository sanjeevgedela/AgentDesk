# ElevenLabs supervisor verification

1. In ElevenLabs Agents, create an **AgentDesk Supervisor** and enable signed-session authentication. Set a reasonable concurrency and daily call limit.
2. Add client tools `desk_query(question: string)` and `propose_budget(agent_name: string, per_purchase_usdc: number, total_usdc: number)`. Set both to wait for the client response.
3. In the agent prompt, require `desk_query` before making factual claims about a workspace or training run. Clarify that `propose_budget` creates a draft only.
4. In the AgentDesk server environment, set `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID` and `AGENTDESK_SHOW_OPERATOR_ACCESS=true`.
5. Unlock operator access, record a decision or training report, then start a voice session over HTTPS or localhost. Allow the microphone.
6. Ask “What did training change?” Verify that the tool response matches the latest stored dataset and promotion. Ask for a research budget draft and check that no spending authority changes until you confirm it in the dashboard.
7. Record the verification date and deployment URL in IMPLEMENTATION.md. Keep signed session URLs and API keys private.
