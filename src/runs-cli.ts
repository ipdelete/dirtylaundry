import { RunsReader, type PlanRow, type RunRow, type TaskRow } from './harness/runs-recorder.js';
import { defaultRunsDbPath } from './harness/store.js';
import type { GraphSpec, Node } from './harness/schema.js';

/**
 * `dirtylaundry runs ...` inspector. Reads runs.db only — no LLM, no execution.
 *
 * Subcommands:
 *   runs list                          — recent runs
 *   runs show <runId> [--full]         — plans, batches, task tree for one run
 *   runs plan <planId> [--full]        — one plan with its task tree
 */

export async function runsCli(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '-h' || sub === '--help') {
    printHelp();
    return 0;
  }

  const dbPath = process.env.DIRTYLAUNDRY_RUNS_DB ?? defaultRunsDbPath();
  const reader = new RunsReader(dbPath);
  try {
    switch (sub) {
      case 'list':
        return cmdList(reader, argv.slice(1));
      case 'show':
        return cmdShow(reader, argv.slice(1));
      case 'plan':
        return cmdPlan(reader, argv.slice(1));
      default:
        console.error(`unknown subcommand: ${sub}`);
        printHelp();
        return 2;
    }
  } finally {
    reader.close();
  }
}

function printHelp(): void {
  console.log('Usage:');
  console.log('  dirtylaundry runs list [--limit N]');
  console.log('  dirtylaundry runs show <runId|prefix> [--full]');
  console.log('  dirtylaundry runs plan <planId|prefix> [--full]');
  console.log('');
  console.log('  --full   include full task outputs (else head/tail summary)');
}

// ---- list ----

function cmdList(reader: RunsReader, args: string[]): number {
  const idx = args.indexOf('--limit');
  const limit = idx >= 0 && args[idx + 1] ? Number(args[idx + 1]) : 20;
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
  const rows = reader.listRuns(n);
  if (rows.length === 0) {
    console.log('(no runs recorded yet)');
    return 0;
  }
  console.log(pad('RUN', 38) + pad('STATUS', 22) + pad('STARTED', 22) + 'GOAL');
  for (const r of rows) {
    const goal = r.goal.replace(/\s+/g, ' ').slice(0, 60);
    console.log(
      pad(r.id, 38) +
        pad(r.status ?? '(in-progress)', 22) +
        pad(r.started_at.replace('T', ' ').replace(/\..*$/, ''), 22) +
        goal,
    );
  }
  return 0;
}

// ---- show ----

function cmdShow(reader: RunsReader, args: string[]): number {
  const idOrPrefix = args[0];
  if (!idOrPrefix) {
    console.error('runs show requires a runId (full or unique prefix)');
    return 2;
  }
  const full = args.includes('--full');
  const run = resolveRun(reader, idOrPrefix);
  if (!run) return 1;

  printRunHeader(run);
  const plans = reader.plansForRun(run.id);
  if (plans.length === 0) {
    console.log('\n(no plans recorded for this run)');
  } else {
    for (const plan of plans) printPlan(reader, plan, full);
  }
  if (run.report) {
    console.log('\n--- final report ---');
    console.log(run.report);
  }
  return 0;
}

// ---- plan ----

function cmdPlan(reader: RunsReader, args: string[]): number {
  const idOrPrefix = args[0];
  if (!idOrPrefix) {
    console.error('runs plan requires a planId');
    return 2;
  }
  const full = args.includes('--full');
  // planId format: <runId>:t<N>. Accept prefix match on planId itself.
  const plan = uniqueByPrefix(
    reader.listRuns(500).flatMap((r) => reader.plansForRun(r.id))
      .filter((p) => p.id === idOrPrefix || p.id.startsWith(idOrPrefix)),
    'plan',
    idOrPrefix,
  );
  if (!plan) return 1;
  printPlan(reader, plan, full);
  return 0;
}

// ---- helpers ----

function resolveRun(reader: RunsReader, idOrPrefix: string): RunRow | null {
  return reader.getRun(idOrPrefix) ?? uniqueByPrefix(
    reader.listRuns(500).filter((r) => r.id.startsWith(idOrPrefix)),
    'run',
    idOrPrefix,
  );
}

function uniqueByPrefix<T extends { id: string }>(matches: readonly T[], kind: string, idOrPrefix: string): T | null {
  if (matches.length === 0) {
    console.error(`no ${kind} matches ${idOrPrefix}`);
    return null;
  }
  if (matches.length > 1) {
    console.error(`ambiguous ${kind} id; ${matches.length} matches:`);
    for (const m of matches) console.error(`  ${m.id}`);
    return null;
  }
  return matches[0];
}

function printRunHeader(run: RunRow): void {
  const allowlist = JSON.parse(run.bash_allowlist) as string[];
  console.log(`run ${run.id}`);
  console.log(`  goal:     ${run.goal}`);
  console.log(`  status:   ${run.status ?? '(in-progress)'}`);
  console.log(`  started:  ${run.started_at}`);
  if (run.finished_at) console.log(`  finished: ${run.finished_at}`);
  console.log(`  host:     ${run.host_platform}  bash[${allowlist.length}] journalctl=${run.journalctl_available ? 'yes' : 'no'}`);
}

function printPlan(reader: RunsReader, plan: PlanRow, full: boolean): void {
  console.log(`\n=== plan ${plan.id} (turn ${plan.turn}, ${plan.batch_count} batches, ${plan.status}) ===`);
  console.log(`rationale: ${plan.rationale}`);
  const spec = JSON.parse(plan.spec_json) as GraphSpec;
  console.log('plan shape:');
  for (const node of spec.nodes) printNodeTree(node, '  ');

  const tasks = reader.tasksForPlan(plan.id);
  if (tasks.length === 0) {
    console.log('(no tasks recorded — plan may not have executed yet)');
    return;
  }
  // group tasks by batch index parsed from metadata.specId
  const byBatch = new Map<number, TaskRow[]>();
  for (const t of tasks) {
    const meta = safeParse(t.metadata_json) as Record<string, unknown> | null;
    const m = String(meta?.specId ?? '').match(/:b(\d+)$/);
    const batch = m ? Number(m[1]) : -1;
    const list = byBatch.get(batch);
    if (list) list.push(t); else byBatch.set(batch, [t]);
  }
  for (const b of Array.from(byBatch.keys()).sort((x, y) => x - y)) {
    console.log(`\nbatch ${b}:`);
    for (const t of byBatch.get(b)!) printTask(t, full);
  }
}

function printNodeTree(node: Node, indent: string): void {
  const after = (node.after ?? []).length ? ` after=[${node.after!.join(',')}]` : '';
  if (node.type === 'if') {
    console.log(`${indent}- ${node.id} [if cond=${node.cond.kind}/${node.cond.task}]${after}`);
    console.log(`${indent}  then:`);
    for (const c of node.then) printNodeTree(c, indent + '    ');
    if (node.else && node.else.length) {
      console.log(`${indent}  else:`);
      for (const c of node.else) printNodeTree(c, indent + '    ');
    }
    return;
  }
  if (node.type === 'foreach') {
    const items = node.over.kind === 'literal' ? node.over.items.length : '?';
    console.log(`${indent}- ${node.id} [foreach ${node.as} over ${items} items]${after}`);
    printNodeTree(node.body, indent + '    ');
    return;
  }
  console.log(`${indent}- ${node.id} [${node.type}]${after}`);
}

function printTask(t: TaskRow, full: boolean): void {
  const result = safeParse(t.result_json) as { output?: string; duration?: number; returncode?: number; error?: string } | null;
  const meta = safeParse(t.metadata_json) as Record<string, unknown> | null;
  const specTaskId = (meta?.specTaskId as string | undefined) ?? t.id;
  const flag = t.status === 'succeeded' ? 'ok' : t.status;
  const dur = result?.duration !== undefined ? `${Math.round(result.duration)}ms` : '-';
  const rc = result?.returncode !== undefined ? `rc=${result.returncode}` : '';
  console.log(`  [${flag}] ${specTaskId} (${t.type}) ${dur} ${rc} — ${t.title}`);
  if (t.error) console.log(`        error: ${t.error.split('\n')[0]}`);
  const output = result?.output ?? '';
  if (output) {
    if (full) {
      const indented = output.split('\n').map((l) => `        ${l}`).join('\n');
      console.log(indented);
    } else {
      const lines = output.replace(/\r\n/g, '\n').split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      const HEAD = 4;
      const TAIL = 4;
      if (lines.length <= HEAD + TAIL) {
        for (const l of lines) console.log(`        ${l}`);
      } else {
        for (const l of lines.slice(0, HEAD)) console.log(`        ${l}`);
        console.log(`        ... (${lines.length - HEAD - TAIL} more lines)`);
        for (const l of lines.slice(-TAIL)) console.log(`        ${l}`);
      }
    }
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n - 1) + ' ' : s.padEnd(n);
}

function safeParse(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
