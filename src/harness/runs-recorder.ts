import { DatabaseSync } from 'node:sqlite';

import type { GraphSpec } from './schema.js';
import type { HostCapabilities } from './capabilities.js';
import type { Observation } from './observe.js';

/**
 * RunsRecorder — augments the ttasks SqliteStore with two extra tables so we
 * can reconstruct *what was planned*, not just *what executed*.
 *
 * ttasks owns: tasks, graphs, graph_members, graph_edges, meta.
 * We add:      runs, plans.
 *
 * Same SQLite file. Opening a second connection is safe because SQLite
 * serializes writes; ttasks' inserts and ours interleave fine. The
 * ttasks SqliteStore stays the source of truth for task execution state;
 * runs/plans are pure planner-side context.
 */

const DDL = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT,
  report TEXT,
  host_platform TEXT NOT NULL,
  bash_allowlist TEXT NOT NULL,
  journalctl_available INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  rationale TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  batch_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_plans_run ON plans(run_id);
`;

export interface RecordRunOptions {
  runId: string;
  goal: string;
  capabilities: HostCapabilities;
}

export interface FinishRunOptions {
  runId: string;
  status: string;
  report?: string;
}

export interface RecordPlanOptions {
  planId: string; // we use the existing specId format `${runId}:t${turn}`
  runId: string;
  turn: number;
  spec: GraphSpec;
}

export interface FinishPlanOptions {
  planId: string;
  batchCount: number;
  status: 'completed' | 'stalled' | 'budget_exhausted';
}

export class RunsRecorder {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec(DDL);
  }

  recordRun(options: RecordRunOptions): void {
    const stmt = this.db.prepare(
      `INSERT INTO runs (id, goal, started_at, host_platform, bash_allowlist, journalctl_available)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      options.runId,
      options.goal,
      new Date().toISOString(),
      options.capabilities.platform,
      JSON.stringify(Array.from(options.capabilities.effectiveBashAllowlist).sort()),
      options.capabilities.hasJournalctl ? 1 : 0,
    );
  }

  finishRun(options: FinishRunOptions): void {
    const stmt = this.db.prepare(
      `UPDATE runs SET finished_at = ?, status = ?, report = ? WHERE id = ?`,
    );
    stmt.run(new Date().toISOString(), options.status, options.report ?? null, options.runId);
  }

  recordPlan(options: RecordPlanOptions): void {
    const stmt = this.db.prepare(
      `INSERT INTO plans (id, run_id, turn, created_at, rationale, spec_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      options.planId,
      options.runId,
      options.turn,
      new Date().toISOString(),
      options.spec.rationale,
      JSON.stringify(options.spec),
    );
  }

  finishPlan(options: FinishPlanOptions): void {
    const stmt = this.db.prepare(
      `UPDATE plans SET batch_count = ?, status = ? WHERE id = ?`,
    );
    stmt.run(options.batchCount, options.status, options.planId);
  }

  close(): void {
    try { this.db.close(); } catch {}
  }
}

// ---- read-side helpers used by the `runs` inspector CLI ----

export interface RunRow {
  id: string;
  goal: string;
  started_at: string;
  finished_at: string | null;
  status: string | null;
  report: string | null;
  host_platform: string;
  bash_allowlist: string;
  journalctl_available: number;
}

export interface PlanRow {
  id: string;
  run_id: string;
  turn: number;
  created_at: string;
  rationale: string;
  spec_json: string;
  batch_count: number;
  status: string;
}

export interface TaskRow {
  id: string;
  type: string;
  title: string;
  status: string;
  error: string | null;
  result_json: string | null;
  metadata_json: string;
}

/** Read-only view onto the same SQLite file. Used by the inspector. */
export class RunsReader {
  private readonly db: DatabaseSync;
  private readonly hasOurTables: boolean;

  constructor(path: string) {
    this.db = new DatabaseSync(path, { readOnly: true });
    this.hasOurTables = this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('runs','plans')`).all().length === 2;
  }

  listRuns(limit = 20): RunRow[] {
    if (!this.hasOurTables) return [];
    return this.db
      .prepare(
        `SELECT id, goal, started_at, finished_at, status, report, host_platform, bash_allowlist, journalctl_available
         FROM runs ORDER BY started_at DESC LIMIT ?`,
      )
      .all(limit) as unknown as RunRow[];
  }

  getRun(runId: string): RunRow | null {
    if (!this.hasOurTables) return null;
    const row = this.db
      .prepare(
        `SELECT id, goal, started_at, finished_at, status, report, host_platform, bash_allowlist, journalctl_available
         FROM runs WHERE id = ?`,
      )
      .get(runId);
    return (row as unknown as RunRow) ?? null;
  }

  plansForRun(runId: string): PlanRow[] {
    if (!this.hasOurTables) return [];
    return this.db
      .prepare(
        `SELECT id, run_id, turn, created_at, rationale, spec_json, batch_count, status
         FROM plans WHERE run_id = ? ORDER BY turn ASC`,
      )
      .all(runId) as unknown as PlanRow[];
  }

  tasksForPlan(planId: string): TaskRow[] {
    // tasks store the planId under metadata_json.specId.
    return this.db
      .prepare(
        `SELECT id, type, title, status, error, result_json, metadata_json
         FROM tasks
         WHERE json_extract(metadata_json, '$.specId') LIKE ?
         ORDER BY insert_order ASC`,
      )
      .all(`${planId}:%`) as unknown as TaskRow[];
  }

  close(): void {
    try { this.db.close(); } catch {}
  }
}
