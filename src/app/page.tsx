"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { ROLES, REDACTED } from "@/db/permissions";
import type { Display, Row } from "@/agent/artifact";
import {
  getActiveRole,
  getActiveWorkspace,
  useTenant,
  useTRPC,
} from "./providers";

const SUGGESTIONS = [
  "How does my pipeline look by stage?",
  "Where are candidates coming from?",
  "Which roles get the most applicants?",
  "How long does it take to hire?",
];

export default function Page() {
  const { activeWorkspace, setActiveWorkspace, role, setRole } = useTenant();
  const trpc = useTRPC();

  const workspaces = useQuery(trpc.workspaces.list.queryOptions());
  const pipeline = useQuery(trpc.analytics.applicationsByStage.queryOptions({}));

  // A fresh transport per active workspace/role so the `x-workspace` + `x-role`
  // headers follow the switchers. Keying useChat on them also resets the
  // conversation when you switch tenant or role.
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        headers: () => ({
          "x-workspace": getActiveWorkspace(),
          "x-role": getActiveRole(),
        }),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeWorkspace, role],
  );

  const { messages, sendMessage, status, error } = useChat({
    id: `${activeWorkspace}:${role}`,
    transport,
  });

  const [input, setInput] = useState("");
  const busy = status === "streaming" || status === "submitted";

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    sendMessage({ text: trimmed });
    setInput("");
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    send(input);
  }

  return (
    <main className="mx-auto grid h-screen max-w-6xl grid-cols-[1fr_320px] gap-4 p-4">
      {/* Conversation column */}
      <section className="flex min-h-0 flex-col rounded-lg border border-gray-200 bg-white shadow-sm">
        <header className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <div>
            <h1 className="text-lg font-semibold">ATS Analytics Copilot</h1>
            <p className="text-xs text-gray-500">
              Chat with this workspace&rsquo;s recruiting data.
            </p>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <label className="flex items-center gap-1.5">
              <span className="text-gray-500">Workspace</span>
              <select
                className="rounded border border-gray-300 px-2 py-1 text-sm"
                value={activeWorkspace}
                onChange={(e) => setActiveWorkspace(e.target.value)}
              >
                {workspaces.data?.map((w) => (
                  <option key={w.id} value={w.slug}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-gray-500">Role</span>
              <select
                className="rounded border border-gray-300 px-2 py-1 text-sm"
                value={role}
                onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {messages.length === 0 && (
            <div className="space-y-3">
              <p className="text-sm text-gray-400">
                Ask about this workspace&rsquo;s recruiting data. Try:
              </p>
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-xs text-gray-600 transition hover:border-indigo-300 hover:text-indigo-700"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((message) => (
            <Message key={message.id} message={message} />
          ))}

          {busy && (
            <p className="flex items-center gap-2 text-xs text-gray-400">
              <Spinner /> Copilot is working&hellip;
            </p>
          )}
          {error && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">
              Something went wrong. Please try again.
            </p>
          )}
        </div>

        <form
          onSubmit={submit}
          className="flex items-center gap-2 border-t border-gray-200 px-4 py-3"
        >
          <input
            className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none"
            placeholder="Ask the analytics copilot…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-gray-900 px-4 py-2 text-sm font-medium text-white transition disabled:opacity-50"
          >
            Send
          </button>
        </form>
      </section>

      {/* Side panel: a reference scoped read via tRPC (pipeline by stage). */}
      <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto">
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold">Pipeline (this workspace)</h2>
          {pipeline.data && pipeline.data.length > 0 ? (
            <BarChart
              rows={pipeline.data as Row[]}
              x="stage"
              y="count"
            />
          ) : (
            <Empty>No data.</Empty>
          )}
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 text-xs text-gray-500 shadow-sm">
          <p className="mb-1 font-semibold text-gray-600">Viewing as</p>
          <p>
            <span className="font-medium text-gray-800">{activeWorkspace}</span>{" "}
            &middot; role <span className="font-medium text-gray-800">{role}</span>
          </p>
          <p className="mt-2 leading-relaxed">
            Switch role to <span className="font-medium">analyst</span> and ask to
            list candidates — contact details come back redacted.
          </p>
        </div>
      </aside>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Message + tool-call rendering
// ---------------------------------------------------------------------------

type AnyMessage = {
  id: string;
  role: string;
  parts: Array<{ type: string } & Record<string, unknown>>;
};

function Message({ message }: { message: AnyMessage }) {
  const isUser = message.role === "user";
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium uppercase tracking-wide text-gray-400">
        {message.role}
      </div>
      {message.parts.map((part, i) => {
        if (part.type === "text") {
          return (
            <p
              key={i}
              className={`whitespace-pre-wrap rounded-md px-3 py-2 text-sm ${
                isUser ? "bg-indigo-50 text-indigo-900" : "bg-gray-50 text-gray-800"
              }`}
            >
              {String((part as { text?: string }).text ?? "")}
            </p>
          );
        }
        if (part.type.startsWith("tool-")) {
          return <ToolCall key={i} part={part} />;
        }
        return null;
      })}
    </div>
  );
}

type ToolPart = {
  type: string;
  state?: string;
  input?: unknown;
  output?: { rows?: Row[]; display?: Display };
  errorText?: string;
};

function ToolCall({ part }: { part: unknown }) {
  const p = part as ToolPart;
  const name = p.type.replace(/^tool-/, "");
  const done = p.state === "output-available";
  const errored = p.state === "output-error";

  return (
    <div className="rounded-md border border-gray-200 bg-white px-3 py-2 text-xs">
      <div className="flex items-center gap-1.5 font-medium text-gray-600">
        <ToolIcon />
        {name}
        <span className="font-normal text-gray-400">
          {errored ? (
            "· error"
          ) : done ? (
            "· result"
          ) : (
            <span className="inline-flex items-center gap-1">
              <Spinner /> calling…
            </span>
          )}
        </span>
      </div>
      {errored && <p className="mt-1 text-red-500">{p.errorText ?? "Tool failed."}</p>}
      {done && <Artifact output={p.output} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Generative UI: render rows according to the tool's `display` hint.
// ---------------------------------------------------------------------------

function Artifact({ output }: { output?: { rows?: Row[]; display?: Display } }) {
  const rows = output?.rows ?? [];
  const display = output?.display;
  if (rows.length === 0) return <Empty className="mt-1">No rows.</Empty>;

  if (display?.kind === "bar") {
    return <BarChart rows={rows} x={display.x} y={display.y} title={display.title} />;
  }
  if (display?.kind === "line") {
    return <LineChart rows={rows} x={display.x} y={display.y} title={display.title} />;
  }
  const columns =
    display?.kind === "table" ? display.columns : Object.keys(rows[0]);
  return <DataTable rows={rows} columns={columns} />;
}

function BarChart({
  rows,
  x,
  y,
  title,
}: {
  rows: Row[];
  x: string;
  y: string;
  title?: string;
}) {
  const data = rows.map((r) => ({
    label: String(r[x] ?? ""),
    value: Number(r[y] ?? 0),
  }));
  const max = Math.max(1, ...data.map((d) => d.value));

  return (
    <figure className="mt-2 space-y-1.5">
      {title && (
        <figcaption className="text-xs font-medium text-gray-600">{title}</figcaption>
      )}
      <div className="space-y-1">
        {data.map((d, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className="w-28 shrink-0 truncate text-gray-500" title={d.label}>
              {d.label}
            </span>
            <div className="relative h-4 flex-1 rounded bg-gray-100">
              <div
                className="absolute inset-y-0 left-0 rounded bg-indigo-500 transition-[width] duration-500"
                style={{ width: `${(d.value / max) * 100}%` }}
              />
            </div>
            <span className="w-10 shrink-0 text-right tabular-nums text-gray-700">
              {d.value}
            </span>
          </div>
        ))}
      </div>
    </figure>
  );
}

function LineChart({
  rows,
  x,
  y,
  title,
}: {
  rows: Row[];
  x: string;
  y: string;
  title?: string;
}) {
  const data = rows.map((r) => ({
    label: String(r[x] ?? ""),
    value: Number(r[y] ?? 0),
  }));
  if (data.length === 0) return <Empty className="mt-1">No rows.</Empty>;

  const W = 280;
  const H = 80;
  const PAD = 6;
  const max = Math.max(1, ...data.map((d) => d.value));
  const stepX = data.length > 1 ? (W - PAD * 2) / (data.length - 1) : 0;
  const points = data.map((d, i) => {
    const px = PAD + i * stepX;
    const py = H - PAD - (d.value / max) * (H - PAD * 2);
    return [px, py] as const;
  });
  const line = points
    .map(([px, py], i) => `${i === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`)
    .join(" ");
  const area = `${line} L${points[points.length - 1][0].toFixed(1)},${H - PAD} L${PAD},${H - PAD} Z`;

  return (
    <figure className="mt-2">
      {title && (
        <figcaption className="mb-1 text-xs font-medium text-gray-600">
          {title}
        </figcaption>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={title ?? "trend"}>
        <path d={area} fill="rgb(99 102 241 / 0.1)" />
        <path d={line} fill="none" stroke="rgb(99 102 241)" strokeWidth="1.5" />
        {points.map(([px, py], i) => (
          <circle key={i} cx={px} cy={py} r="1.8" fill="rgb(99 102 241)">
            <title>{`${data[i].label}: ${data[i].value}`}</title>
          </circle>
        ))}
      </svg>
      <div className="flex justify-between text-[10px] text-gray-400">
        <span>{data[0].label}</span>
        <span>{data[data.length - 1].label}</span>
      </div>
    </figure>
  );
}

function DataTable({ rows, columns }: { rows: Row[]; columns: string[] }) {
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs">
        <thead>
          <tr className="text-gray-400">
            {columns.map((c) => (
              <th key={c} className="border-b border-gray-100 py-1 pr-3 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 12).map((row, i) => (
            <tr key={i} className="text-gray-700">
              {columns.map((c) => (
                <td key={c} className="border-b border-gray-50 py-1 pr-3">
                  <Cell value={row[c]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 12 && (
        <p className="mt-1 text-[10px] text-gray-400">
          Showing 12 of {rows.length} rows.
        </p>
      )}
    </div>
  );
}

/** Render a cell, flagging redacted PII so the permission gate is visible. */
function Cell({ value }: { value: unknown }) {
  if (value === REDACTED) {
    return (
      <span className="italic text-gray-400" title="Hidden for your role">
        redacted
      </span>
    );
  }
  return <>{String(value ?? "")}</>;
}

// ---------------------------------------------------------------------------
// Small primitives
// ---------------------------------------------------------------------------

function Empty({
  children,
  className = "",
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return <p className={`text-xs text-gray-400 ${className}`}>{children ?? "No data."}</p>;
}

function Spinner() {
  return (
    <span className="inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-gray-300 border-t-indigo-500" />
  );
}

function ToolIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="text-indigo-500"
      aria-hidden
    >
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.3L3 18v3h3l6.4-6.3a4 4 0 0 0 5.3-5.4l-2.6 2.6-2-2 2.3-2.2Z" />
    </svg>
  );
}
