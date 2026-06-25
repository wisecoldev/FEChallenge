/**
 * Role + column-permission model for the analytics copilot.
 *
 * The copilot serves users with different roles. Some candidate columns are PII
 * (name / email / phone) and must not be readable by every role: an `analyst`
 * may run analytics over candidates (counts, sources, timing) but must never
 * receive a candidate's identity.
 *
 * These are the PRIMITIVES. Enforcement lives in the query layer
 * (`src/db/analytics.ts`): candidate reads go through one role-aware projection
 * (`candidateColumns`) that selects a redaction literal in place of PII when the
 * caller isn't a PII reader — so a leaking query is never even *expressed* in
 * SQL, not filtered out after the fact. See `redactCandidates` there.
 */

export const ROLES = ["admin", "recruiter", "analyst"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** Default role when none is supplied on the request. */
export const DEFAULT_ROLE: Role = "admin";

/** Columns considered PII, keyed by table. Reading these requires a PII reader. */
export const PII_COLUMNS: Record<string, readonly string[]> = {
  candidates: ["name", "email", "phone"],
};

/**
 * Roles allowed to read candidate PII. An `analyst` is intentionally excluded;
 * `recruiter` and `admin` work the pipeline and may see who a candidate is.
 */
const PII_READERS: ReadonlySet<Role> = new Set<Role>(["admin", "recruiter"]);

/** Whether `role` may read candidate PII (name / email / phone). */
export function canReadPII(role: Role): boolean {
  return PII_READERS.has(role);
}

/**
 * Whether `role` may read `table.column`. PII columns require a PII reader;
 * everything else is readable. Used as the single source of truth the query
 * layer consults when it builds a candidate projection.
 */
export function canReadColumn(role: Role, table: string, column: string): boolean {
  const pii = PII_COLUMNS[table];
  if (pii?.includes(column)) return canReadPII(role);
  return true;
}

/** Value returned in place of a PII field the caller isn't permitted to read. */
export const REDACTED = "[redacted]" as const;
