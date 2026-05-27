import { randomUUID } from 'node:crypto';

import { detectCapabilities } from './harness/capabilities.js';
import { buildHarnessExecutor, materializeBatch } from './harness/materialize.js';
import { collectObservations, type Observation } from './harness/observe.js';
import { PlanRunner } from './harness/runner.js';
import { GraphSpec, PlannerOutput, validateGraphSpec } from './harness/schema.js';
import { openRunsStore } from './harness/store.js';

/**
 * Smoke test for the harness end-to-end (no LLM).
 *
 * Hand-writes a GraphSpec that exercises:
 *   - leaf nodes (bash, journal, note, report)
 *   - foreach with literal items (parallel fanout)
 *   - if with a task_status condition (resolved between batches)
 *
 * The PlanRunner drains the plan into batches; each batch is materialized
 * and executed by ttasks.
 */

const handCrafted = {
  kind: 'graph',
  rationale:
    'Sweep state, probe per-service status, branch on whether any units failed, then synthesize.',
  nodes: [
    { id: 'host', type: 'bash', title: 'hostnamectl', payload: { command: 'hostnamectl' } },
    {
      id: 'failed',
      type: 'bash',
      title: 'systemctl --failed',
      payload: { command: 'systemctl', args: ['--failed', '--no-pager'] },
    },
    {
      id: 'svc',
      type: 'foreach',
      as: 'unit',
      over: { kind: 'literal', items: ['ssh', 'cron'] },
      body: {
        id: 'status',
        type: 'bash',
        title: 'systemctl is-active ${unit}',
        payload: { command: 'systemctl', args: ['is-active', '${unit}'] },
      },
    },
    {
      id: 'maybe-journal',
      type: 'if',
      cond: { kind: 'task_status', task: 'failed', equals: 'succeeded' },
      then: [
        {
          id: 'journal-warn',
          type: 'journal',
          title: 'recent warnings',
          payload: { since: '1 hour ago', priority: 'warning', maxLines: 100 },
        },
      ],
      else: [
        {
          id: 'no-failed-note',
          type: 'note',
          payload: { text: 'failed-units probe itself failed; skipped journal sweep.' },
        },
      ],
    },
    {
      id: 'summary',
      type: 'report',
      after: ['host', 'svc', 'maybe-journal'],
      payload: {
        prompt:
          'Write 3 concise bullets covering: host identity, per-service status, and whether any units failed. No filler.',
      },
    },
  ],
} as const;

const parsed = PlannerOutput.safeParse(handCrafted);
if (!parsed.success) {
  console.error('schema parse failed:');
  console.error(parsed.error.issues);
  process.exit(1);
}
if (parsed.data.kind !== 'graph') {
  console.error('expected a graph plan, got a done signal');
  process.exit(1);
}
const spec: GraphSpec = parsed.data;
const structural = validateGraphSpec(spec);
if (!structural.ok) {
  console.error(`structural validation failed: ${structural.error}`);
  process.exit(1);
}
console.log(`plan: ${spec.nodes.length} top-level nodes, rationale="${spec.rationale}"`);

const runId = randomUUID();
const capabilities = detectCapabilities();
console.log(`host: ${capabilities.platform}, bash[${capabilities.effectiveBashAllowlist.size}/14] avail, journalctl=${capabilities.hasJournalctl}`);

const store = openRunsStore();
const executor = buildHarnessExecutor({ store, capabilities });
const runner = new PlanRunner(spec);

const allObservations: Observation[] = [];
while (!runner.done()) {
  const batch = runner.nextBatch();
  if (!batch) {
    console.error(`runner stalled with pending: ${runner.pending().join(', ')}`);
    break;
  }
  console.log(`\n--- batch ${batch.index} (${batch.tasks.length} tasks) ---`);
  for (const bt of batch.tasks) {
    console.log(`  - ${bt.id} (${bt.leaf.type})${(bt.after ?? []).length ? ` after=[${bt.after!.join(',')}]` : ''}`);
  }
  const materialized = materializeBatch(batch, `${runId}/batch-${batch.index}`, {
    turn: batch.index,
    rationale: batch.rationale,
    specId: `${runId}:b${batch.index}`,
  });
  await materialized.graph.run(executor);
  const observations = collectObservations(materialized, { headLines: 4, tailLines: 4 });
  for (const o of observations) {
    const flag = o.status === 'succeeded' ? 'ok' : o.status;
    console.log(`    [${flag}] ${o.id} (${o.durationMs}ms, ${o.output.totalLines} lines)`);
  }
  runner.recordObservations(observations);
  allObservations.push(...observations);
}

console.log(`\nrun complete: ${allObservations.length} leaves executed.`);

await executor.close();
store.close();
