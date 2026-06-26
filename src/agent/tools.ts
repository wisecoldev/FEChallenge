import { tool } from "ai";
import { z } from "zod";

import {
  applicationCountByStage,
  applicationsByJob,
  applicationsOverTime,
  candidatesBySource,
  jobsOverview,
  listCandidates,
  timeToHire,
  type AnalyticsCtx,
} from "@/db/analytics";
import type { Display, ToolResult } from "./artifact";

/**
 * The copilot's tool catalog — what the agent can actually do.
 *
 * Design notes:
 *  - The agent picks a tool and passes high-level params; it NEVER writes SQL.
 *    Each tool delegates to one scoped function in `src/db/analytics.ts`, so
 *    tenant scoping and PII gating are enforced underneath every tool by
 *    construction — a tool can't opt out.
 *  - `ctx` (workspaceId + role) is captured in this closure, not a tool input,
 *    so the model can't spoof a workspace or role by filling a field.
 *  - Inputs are ALL optional with sensible defaults. That keeps each tool easy
 *    for a model to drive, and lets the offline mock (which calls tools with
 *    empty args) still produce a useful answer.
 *  - Each tool returns `{ rows, display }` — `display` tells the UI how to
 *    render the rows (bar / line / table). See `src/agent/artifact.ts`.
 *
 * Granularity: one tool per analytical question a hiring team actually asks
 * (pipeline, trend, per-job volume, sourcing, open reqs, efficiency, individual
 * records) rather than one giant "query" tool — narrow tools are easier for the
 * model to choose between and produce cleaner display hints.
 */
export function buildTools(ctx: AnalyticsCtx) {
  const result = (rows: ToolResult["rows"], display: Display): ToolResult => ({
    rows,
    display,
  });

  const sourceEnum = z
    .enum(["referral", "linkedin", "job_board", "agency", "careers_site"])
    .describe("Candidate acquisition source.");

  return {
    // REFERENCE TOOL — a scoped query + typed input + a display hint the UI
    // renders. The pattern every other tool follows.
    applicationsByStage: tool({
      description:
        "Pipeline funnel: count applications grouped by stage (applied, screen, interview, offer, hired, rejected). Pass jobId to scope to a single job. Use for 'how does my pipeline look?'.",
      inputSchema: z.object({
        jobId: z.string().optional().describe("Optional job id to scope to one job."),
      }),
      async execute({ jobId }) {
        const rows = await applicationCountByStage(ctx, { jobId });
        return result(rows, {
          kind: "bar",
          x: "stage",
          y: "count",
          title: "Applications by stage",
        });
      },
    }),

    applicationsOverTime: tool({
      description:
        "Application volume over time, bucketed by week. Use for trends — 'are applications going up?', 'volume over the last weeks'. Pass jobId to scope to one job.",
      inputSchema: z.object({
        jobId: z.string().optional().describe("Optional job id to scope to one job."),
      }),
      async execute({ jobId }) {
        const rows = await applicationsOverTime(ctx, { jobId });
        return result(rows, {
          kind: "line",
          x: "week",
          y: "count",
          title: "Applications over time (weekly)",
        });
      },
    }),

    applicationsByJob: tool({
      description:
        "Application volume per job, highest first. Use for 'which roles get the most applicants?'.",
      inputSchema: z.object({}),
      async execute() {
        const rows = await applicationsByJob(ctx);
        return result(rows, {
          kind: "bar",
          x: "job",
          y: "count",
          title: "Applications by job",
        });
      },
    }),

    candidatesBySource: tool({
      description:
        "Where candidates come from: candidate counts grouped by acquisition source (referral, linkedin, job_board, agency, careers_site). Use for 'where are candidates coming from?'.",
      inputSchema: z.object({}),
      async execute() {
        const rows = await candidatesBySource(ctx);
        return result(rows, {
          kind: "bar",
          x: "source",
          y: "count",
          title: "Candidates by source",
        });
      },
    }),

    jobsOverview: tool({
      description:
        "List jobs in this workspace with their application counts. Optional status filter (open, closed, draft). Use for 'what roles are we hiring for?', 'show open reqs'.",
      inputSchema: z.object({
        status: z
          .enum(["open", "closed", "draft"])
          .optional()
          .describe("Optional job status filter."),
      }),
      async execute({ status }) {
        const rows = await jobsOverview(ctx, { status });
        return result(rows, {
          kind: "table",
          columns: ["job", "department", "location", "status", "applications"],
        });
      },
    }),

    timeToHire: tool({
      description:
        "Approximate time-to-hire per job: average days from application to the last update, for candidates who reached the hired stage. Use for 'how long does it take to hire?'. Note: this is a proxy — the data has no explicit hire-event timestamp — so treat it as approximate, not exact.",
      inputSchema: z.object({}),
      async execute() {
        const rows = await timeToHire(ctx);
        return result(rows, {
          kind: "bar",
          x: "job",
          y: "avgDays",
          title: "Approx. days to hire, by job",
        });
      },
    }),

    // PII-SENSITIVE. The underlying query redacts name/email/phone for an
    // `analyst` by construction (see `candidateColumns` in analytics.ts), so
    // this tool is safe to expose to every role: an analyst simply gets
    // "[redacted]" in those fields.
    listCandidates: tool({
      description:
        "List individual candidate records (newest first), with name, email, phone, and source. Use when asked about specific candidates or to browse applicants. Note: candidate contact details are visible only to recruiters and admins; an analyst sees them redacted.",
      inputSchema: z.object({
        source: sourceEnum.optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max rows to return (default 25, capped at 100)."),
      }),
      async execute({ source, limit }) {
        const rows = await listCandidates(ctx, { source, limit });
        return result(rows, {
          kind: "table",
          columns: ["name", "email", "phone", "source"],
        });
      },
    }),
  };
}

export type CopilotTools = ReturnType<typeof buildTools>;
