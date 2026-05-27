import { GraphSpec, PlannerOutput, validateGraphSpec } from './harness/schema.js';
import { buildHarnessExecutor, materializeGraph } from './harness/materialize.js';
import { collectObservations } from './harness/observe.js';
import { openRunsStore } from './harness/store.js';

/**
 * Smoke test for harness steps 1-4:
 *   1. schema parse + structural validate
 *   2. materialize -> ttasks TaskGraph
 *   3. execute via registered handlers
 *   4. collect compact observations
 *
 * No planner LLM yet. The GraphSpec is hand-written below to look like
 * something the planner would emit on turn 1 of a log review run.
 */

const handCraftedSpec = {
  kind: 'graph',
  rationale: 'Sweep current state: uptime, failed units, hostname, recent journal warnings.',
  tasks: [
    { id: 'up', type: 'bash', title: 'uptime', payload: { command: 'uptime' } },
    { id: 'host', type: 'bash', title: 'hostnamectl', payload: { command: 'hostnamectl' } },
    { id: 'failed', type: 'bash', title: 'systemctl --failed', payload: { command: 'systemctl', args: ['--failed', '--no-pager'] } },
    { id: 'note1', type: 'note', title: 'plan', payload: { text: 'Phase 1: sweep system state.' }, after: [] },
    {
      id: 'journal-warn',
      type: 'journal',
      title: 'journal warnings 24h',
      payload: { since: '24 hours ago', priority: 'warning', maxLines: 200 },
    },
  ],
} as const;

const parsed = PlannerOutput.safeParse(handCraftedSpec);
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
console.log(`plan: ${spec.tasks.length} tasks, rationale="${spec.rationale}"`);

const store = openRunsStore();
const executor = buildHarnessExecutor({ store });
const materialized = materializeGraph(spec, 'smoke-graph', { turn: 0, rationale: spec.rationale, specId: 'smoke' });

await materialized.graph.run(executor);

const observations = collectObservations(materialized, { headLines: 8, tailLines: 8 });
console.log('\n=== observations ===');
console.log(JSON.stringify(observations, null, 2));

await executor.close();
store.close();
