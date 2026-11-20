# AgentDesk verification checklist

- [x] Live Gemini snapshot and settled-outcome API responses verified from the local workspace. Local capture covered 75 observations across 37 contracts between 06:41 and 06:58 UTC on November 20, 2026.
- [x] Reproducible SYNTHETIC evaluation with baselines and bootstrap intervals committed under [reports](reports/).
- [x] CI passed at [the first report commit](https://github.com/sanjeevgedela/AgentDesk/actions/runs/44690433296).
- [x] Paper fill parity, policy denial, daily loss, replay idempotency, and no-lookahead cases pass locally.
- [x] Synthetic training is deterministic. Production-build Chromium smoke test verified a stored SYNTHETIC training report, live Gemini history, and the keyless replay flow.
- [x] Memo verification detects tampered decisions against a mocked RPC response.
- [ ] Record 120 or more observations for the same live contract, train on those quotes, and verify the persisted report and any promoted version.
- [ ] Confirm a funded x402 USDC transfer on Solana devnet and record its Explorer URL.
- [ ] Confirm a funded Solana devnet decision memo and record its Explorer URL. The public RPC faucet declined the airdrop request.
- [ ] Verify an audible ElevenLabs conversation and grounded tool response. The supplied API key could read the account but lacked agent creation permission and returned no agents.
- [ ] Configure production Postgres and a scheduling-capable host, then verify persistence, authorization, and voice at the deployment URL.
- [ ] Verify QuickNode Streams on a configured account. Scheduled RPC reconciliation is the current implementation.

## Finish audit

| Surface | Status and next verification |
| --- | --- |
| Dashboard, market mode and selector, chart cursor, replay progression, agent create/edit/run, training, decision log, research, supervisor | Single page with independent live and explicitly synthetic sources. Fitted forecast controls now persist model artifacts and version selection. |
| `/api/desk`, `/api/history`, `/api/tick` | Workspace writes, stored observations, bounded history, scheduled collection. Fitting and activation require operator access. Gemini's event schema has nullable `priceHistory` and no documented pagination for that field. Empty or unavailable backfill is shown explicitly. |
| Trend Scout, Mean Reverter, Evidence Analyst | Shared fitted price-change model format. Momentum follows its forecast, contrarian inverts it, and Evidence Analyst can request a review. Stop-loss and execution policy still apply. |
| `/api/research`, reconciler, Solana memo | Demo receipts are labeled. Existing operator x402 code verifies settlement before exposing paid evidence in the desk. Funded transfer and memo still require funded devnet wallets and vendor token account. |
| Supervisor text and ElevenLabs controls | Both use the same `ask` path with saved model, portfolio, decision and payment records. ElevenLabs audio, microphone denial, reconnect and live tools require a configured private agent and permitted API key. |
| Deployment | No authorized hosted deployment or database credentials available in this workspace. |
