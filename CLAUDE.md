# Working notes / agent config

A multi-tenant **ATS analytics copilot**. An AI agent chats about **one
workspace's** recruiting data (jobs, candidates, applications), calls tools, and
renders the results as charts/tables. This file is both my notes and the config
for any AI assistant working in this repo — keep it current.

## The one rule that matters most

**All data access is scoped to the caller's workspace AND role.** Two invariants
hold for everything in `src/db/analytics.ts`, by construction — preserve them:

1. **Tenant scope.** `ctx` is the first arg of every query; every `where` routes
   through `scopeWhere`. Single-table reads start from `scopedSelect(ctx, …)`, so
   you can't build a query without its workspace filter. Joins scope **both**
   tables. A cross-workspace read should be impossible to write by accident.
2. **PII.** `candidateColumns(ctx)` is the **only** projection of candidate
   columns. For an `analyst` it selects a bound `[redacted]` literal in place of
   name/email/phone — the columns are never read, so a PII leak for the wrong
   role is *unrepresentable*, not filtered after the fact.

A cross-workspace or PII leak is the worst bug you can ship here. If you add a
query, mirror these patterns and add an assertion to the evals/tests.

## Architecture (what's built)

- **`src/db/analytics.ts`** — the scoped query layer. `scopeWhere` (tenant gate),
  `scopedSelect` (forces scope for single-table reads), `candidateColumns` (PII
  gate). 7 query functions: pipeline by stage, over time, by job, by source, jobs
  overview, time-to-hire, list candidates.
- **`src/db/permissions.ts`** — `canReadPII` / `canReadColumn` primitives +
  `REDACTED`. `analyst` is excluded from PII; `recruiter`/`admin` included.
- **`src/agent/tools.ts`** — 7 tools, one per analytical question. All inputs
  optional (the mock calls with empty args). `ctx` is closed over, never a tool
  input — the model can't spoof tenant/role.
- **`src/agent/run.ts` / `provider.ts`** — `streamText` loop, `stopWhen(6)`,
  tool errors fed back to the model. Real model = Anthropic (`AI_PROVIDER`).
- **`src/app/page.tsx`** — generative UI: `Artifact` → bar / line / table,
  dependency-free, streaming `calling → result` states, visible redaction.
- **`src/server/rate-limit.ts`** — per-workspace token bucket (stretch).
- **`evals/copilot.eval.ts`** + **`src/**/__tests__`** — benchmarks (below).

## Build a real agent

The repo **boots** on a mock model (deterministic, offline) so it runs on clone
and tests stay green. To run the real agent, set `AI_PROVIDER=anthropic` and
`ANTHROPIC_API_KEY` in `.env.local` (gitignored) — see `.env.example`. The mock
calls tools with **empty args**, so keep every tool input optional.

## Benchmarks (must catch the real thing)

- **Unit** (`src/db/__tests__/analytics.test.ts`): isolation, PII redaction,
  permission primitives, query shapes — deterministic, at the data layer.
- **Evals** (`evals/copilot.eval.ts`): isolation + PII + answer-quality through
  the agent loop. Cross-tenant markers are **ids + job titles** — NOT
  names/emails (the seed reuses the same name pool by index, so those overlap
  across workspaces and would make an isolation check pass falsely).

## Commands

```bash
pnpm install
pnpm db:seed      # wipe + seed Brightwave + Meridian Logistics
pnpm dev          # http://localhost:3000
pnpm eval         # Evalite agent evals
pnpm typecheck
pnpm test         # vitest (runs files sequentially — shared file-backed PGlite)
pnpm build
```

## Stack

Next.js 16 (App Router, Turbopack) · React 19 · Vercel AI SDK v6 · tRPC v11 +
TanStack Query + superjson · Drizzle ORM over PGlite (file-backed `./.pglite`) ·
Evalite · Tailwind v3 · TypeScript strict.

## Gotchas

- `pnpm test` runs test files **sequentially** (`fileParallelism: false`) — the
  file-backed PGlite is one shared resource and crashes if opened by parallel
  workers.
- If PGlite ever aborts on open (killed mid-write), `rm -rf ./.pglite && pnpm
  db:seed`.
