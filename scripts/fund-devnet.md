# Funding the devnet demo

Create separate Solana devnet payer and research-vendor wallets. The optional memo signer can use a third wallet. Keep private keys in your server secret store. The receive address is public.

1. Request test SOL at [Solana Faucet](https://faucet.solana.com/) for the payer and memo signer.
2. Obtain devnet USDC from [Circle Faucet](https://faucet.circle.com/) for the payer and create or fund the research-vendor's USDC associated token account. Verify the mint against the README.
3. Configure the payer key in `SOLANA_DEVNET_KEYPAIR`, the vendor address in `RESEARCH_RECIPIENT`, and the optional memo signer in `SOLANA_AGENT_KEYPAIR`.
4. Run `npx tsx --env-file=.env.local scripts/verify-devnet.ts` to submit and verify a real memo. Use the operator research workflow for an independent x402 settlement.
