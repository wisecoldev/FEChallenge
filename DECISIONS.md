# Decisions

## Overview

I built the copilot end-to-end on top of the provided spine:

- **A real agent** wired to **Anthropic** (Claude), with the mock kept as the
  zero-setup/test default.
- **A 7-tool catalog** the model drives, each backed by one scoped query.
- **A query layer** (`src/db/analytics.ts`) where tenant scoping and PII gating
  are enforced **by construction**, not by remembering to.
- **Streaming generative UI** — bar / line / table components rendered per tool
  result, dependency-free.
- **Benchmarks** — deterministic unit tests at the data layer **and** Evalite
  agent evals for tenant isolation, permissions, and answer quality.
- **Stretch:** per-workspace **rate limiting**.

State: green across `pnpm typecheck`, `pnpm test` (14 tests), `pnpm eval`
(4 suites), and `pnpm build`. Nothing is half-done; the cuts below are
deliberate.

## Architecture & key decisions

- **Tool catalog** (`src/agent/tools.ts`) — one tool per question a hiring team
  actually asks: `applicationsByStage`, `applicationsOverTime`,
  `applicationsByJob`, `candidatesBySource`, `jobsOverview`, `timeToHire`,
  `listCandidates`. I chose **narrow tools over one mega-"query" tool**: the
  model picks between them far more reliably, and each carries a precise
  `display` hint for the UI. Every input is **optional with sane defaults** — so
  the offline mock (which calls tools with empty args) still returns useful data,
  and there's less for a model to fill wrong. `ctx` (workspace + role) is
  **captured in the closure, never a tool input**, so the model can't spoof a
  tenant or widen its role by filling a field.

- **Query layer** — a single file, `ctx` is the first argument of every
  function, and every read goes through one of two scoping primitives. It's
  composable (optional filters AND-ed in) and DRY (the projection + scope helpers
  are shared).

- **Tenant scoping, impossible to forget** — `scopeWhere` is the one place the
  workspace filter lives. `scopedSelect(ctx, table, …)` binds it up front, so for
  single-table reads you **cannot obtain a query builder without the tenant
  filter**. Joins scope **both** tables explicitly (and the `leftJoin` condition
  carries the workspace equality too, so a job can only aggregate its own
  workspace's applications). The unit tests + isolation eval then run *every*
  workspace and assert zero foreign rows — by construction **and** verified.

- **Permissions** — `candidateColumns(ctx)` is the **only** projection of
  candidate columns anywhere. For a non-PII reader (`analyst`), the
  name/email/phone slots select a **bound SQL literal** (`[redacted]`) instead of
  the column — so the underlying PII is **never read**, and a leaking query for
  the wrong role is *unrepresentable* rather than filtered out after the fact.
  Role comes from trusted `ctx`, never model input.

- **Generative UI** (`src/app/page.tsx`) — `Artifact` dispatches on
  `display.kind` to `BarChart` / `LineChart` / `DataTable`, all dependency-free
  (CSS bars, inline SVG line). Tool parts render a `calling… → result / error`
  transition. Redacted cells are rendered visibly ("redacted", muted) so the
  permission gate is **legible in the product**, not just enforced underneath.

## Model & agent

- **Provider: Anthropic, direct** (`createAnthropic`), default
  `claude-3-5-sonnet-latest`, overridable via `ANTHROPIC_MODEL`, and routable
  through a gateway via `AI_GATEWAY_BASE_URL`. **Why:** Claude is the strongest
  tool-caller for this stack, the provider layer was already stubbed for it, and
  a direct key is the shortest path to a working demo; the gateway hook is there
  for prod (caching / spend caps / failover) without a code change.
- **Loop** (`src/agent/run.ts`) — `streamText` with `stopWhen: stepCountIs(6)`.
  The agent typically takes 2 steps (call a tool, then summarize); the headroom
  lets it chain a second query or recover from a tool error before answering.
- **Tool errors don't crash the turn** — a thrown tool `execute` becomes a
  `tool-error` result fed back to the model, which can apologize or try another
  tool. `onError` logs provider/stream failures server-side, and the chat route
  maps errors to a **safe client message** so internals never leak.

## Benchmarks

- **Unit tests** (`src/db/__tests__/analytics.test.ts`) — deterministic, at the
  data layer: isolation (ids prefixed per workspace, counts 18/24 & 14/19,
  disjoint job titles), PII (admin/recruiter see real values, **analyst gets
  every PII field redacted**, non-PII analytics identical across roles), the
  permission primitives, and query shapes. Plus rate-limiter math.
- **Agent evals** (`evals/copilot.eval.ts`, Evalite) — end-to-end through the
  real agent loop, designed so they **can't pass vacuously**:
  - **Tenant isolation** across **both** workspaces: assert no row carries a
    marker unique to the *other* workspace, **and** a positive control
    (`ownMarkerSurfaced`) asserts at least one of *this* workspace's markers
    actually appeared — so an empty/zero-row result fails instead of falsely
    passing. Markers are **computed from trusted, directly-scoped queries**
    (candidate ids + job titles) — *not* names/emails, because the seed reuses
    the same name pool by index, so those overlap across tenants. (A real catch —
    see below.)
  - **Permissions** — runs as `analyst` in **both** workspaces and asserts no PII
    leaks, **plus `drovePIITool`** asserts `listCandidates` actually ran (so a
    misrouted question fails loudly instead of testing nothing), **plus a
    recruiter positive control** proving the same path *can* surface PII — so an
    analyst's clean result is redaction working, not an empty response.
  - **Answer quality** — deterministic grounding always; an **LLM-as-judge** that
    activates only once a real model is wired (`AI_PROVIDER != mock`).
  - A unit test pins the **mock's tool routing** (`agent.test.ts`) so the routes
    these evals depend on can't silently drift.
  - They fail loudly if `scopeWhere` or the redaction projection is removed.

## Trade-offs & cuts

- **Stretch built: per-workspace rate limiting** (`src/server/rate-limit.ts`) — a
  token bucket keyed by `workspaceId` on `/api/chat`, returning `429` +
  `Retry-After`. It's the same **isolation theme applied to compute**: one tenant
  can't starve the shared model + in-process DB. In-memory to match the
  single-process PGlite model; the `consume()` shape mirrors a Redis/Upstash
  limiter so swapping the store for production is a drop-in.
- **Other stretches — plans, not code:**
  - *Typed structured answer:* add an `Output.object` schema (`headline`,
    `insight`, `followups`) the agent emits alongside prose, rendered as a summary
    card. Skipped to keep the offline mock (free-text) working without a branch.
  - *Response caching:* cache tool results keyed by `(workspaceId, role, tool,
    args)` with a short TTL — but cache **must** include role so a recruiter's
    cached PII never serves an analyst; deferred to avoid that footgun.
  - *Deploy:* Vercel for the app + Neon/Supabase Postgres (PGlite is file-backed
    and won't survive serverless); swap the Drizzle client, keep the query layer.
- **Cut (deliberately):** candidate drill-down view, pagination, chart axis
  ticks/tooltips beyond hover, gap-filling sparse weeks in the trend (only active
  weeks are returned), and role-varying table columns for `listCandidates` (an
  analyst sees `[redacted]` cells rather than the PII columns being dropped —
  intentional, so the gate is visible). **With another day:** the structured-
  answer stretch, a `/candidates` drill-down, a continuous (zero-filled) trend
  series, and a broader LLM-judge eval set with graded `expected` answers.

## Working with the agent

- **Delegated:** scaffolding the query functions and chart components, the eval
  harness structure, and — notably — an **adversarial multi-agent review** of my
  own diff (parallel reviewers per dimension: isolation, PII, tool/query design,
  UI, benchmark rigor, loop; each finding independently re-verified against the
  code before I acted on it).
- **Where it was wrong and I caught it:**
  1. It first proposed candidate **names/emails as cross-tenant markers** in the
     isolation eval. The seed reuses the same name pool by index, so `bw-cand-1`
     and `mer-cand-1` share a name/email — the eval would have passed even with a
     real leak. I switched markers to workspace-prefixed **ids + job titles**.
  2. A generic `scopedSelect` helper typed its selection as `Record<string,
     unknown>`, collapsing the return type to `unknown` and silently breaking
     tRPC → UI inference. I constrained it to Drizzle's `SelectedFields`.
  3. PGlite's WASM engine crashed under Vitest's default file parallelism. Pinned
     `fileParallelism: false`.
- **What the review caught that I then fixed** (it earned its keep):
  - The isolation/PII evals could **pass vacuously** (empty marker set or zero
    rows scored green). Added positive-control scorers + a non-empty ground-truth
    guard.
  - One analyst PII question **misrouted** to a non-PII tool under the mock, so it
    exercised nothing. Reworded both questions and added `drovePIITool`.
  - `timeToHire` presented `updatedAt` as an authoritative hire timestamp — it's a
    proxy. Relabeled the tool/metric honestly.
  - (It also flagged a "counts come back as strings" bug — I had a verifier *run*
    the code, which showed PGlite returns numbers; **rejected as a false positive**.)
- **What I'd never let it decide on its own:** the **mechanism** for tenant
  scoping and PII gating (the "unrepresentable, not post-filtered" approach), and
  whether each benchmark actually catches the failure it claims. Those I owned —
  the review *informs*, it doesn't *decide*.

## Notes on running it

- The mock boots with zero setup. For the real agent, set `AI_PROVIDER=anthropic`
  + `ANTHROPIC_API_KEY` in `.env.local`.
- `next dev`/`build` use Turbopack, whose prebuilt native binary `SIGILL`s on some
  virtualized CPUs (it did on my box — an i7-9700 under a hypervisor). `next dev
  --webpack` sidesteps it and serves identically. Tests/evals don't use Turbopack
  (esbuild) and are unaffected. On standard hardware `pnpm dev` works as-is.

## Hours

~4 hours.
