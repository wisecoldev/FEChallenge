import { beforeAll, describe, expect, test } from "vitest";

import { db, ensureSchema } from "@/db/client";
import { workspaces } from "@/db/schema";
import { seed } from "@/db/seed";
import { streamCopilot } from "@/agent/run";
import type { Role } from "@/db/permissions";
import type { UIMessage } from "ai";

function userMessage(text: string): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text }],
  };
}

/** Run one turn and collapse to the tool names + flattened result rows. */
async function run(q: string, workspaceId = "brightwave", role: Role = "admin") {
  const result = await streamCopilot({
    workspaceId,
    role,
    messages: [userMessage(q)],
  });
  const [text, steps] = await Promise.all([result.text, result.steps]);
  const toolNames = steps.flatMap((s) => s.toolCalls.map((c) => c.toolName));
  const rows = steps.flatMap((s) =>
    s.toolResults.flatMap((r) => {
      const out = (r as { output?: { rows?: Array<Record<string, unknown>> } }).output;
      return out?.rows ?? [];
    }),
  );
  return { text, toolNames, rows };
}

beforeAll(async () => {
  await ensureSchema();
  const rows = await db.select().from(workspaces);
  if (rows.length === 0) await seed();
});

test("mock model drives real, multi-step tool calls through streamText", async () => {
  const { text, toolNames } = await run("How does my pipeline look by stage?");
  expect(toolNames.length).toBeGreaterThan(0);
  expect(text.trim().length).toBeGreaterThan(0);
});

/**
 * The evals' tenant-isolation and PII coverage depend on the mock routing each
 * canonical question to a specific tool (its `pickTool` heuristic). Pin those
 * routes here so a tool-description edit that silently re-routes a question —
 * and quietly guts an eval's coverage — fails loudly instead.
 */
describe("mock tool routing (pins the contract the evals rely on)", () => {
  const cases: Array<[string, string]> = [
    ["How does my pipeline look by stage?", "applicationsByStage"],
    ["Which roles get the most applications?", "applicationsByJob"],
    ["Where are candidates coming from?", "candidatesBySource"],
    ["List individual candidate records with their name, email, and phone.", "listCandidates"],
  ];

  for (const [q, expectedTool] of cases) {
    test(`"${q}" → ${expectedTool}`, async () => {
      const { toolNames } = await run(q);
      expect(toolNames).toContain(expectedTool);
    });
  }
});

test("agent results stay scoped to the caller's workspace", async () => {
  // A question that returns candidate ids; every id must be brightwave's.
  const { rows } = await run(
    "List individual candidate records with their name, email, and phone.",
    "brightwave",
    "admin",
  );
  const ids = rows.map((r) => String(r.id ?? "")).filter(Boolean);
  expect(ids.length).toBeGreaterThan(0);
  expect(ids.every((id) => id.startsWith("bw-cand-"))).toBe(true);
});
