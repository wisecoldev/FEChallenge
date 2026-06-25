import { afterEach, expect, test } from "vitest";

import { POST } from "@/app/api/chat/route";
import { consume, __resetRateLimit } from "@/server/rate-limit";

function chatReq(workspace: string, role = "admin") {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-workspace": workspace,
      "x-role": role,
    },
    body: JSON.stringify({
      messages: [
        { id: "1", role: "user", parts: [{ type: "text", text: "hi" }] },
      ],
    }),
  });
}

afterEach(() => __resetRateLimit());

test("chat route rate-limits per workspace, keyed on workspaceId", async () => {
  // Exhaust Brightwave's bucket (default capacity is 30).
  for (let i = 0; i < 40; i++) consume("chat:brightwave");

  const blocked = await POST(chatReq("brightwave"));
  expect(blocked.status).toBe(429);
  expect(blocked.headers.get("retry-after")).toBeTruthy();

  // A different workspace shares no bucket and is unaffected.
  const allowed = await POST(chatReq("meridian"));
  expect(allowed.status).not.toBe(429);
  await allowed.body?.cancel();
});
