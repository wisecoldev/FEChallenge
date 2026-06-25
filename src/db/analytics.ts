import {
  and,
  asc,
  count,
  desc,
  eq,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import type { PgTable, SelectedFields } from "drizzle-orm/pg-core";

import { db } from "./client";
import { canReadPII, REDACTED, type Role } from "./permissions";
import { applications, candidates, jobs } from "./schema";

/**
 * Scoped analytics data layer for the copilot.
 *
 * Every function here is the agent's only path to the database — the tools in
 * `src/agent/tools.ts` call these; the model never writes SQL. Two invariants
 * hold for EVERYTHING in this file, by construction:
 *
 *  1. TENANT SCOPING. `ctx` is the first argument of every query, and every
 *     `where` routes through `scopeWhere` (single-table) or AND-s a per-table
 *     `scopeWhere` for joins. You cannot express a read without its workspace
 *     filter, so a cross-workspace leak can't be written by accident.
 *
 *  2. PERMISSIONS. Candidate PII (name / email / phone) is only ever projected
 *     through `candidateColumns`, which selects a bound redaction literal — not
 *     the column — when the caller isn't a PII reader. So an `analyst`'s query
 *     never even *references* the PII columns in SQL; redaction isn't a filter
 *     applied after the rows come back, it's absent from the query plan.
 *
 * The evals in `evals/copilot.eval.ts` verify both against the real tool surface.
 */

export type AnalyticsCtx = { workspaceId: string; role: Role };

/** Any tenant-owned table — i.e. one that carries a `workspaceId` column. */
type TenantTable = PgTable & { workspaceId: AnyColumn };

/** The one place tenant scoping lives: AND-s the workspace filter into a query. */
function scopeWhere(
  table: { workspaceId: AnyColumn },
  ctx: AnalyticsCtx,
  extra: Array<SQL | undefined> = [],
): SQL {
  const parts = [eq(table.workspaceId, ctx.workspaceId), ...extra].filter(
    (p): p is SQL => p !== undefined,
  );
  // Always has at least the workspace filter, so it's never undefined.
  return and(...parts)!;
}

/**
 * Ergonomic scoped read for single-table queries: the workspace filter is bound
 * up front, so you can't obtain a query builder for a tenant table without it.
 * Chain `.groupBy()/.orderBy()/.limit()` as usual. Joins scope each table
 * explicitly with `scopeWhere` (see `applicationsByJob`, `timeToHire`).
 */
function scopedSelect<TSelection extends SelectedFields>(
  ctx: AnalyticsCtx,
  table: TenantTable,
  selection: TSelection,
  extra: Array<SQL | undefined> = [],
) {
  return db
    .select(selection)
    .from(table)
    .where(scopeWhere(table, ctx, extra));
}

/**
 * The ONLY projection of candidate columns. PII is gated here, by construction:
 * for a non-PII reader the name/email/phone slots select a bound literal, so the
 * underlying columns are never read. Every candidate-returning query uses this.
 */
function candidateColumns(ctx: AnalyticsCtx) {
  const pii = canReadPII(ctx.role);
  return {
    id: candidates.id,
    name: pii ? candidates.name : sql<string>`${REDACTED}`.as("name"),
    email: pii ? candidates.email : sql<string>`${REDACTED}`.as("email"),
    phone: pii ? candidates.phone : sql<string>`${REDACTED}`.as("phone"),
    source: candidates.source,
    createdAt: candidates.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Pipeline & volume
// ---------------------------------------------------------------------------

/**
 * REFERENCE QUERY: applications grouped by pipeline stage, scoped to the
 * caller's workspace. `ctx` comes first on purpose — a query can't even be
 * expressed without the tenant scope, so it can't be forgotten.
 */
export async function applicationCountByStage(
  ctx: AnalyticsCtx,
  opts: { jobId?: string } = {},
) {
  const extra = opts.jobId ? [eq(applications.jobId, opts.jobId)] : [];
  return scopedSelect(
    ctx,
    applications,
    { stage: applications.stage, count: count() },
    extra,
  )
    .groupBy(applications.stage)
    .orderBy(desc(count()));
}

/** Application volume over time, bucketed by week (for a trend / line chart). */
export async function applicationsOverTime(
  ctx: AnalyticsCtx,
  opts: { jobId?: string } = {},
) {
  const week = sql<string>`to_char(date_trunc('week', ${applications.appliedAt}), 'YYYY-MM-DD')`;
  const extra = opts.jobId ? [eq(applications.jobId, opts.jobId)] : [];
  return scopedSelect(
    ctx,
    applications,
    { week: week.as("week"), count: count() },
    extra,
  )
    .groupBy(week)
    .orderBy(asc(week));
}

/** Application volume per job (joins applications → jobs, both scoped). */
export async function applicationsByJob(ctx: AnalyticsCtx) {
  return db
    .select({ job: jobs.title, count: count(applications.id) })
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .where(and(scopeWhere(applications, ctx), scopeWhere(jobs, ctx)))
    .groupBy(jobs.title)
    .orderBy(desc(count(applications.id)));
}

// ---------------------------------------------------------------------------
// Sourcing
// ---------------------------------------------------------------------------

/** Where candidates come from — counts grouped by acquisition source. */
export async function candidatesBySource(ctx: AnalyticsCtx) {
  return scopedSelect(ctx, candidates, {
    source: candidates.source,
    count: count(),
  })
    .groupBy(candidates.source)
    .orderBy(desc(count()));
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/**
 * Jobs in this workspace with their application counts. Optional `status` filter
 * ('open' | 'closed' | 'draft'). The left join is scoped on BOTH sides so a job
 * can only aggregate its own workspace's applications.
 */
export async function jobsOverview(
  ctx: AnalyticsCtx,
  opts: { status?: string } = {},
) {
  const extra = opts.status ? [eq(jobs.status, opts.status)] : [];
  return db
    .select({
      // `id` is returned (not shown in the table) so the model can chain a
      // result here into the `jobId` param of applicationsByStage / over-time.
      id: jobs.id,
      job: jobs.title,
      department: jobs.department,
      location: jobs.location,
      status: jobs.status,
      applications: count(applications.id),
    })
    .from(jobs)
    .leftJoin(
      applications,
      and(
        eq(applications.jobId, jobs.id),
        eq(applications.workspaceId, ctx.workspaceId),
      ),
    )
    .where(scopeWhere(jobs, ctx, extra))
    .groupBy(jobs.id, jobs.title, jobs.department, jobs.location, jobs.status)
    .orderBy(desc(count(applications.id)));
}

// ---------------------------------------------------------------------------
// Efficiency
// ---------------------------------------------------------------------------

/**
 * Pipeline duration per job, for applications that reached the `hired` stage:
 * average days from `appliedAt` to the row's last `updatedAt`.
 *
 * HONESTY NOTE: the schema has no explicit "reached hired at" event, so this
 * uses `updatedAt` as a PROXY for the decision date. It approximates time-to-hire
 * but isn't an authoritative hire timestamp — the tool description says so, so the
 * model doesn't over-claim. A production version would record a stage-transition
 * event and measure against that.
 */
export async function timeToHire(ctx: AnalyticsCtx) {
  const avgDays = sql<number>`round(avg(extract(epoch from (${applications.updatedAt} - ${applications.appliedAt})) / 86400))::int`;
  return db
    .select({ job: jobs.title, avgDays: avgDays.as("avg_days"), hires: count() })
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .where(
      and(
        scopeWhere(applications, ctx, [eq(applications.stage, "hired")]),
        scopeWhere(jobs, ctx),
      ),
    )
    .groupBy(jobs.title)
    .orderBy(desc(count()));
}

// ---------------------------------------------------------------------------
// Candidates (PII-gated)
// ---------------------------------------------------------------------------

/**
 * Individual candidate records, newest first. PII (name/email/phone) is gated by
 * role through `candidateColumns`: an `analyst` receives redaction literals in
 * those fields, never the real values. Optional `source` filter; `limit` capped.
 */
export async function listCandidates(
  ctx: AnalyticsCtx,
  opts: { source?: string; limit?: number } = {},
) {
  const extra = opts.source ? [eq(candidates.source, opts.source)] : [];
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  return db
    .select(candidateColumns(ctx))
    .from(candidates)
    .where(scopeWhere(candidates, ctx, extra))
    .orderBy(desc(candidates.createdAt))
    .limit(limit);
}
