import { beforeAll, describe, expect, test } from "vitest";

import { db, ensureSchema } from "@/db/client";
import { workspaces } from "@/db/schema";
import { seed } from "@/db/seed";
import {
  applicationCountByStage,
  applicationsByJob,
  candidatesBySource,
  jobsOverview,
  listCandidates,
  timeToHire,
  type AnalyticsCtx,
} from "@/db/analytics";
import { canReadColumn, canReadPII, REDACTED } from "@/db/permissions";

const bwAdmin: AnalyticsCtx = { workspaceId: "brightwave", role: "admin" };
const bwAnalyst: AnalyticsCtx = { workspaceId: "brightwave", role: "analyst" };
const bwRecruiter: AnalyticsCtx = { workspaceId: "brightwave", role: "recruiter" };
const merAdmin: AnalyticsCtx = { workspaceId: "meridian", role: "admin" };

beforeAll(async () => {
  await ensureSchema();
  const rows = await db.select().from(workspaces);
  if (rows.length === 0) await seed();
});

describe("tenant isolation", () => {
  test("listCandidates returns only the caller's workspace rows", async () => {
    const bw = await listCandidates(bwAdmin, { limit: 100 });
    const mer = await listCandidates(merAdmin, { limit: 100 });

    expect(bw.length).toBe(18);
    expect(mer.length).toBe(14);
    expect(bw.every((c) => c.id.startsWith("bw-cand-"))).toBe(true);
    expect(mer.every((c) => c.id.startsWith("mer-cand-"))).toBe(true);

    // No id appears in both result sets.
    const merIds = new Set(mer.map((c) => c.id));
    expect(bw.some((c) => merIds.has(c.id))).toBe(false);
  });

  test("applicationsByJob never returns the other workspace's jobs", async () => {
    const bw = await applicationsByJob(bwAdmin);
    const mer = await applicationsByJob(merAdmin);
    const merTitles = new Set(mer.map((r) => r.job));
    // Brightwave and Meridian have disjoint job titles in the seed.
    expect(bw.some((r) => merTitles.has(r.job))).toBe(false);
    expect(bw.map((r) => r.job)).toContain("Senior Software Engineer");
    expect(mer.map((r) => r.job)).toContain("Operations Manager");
  });

  test("stage counts are workspace-specific and sum to that workspace's apps", async () => {
    const bw = await applicationCountByStage(bwAdmin);
    const mer = await applicationCountByStage(merAdmin);
    const sum = (rows: { count: number }[]) =>
      rows.reduce((n, r) => n + Number(r.count), 0);
    expect(sum(bw)).toBe(24); // Brightwave: 24 applications (from seed)
    expect(sum(mer)).toBe(19); // Meridian: 19 applications (from seed)
  });

  test("jobsOverview only aggregates the workspace's own applications", async () => {
    const bw = await jobsOverview(bwAdmin);
    const totalApps = bw.reduce((n, r) => n + Number(r.applications), 0);
    expect(totalApps).toBe(24);
    expect(bw.every((r) => typeof r.job === "string")).toBe(true);
  });
});

describe("PII permissions", () => {
  test("admin and recruiter see real candidate PII", async () => {
    for (const ctx of [bwAdmin, bwRecruiter]) {
      const rows = await listCandidates(ctx, { limit: 5 });
      expect(rows.every((c) => c.name !== REDACTED)).toBe(true);
      expect(rows.every((c) => c.email.includes("@"))).toBe(true);
      expect(rows.every((c) => c.phone.startsWith("+1-555"))).toBe(true);
    }
  });

  test("analyst NEVER receives candidate PII — every PII field is redacted", async () => {
    const rows = await listCandidates(bwAnalyst, { limit: 100 });
    expect(rows.length).toBe(18); // analyst still sees the non-PII data...
    for (const c of rows) {
      expect(c.name).toBe(REDACTED);
      expect(c.email).toBe(REDACTED);
      expect(c.phone).toBe(REDACTED);
      // ...non-PII columns remain readable.
      expect(typeof c.source).toBe("string");
      expect(c.id.startsWith("bw-cand-")).toBe(true);
    }
  });

  test("non-PII analytics are identical across roles (analyst loses nothing else)", async () => {
    const asAdmin = await candidatesBySource(bwAdmin);
    const asAnalyst = await candidatesBySource(bwAnalyst);
    expect(asAnalyst).toEqual(asAdmin);
  });

  test("permission primitives agree with enforcement", () => {
    expect(canReadPII("admin")).toBe(true);
    expect(canReadPII("recruiter")).toBe(true);
    expect(canReadPII("analyst")).toBe(false);
    expect(canReadColumn("analyst", "candidates", "name")).toBe(false);
    expect(canReadColumn("analyst", "candidates", "source")).toBe(true);
    expect(canReadColumn("admin", "candidates", "email")).toBe(true);
  });
});

describe("query shapes", () => {
  test("timeToHire returns avg days for jobs with hires", async () => {
    const rows = await timeToHire(bwAdmin);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => Number(r.hires) > 0)).toBe(true);
    expect(rows.every((r) => Number.isFinite(Number(r.avgDays)))).toBe(true);
  });

  test("listCandidates respects the limit cap and source filter", async () => {
    const limited = await listCandidates(bwAdmin, { limit: 3 });
    expect(limited.length).toBe(3);
    const linkedin = await listCandidates(bwAdmin, { source: "linkedin" });
    expect(linkedin.every((c) => c.source === "linkedin")).toBe(true);
  });
});
