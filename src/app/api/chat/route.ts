import type { UIMessage } from "ai";

import { streamCopilot } from "@/agent/run";
import { tenantFromHeaders } from "@/server/context";
import { consume } from "@/server/rate-limit";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { workspaceId, role } = tenantFromHeaders(req);

  // Per-workspace rate limit so one tenant can't starve the shared model + DB.
  const verdict = consume(`chat:${workspaceId}`);
  if (!verdict.ok) {
    const retryAfter = Math.ceil(verdict.retryAfterMs / 1000);
    return new Response(
      JSON.stringify({ error: "Rate limit exceeded. Please slow down." }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": String(retryAfter),
        },
      },
    );
  }

  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = await streamCopilot({ workspaceId, role, messages });
  return result.toUIMessageStreamResponse({
    // Don't leak provider internals to the client; log server-side via run.ts.
    onError: () =>
      "The copilot hit an error answering that. Please try again.",
  });
}
