# AgentDesk

AgentDesk gives prediction-market strategies independent paper portfolios and a supervisor that can explain their decisions, overlapping positions and research spending. It brings payment authority into the decision log. An evidence-driven agent requests a quote review, the operator reviews a proposed spending change, and a wallet can buy the review with test USDC on Solana devnet.

## Local setup

Use Node.js 22 or newer.

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Open http://localhost:3000. Replay, the public Gemini feed, paper fills, strategy editing and text supervision work with an empty configuration. Each demo browser gets a separate workspace. Local state lives in `.agentdesk/`; use a single local process. For Postgres, apply `migrations/001_workspace.sql` and set `DATABASE_URL` to a server-only connection string for a role allowed to read and write the table. For a Supabase transaction pooler use a TLS connection string. The table is unavailable to the Supabase anonymous and authenticated browser roles.

| Environment variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Supabase Postgres connection, required on Vercel |
| `AGENTDESK_OPERATOR_TOKEN` | Operator access to the separate workspace, settlement, voice and budget confirmation. Generate a secret with `openssl rand -hex 32`. |
| `RESEARCH_INTERNAL_TOKEN` | Separate server-to-research authentication secret. Generate independently. |
| `SOLANA_DEVNET_KEYPAIR` | Dedicated signer as the JSON array from a Solana CLI keypair file. Fund with devnet USDC only. |
| `RESEARCH_RECIPIENT` | Separate approved Solana devnet recipient wallet address. Set up the devnet USDC associated token account before the demo. |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID` | Private ElevenLabs agent and server-side API key |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Optional OpenAI interpretation for the operator workspace. Default model is `gpt-4.1-mini`. |

Set secrets in `.env.local` or the Vercel project environment. Keep the signer funded with a small amount of test tokens and use a recipient you control. The public workspace never invokes the model or controls the spending signer. The operator bearer is held in browser memory and must be entered again after reloading. This deployment model has a single trusted operator account.

## Decision loop

Live Gemini fetches public active events from the [Prediction Markets event API](https://developer.gemini.com/prediction-markets/market-data) and records open contracts with usable YES bids and asks. It timestamps observation and retains the source URL for each snapshot. Use **Refresh quotes** for another observation. Enable a live instrument by adding its symbol to the agent's allowed markets. Replay shows only synthetic snapshots that have been advanced and exposes a separate market symbol. Live errors surface in the UI.

Agents start at $1,000 each and can hold whole YES contracts long-only. The midpoint change between the two latest observed quotes drives momentum and mean reversion. The evidence-driven strategy holds until a material move can be reviewed. Save one rule per line, such as `Always hold`, `Hold if spread exceeds 5¢`, or `Buy when YES falls below 40¢`. Other supported quote fields are midpoint, ask and bid. The first matching trade rule takes effect unless a hold rule matches. AgentDesk sends other instructions to the optional operator model. If the model is unavailable or returns invalid output, AgentDesk records a hold. The model may recommend a paper action based on those instructions, subject to server-side trading and spending controls. Instructions are versioned and evaluated at run time.

Buys use the observed ask and sells use the observed bid, up to five contracts per decision plus a fixed one-cent fee per fill. Cash and prices use integer cents. Valuation uses quote midpoint. The simulation assumes those quantities could fill at the displayed quote and omits depth, slippage, market resolution payouts and shorting. Each strategy version can run once per snapshot. Reopening the result shows the saved decision without creating another fill. Refreshing a live quote records a new observation.

Runs record the source, signal, tool results, decision, policy outcome and optional fill. Text and voice use the same supervisor query, which reads stored records. Research purchases link back to their originating decision. Missing decisions and missing overlap appear explicitly.

## Devnet settlement

The one allowlisted resource is AgentDesk's own **Quote quality review**, priced at 0.25 devnet USDC. The service derives evidence from the saved snapshot's spread and observation time. After settlement, the revised recommendation respects the strategy version's saved rules. The operator can apply it once as a paper order while the original quote and strategy version are still current.

The server locks the owner workspace while checking per-purchase and total budgets and reserving USDC base units. Each request has an idempotency key. Pending, uncertain and confirmed payments occupy the budget and block duplicate payment for a decision. A confirmed devnet failure releases the reservation. A payment that fails before submission can be retried. A missing or ambiguous onchain receipt remains reserved indefinitely until resolved. The app cannot automatically recover a signature that the facilitator never returned.

The server-side x402 client uses Exact SVM over [x402 v2](https://github.com/coinbase/x402/tree/main/typescript/packages). It calls the project's protected research handler in-process. It accepts only the configured recipient, 250,000 base units, the expected mint and the Solana devnet CAIP-2 network `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`. The public x402 test facilitator supplies the signed fee-payer part and settles the transfer. AgentDesk persists the returned signature, checks confirmed devnet balance metadata for the expected USDC credit, and stores the actual program IDs from the transaction instructions.

- USDC devnet mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`
- Canonical SPL Token program: `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`
- Confirmed purchases show their own Solana Explorer link in the format `https://explorer.solana.com/tx/<signature>?cluster=devnet`. A funded transfer receipt is pending verification.

## ElevenLabs voice

In ElevenLabs, create a private [ElevenAgents](https://elevenlabs.io/docs/eleven-agents/libraries/react) agent with authentication enabled. Register these client tools and enable response waiting for both.

| Tool | Required parameters | Behavior |
| --- | --- | --- |
| `desk_query` | `question` string | Reads saved decisions, agent status, comparisons, exposure or spending through the same authenticated API as text chat |
| `propose_budget` | `agent_name` string, `per_purchase_usdc` number, `total_usdc` number | Proposes the change and returns a request to confirm it in the Research panel |

Prompt the agent to call `desk_query` before answering questions about this workspace, cite available decision or payment records, and ask for both new limits before proposing budget changes. A signed WebSocket session is issued only after operator authentication. Client tools run through the open browser session and send queries to the server. The budget change requires a separate operator confirmation from the Research panel. Use localhost or HTTPS and allow the browser microphone.

## Deployment

Import this branch into a Vercel Next.js project. Set the target environment variables, apply the Supabase migration, and use the preview URL for verification. Promote only after checking microphone, data persistence and operator access on the intended deployment.

Run `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` before deploying. The hosted persistence, funded settlement and audible ElevenLabs session require integration credentials. QuickNode Streams, Grok Bot and Arc are outside the current build.

## Two-minute demo

1. Unlock the operator workspace. Choose **Replay**, advance one snapshot, then run Trend Scout and Evidence Analyst. Trend Scout can place a paper fill. Evidence Analyst starts with a hold.
2. On Evidence Analyst, click **Buy requested quote review**. The 0.10 USDC cap blocks a 0.25 USDC purchase. Open the Research log and read the policy outcome.
3. Start voice and ask why Evidence Analyst held, then say “Propose a 0.25 USDC per-purchase cap and a 1 USDC total budget for Evidence Analyst.” Review the parsed change in Research and click **Confirm budget change**.
4. Request the review again. With the configured devnet signer funded, open the confirmed Explorer receipt. The 3¢ replay spread qualifies as usable evidence and revises the recommendation from hold to buy.
5. Ask the supervisor which agents disagreed and whether research changed the recommendation. Open the referenced decision and payment records.
