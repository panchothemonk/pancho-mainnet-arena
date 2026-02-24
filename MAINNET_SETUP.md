# Mainnet Setup (Separate Repo)

This repo is isolated from sim and intended for mainnet rollout prep.

## Locked On-Chain Rules

- Immutable fee: `600` bps (6%).
- Immutable treasury: `418cSB954o9jaYeDRFj3CFWzzLNkTERwY2h8ErHEgvzR`.
- Initial admin: `6X8KQrJ87ekdeUaxwR38fRtrhhDr1ZE4PSc1GsGRqTfe`.

## 1) Configure Environment

Copy `.env.mainnet.example` to `.env.local` and fill remaining placeholders.

Required core values already pinned:

- `SOLANA_RPC_URL=https://solana-mainnet.g.alchemy.com/v2/BXGTE6XP8kfGGwodSZ3dI`
- `PANCHO_TREASURY_WALLET=418cSB954o9jaYeDRFj3CFWzzLNkTERwY2h8ErHEgvzR`
- `PANCHO_EXPECTED_TREASURY_WALLET=418cSB954o9jaYeDRFj3CFWzzLNkTERwY2h8ErHEgvzR`

## 2) Build and Verify

```bash
npm install
npm run lint
npm run build
npm run onchain:check
```

## 3) Deploy Program (when funded)

```bash
npm run onchain:build
cd onchain
anchor deploy --provider.cluster mainnet --provider.wallet ~/.config/solana/id.json
```

Set deployed program id in:

- `PANCHO_PROGRAM_ID`
- `NEXT_PUBLIC_PANCHO_PROGRAM_ID`

## 4) Start Mainnet Keeper

```bash
cd /path/to/pancho-mainnet-arena
npm run onchain:keeper
```

Keeper will refuse init if treasury or fee do not match immutable contract rules.

## 5) Deploy Cloudflare App

```bash
npm run cf:deploy
```

Worker secrets to set before launch:

- `SOLANA_RPC_URL`
- `PANCHO_TREASURY_WALLET`
- `PANCHO_EXPECTED_TREASURY_WALLET`
- `ADMIN_SECRET`
- `OPS_API_KEY`
- `SETTLE_API_KEY`

## 6) Launch Gate

Before unpausing joins:

```bash
npm run onchain:preflight
npm run canary:workers
```

Only then enable public betting.
