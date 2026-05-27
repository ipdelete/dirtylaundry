import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

import type { TaskExecutor } from '@ianphil/ttasks-ts';

import { buildHarnessExecutor, materializeBatch } from './materialize.js';
import { detectCapabilities } from './capabilities.js';
import { collectObservations, type Observation } from './observe.js';
import {
  createPlanner,
  parsePlannerOutput,
  renderErrorFeedback,
  renderGoalMessage,
  renderObservationFeedback,
  type Planner,
} from './planner.js';
import { PlanRunner } from './runner.js';
import { RunsRecorder } from './runs-recorder.js';
import type { GraphSpec, Node } from './schema.js';
import { defaultRunsDbPath, openRunsStore } from './store.js';

export interface RunHarnessOptions {
  goal: string;
  maxTurns?: number;
  maxTotalTasks?: number;
  maxParseRetries?: number;
  interactive?: boolean;
  store?: 'sqlite' | 'none';
  storePath?: string;
  reasoningEffort?: string | null;
  log?: (line: string) => void;
}

export interface RunHarnessResult {
  status: 'done' | 'budget_exhausted' | 'parse_retries_exhausted' | 'aborted' | 'stalled';
  report?: string;
  turns: TurnSummary[];
  persistenceErrors: Array<{ kind: 'task' | 'graph'; id: string; error: string }>;
}

export interface TurnSummary {
  turn: number;
  kind: 'graph' | 'parse_error';
  rationale?: string;
  nodeCount?: number;
  batchCount?: number;
  parseError?: string;
  observations?: Observation[];
}

const DEFAULTS = {
  maxTurns: 6,
  maxTotalTasks: 64,
  maxParseRetries: 2,
};

export async function runHarness(options: RunHarnessOptions): Promise<RunHarnessResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const maxTurns = options.maxTurns ?? DEFAULTS.maxTurns;
  const maxTotalTasks = options.maxTotalTasks ?? DEFAULTS.maxTotalTasks;
  const maxParseRetries = options.maxParseRetries ?? DEFAULTS.maxParseRetries;
  const useStore = (options.store ?? 'sqlite') === 'sqlite';

  const storePath = options.storePath ?? defaultRunsDbPath();
  const store = useStore ? openRunsStore(storePath) : undefined;
  const recorder = useStore ? new RunsRecorder(storePath) : undefined;
  const capabilities = detectCapabilities();
  const executor: TaskExecutor = buildHarnessExecutor({ store, capabilities });
  const planner: Planner = createPlanner({ reasoningEffort: options.reasoningEffort });
  const runId = randomUUID();
  log(`run ${runId} (store: ${useStore ? storePath : 'none'})`);
  log(`host: ${capabilities.platform}, bash[${capabilities.effectiveBashAllowlist.size}/14] avail, journalctl=${capabilities.hasJournalctl}`);
  recorder?.recordRun({ runId, goal: options.goal, capabilities });

  const turns: TurnSummary[] = [];
  let totalTasks = 0;
  let nextInput = renderGoalMessage({ goal: options.goal, maxTurns, capabilities });
  let parseRetries = 0;

  const finalize = (status: RunHarnessResult['status'], report?: string): RunHarnessResult => {
    const persistenceErrors: RunHarnessResult['persistenceErrors'] = [
      ...executor.persistenceErrors.map((e) => ({ kind: 'task' as const, id: e.taskId, error: e.error.message })),
      ...executor.graphPersistenceErrors.map((e) => ({ kind: 'graph' as const, id: e.graphId, error: e.error.message })),
    ];
    recorder?.finishRun({ runId, status, report });
    recorder?.close();
    void executor.close().catch(() => undefined);
    try { store?.close(); } catch { /* ignore close errors */ }
    return { status, report, turns, persistenceErrors };
  };

  const onSigint = (): void => {
    log('SIGINT received; aborting planner...');
    planner.abort();
  };
  process.on('SIGINT', onSigint);

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      const remaining = maxTurns - turn - 1;
      log(`\n--- turn ${turn} (remaining after this: ${remaining}) ---`);

      const raw = await planner.next(nextInput);
      const parsed = parsePlannerOutput(raw);

      if (parsed.kind === 'error') {
        log(`planner parse error: ${parsed.error}`);
        turns.push({ turn, kind: 'parse_error', parseError: parsed.error });
        parseRetries++;
        if (parseRetries > maxParseRetries) {
          return finalize('parse_retries_exhausted');
        }
        nextInput = renderErrorFeedback(parsed.error, remaining);
        continue;
      }

      if (parsed.kind === 'done') {
        log('planner signaled done.');
        return finalize('done', parsed.report);
      }

      parseRetries = 0;
      const spec = parsed.spec;
      const planId = `${runId}:t${turn}`;
      recorder?.recordPlan({ planId, runId, turn, spec });
      log(`plan: ${spec.nodes.length} top-level nodes. rationale: ${spec.rationale}`);
      printPlan(spec, log);

      if (options.interactive && !(await confirmPlan())) {
        log('plan rejected by operator; ending run.');
        return finalize('aborted');
      }

      // Drain the plan: one PlanRunner per turn, possibly many batches.
      const planRunner = new PlanRunner(spec);
      const allObservations: Observation[] = [];
      let batchCount = 0;
      let budgetBlown = false;
      let stalled = false;

      while (!planRunner.done()) {
        const batch = planRunner.nextBatch();
        if (!batch) {
          log(`runner stalled with pending: ${planRunner.pending().join(', ')}`);
          stalled = true;
          break;
        }
        log(`  batch ${batch.index}: ${batch.tasks.length} tasks`);
        for (const bt of batch.tasks) {
          log(`    - ${bt.id} (${bt.leaf.type})${(bt.after ?? []).length ? ` after=[${bt.after!.join(',')}]` : ''}`);
        }

        totalTasks += batch.tasks.length;
        if (totalTasks > maxTotalTasks) {
          log(`total tasks ${totalTasks} exceeds budget ${maxTotalTasks}; ending run.`);
          budgetBlown = true;
          break;
        }

        const materialized = materializeBatch(
          batch,
          `${runId}/turn-${turn}/batch-${batch.index}`,
          { turn, rationale: spec.rationale, specId: `${planId}:b${batch.index}` },
        );
        await materialized.graph.run(executor);
        const observations = collectObservations(materialized);
        planRunner.recordObservations(observations);
        allObservations.push(...observations);
        batchCount++;
        printObservationSummary(observations, log);
      }

      turns.push({
        turn,
        kind: 'graph',
        rationale: spec.rationale,
        nodeCount: spec.nodes.length,
        batchCount,
        observations: allObservations,
      });

      const planStatus = budgetBlown ? 'budget_exhausted' : stalled ? 'stalled' : 'completed';
      recorder?.finishPlan({ planId, batchCount, status: planStatus });

      if (budgetBlown) {
        return finalize('budget_exhausted');
      }
      if (stalled) {
        return finalize('stalled');
      }
      if (remaining === 0) {
        log('turn budget reached without an explicit "done"; ending run.');
        return finalize('budget_exhausted');
      }
      nextInput = renderObservationFeedback({ observations: allObservations, remainingTurns: remaining });
    }
    return finalize('budget_exhausted');
  } finally {
    process.off('SIGINT', onSigint);
  }
}

function printPlan(spec: GraphSpec, log: (line: string) => void): void {
  for (const node of spec.nodes) printNode(node, '  ', log);
}

function printNode(node: Node, indent: string, log: (line: string) => void): void {
  const after = (node.after ?? []).length ? ` after=[${node.after!.join(',')}]` : '';
  if (node.type === 'if') {
    log(`${indent}- ${node.id} (if cond=${node.cond.kind}/${node.cond.task})${after}`);
    log(`${indent}  then:`);
    for (const c of node.then) printNode(c, indent + '    ', log);
    if (node.else && node.else.length) {
      log(`${indent}  else:`);
      for (const c of node.else) printNode(c, indent + '    ', log);
    }
    return;
  }
  if (node.type === 'foreach') {
    const items = node.over.kind === 'literal' ? node.over.items.length : '?';
    log(`${indent}- ${node.id} (foreach ${node.as} over ${items} items)${after}`);
    printNode(node.body, indent + '    ', log);
    return;
  }
  log(`${indent}- ${node.id} (${node.type})${after}: ${summarizeLeafPayload(node)}`);
}

function summarizeLeafPayload(node: Extract<Node, { type: 'bash' | 'read-log' | 'journal' | 'report' | 'note' }>): string {
  switch (node.type) {
    case 'bash':
      return `${node.payload.command} ${node.payload.args.join(' ')}`.trim();
    case 'read-log':
      return `${node.payload.path} tail=${node.payload.tailLines}${node.payload.grep ? ` grep="${node.payload.grep}"` : ''}`;
    case 'journal':
      return `since=${node.payload.since}${node.payload.priority ? ` priority=${node.payload.priority}` : ''}${node.payload.unit ? ` unit=${node.payload.unit}` : ''}`;
    case 'report':
      return `prompt: ${node.payload.prompt.slice(0, 80)}${node.payload.prompt.length > 80 ? '...' : ''}`;
    case 'note':
      return `"${node.payload.text.slice(0, 80)}${node.payload.text.length > 80 ? '...' : ''}"`;
  }
}

function printObservationSummary(observations: Observation[], log: (line: string) => void): void {
  for (const o of observations) {
    const flag = o.status === 'succeeded' ? 'ok' : o.status;
    log(`      [${flag}] ${o.id} ${o.title} (${o.durationMs}ms, ${o.output.totalLines} lines${o.output.truncated ? ', truncated' : ''})`);
    if (o.error) log(`          error: ${o.error.split('\n')[0]}`);
  }
}

async function confirmPlan(): Promise<boolean> {
  if (!process.stdin.isTTY) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Run this plan? [y/N] ')).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}
