import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type LanguageModel,
  type UIMessage,
} from "ai";

import { ensureSchema } from "@/db/client";
import type { Role } from "@/db/permissions";
import { buildTools } from "./tools";
import { getModel, SYSTEM_PROMPT } from "./provider";

/** Default cap on agent steps (orient → query → answer, with room to recover). */
export const MAX_STEPS = 6;

/**
 * Runs the analytics copilot for one turn and RETURNS the `streamText` result.
 *
 * The caller decides what to do with it:
 *   - the chat route calls `.toUIMessageStreamResponse()`
 *   - evals/tests `await result.steps` / `.toolCalls` / `.text`
 *
 * Loop control:
 *   - `stopWhen: stepCountIs(MAX_STEPS)` bounds the orient→query→answer loop so a
 *     confused model can't spin. The agent typically takes 2 steps (call a tool,
 *     then summarize); the headroom lets it chain a second query or recover from
 *     a tool error before answering.
 *   - Tool errors don't crash the turn. The AI SDK turns a thrown tool `execute`
 *     into a `tool-error` result and feeds it back to the model, so the agent can
 *     apologize or try a different tool instead of 500-ing the request.
 *   - `onError` surfaces provider/stream-level failures in the server log without
 *     leaking internals to the client (the route maps them to a safe message).
 */
export async function streamCopilot({
  workspaceId,
  role,
  messages,
  model = getModel(),
  maxSteps = MAX_STEPS,
}: {
  workspaceId: string;
  role: Role;
  messages: UIMessage[];
  /** Override the model — e.g. wrap it with evalite's wrapAISDKModel in evals. */
  model?: LanguageModel;
  /** Override the step cap (tests/evals). */
  maxSteps?: number;
}) {
  await ensureSchema();

  return streamText({
    model,
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages),
    // ctx (workspaceId + role) is bound into the tools here, never taken as a
    // model-fillable input — the model can't reach another tenant or widen its
    // own role by filling a field.
    tools: buildTools({ workspaceId, role }),
    stopWhen: stepCountIs(maxSteps),
    onError({ error }) {
      console.error("[copilot] stream error:", error);
    },
  });
}
