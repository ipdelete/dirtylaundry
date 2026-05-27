import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

import type { TaskExecutor } from '@ianphil/ttasks-ts';

import { buildHarnessExecutor, materializeGraph } from './materialize.js';
import { collectObservations, type Observation } from './observe.js';
import {
  createPlanner,
  parsePlannerOutput,
  renderErrorFeedback,
  renderGoalMessage,
  renderObservationFeedback,
  type Planner,
} from './planner.js';
import type { GraphSpec } from './schema.js';
import { openRunsStore } from './store.js';

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
  status: 'done' | 'budget_exhausted' | 'parse_retries_exhausted' | 'aborted';
  report?: string;
  turns: TurnSummary[];
  persistenceErrors: Array<{ kind: 'task' | 'graph'; id: string; error: string }>;
}

export interface TurnSummary {
  turn: number;
  kind: 'graph' | 'parse_error';
  rationale?: string;
  taskCount?: number;
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

  const store = useStore ? openRunsStore(options.storePath) : undefined;
  const executor: TaskExecutor = buildHarnessExecutor({ store });
  const planner: Planner = createPlanner({ reasoningEffort: options.reasoningEffort });
  const runId = randomUUID();
  log(`run ${runId} (store: ${useStore ? options.storePath ?? 'default' : 'none'})`);

  const turns: TurnSummary[] = [];
  let totalTasks = 0;
  let nextInput = renderGoalMessage({ goal: options.goal, maxTurns });
  let parseRetries = 0;

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
          return finalize('parse_retries_exhausted', undefined, turns, executor, store);
        }
        nextInput = renderErrorFeedback(parsed.error, remaining);
        continue;
      }

      if (parsed.kind === 'done') {
        log('planner signaled done.');
        return finalize('done', parsed.report, turns, executor, store);
      }

      parseRetries = 0;
      const spec = parsed.spec;
      log(`plan: ${spec.tasks.length} tasks. rationale: ${spec.rationale}`);
      printPlan(spec, log);

      if (options.interactive && !(await confirmPlan(spec))) {
        log('plan rejected by operator; ending run.');
        return finalize('aborted', undefined, turns, executor, store);
      }

      totalTasks += spec.tasks.length;
      if (totalTasks > maxTotalTasks) {
        log(`total tasks ${totalTasks} exceeds budget ${maxTotalTasks}; ending run.`);
        return finalize('budget_exhausted', undefined, turns, executor, store);
      }

      const specId = `${runId}:t${turn}`;
      const materialized = materializeGraph(spec, `${runId}/turn-${turn}`, {
        turn,
        rationale: spec.rationale,
        specId,
      });
      await materialized.graph.run(executor);
      const observations = collectObservations(materialized);
      turns.push({
        turn,
        kind: 'graph',
        rationale: spec.rationale,
        taskCount: spec.tasks.length,
        observations,
      });
      printObservationSummary(observations, log);

      if (remaining === 0) {
        log('turn budget reached without an explicit "done"; ending run.');
        return finalize('budget_exhausted', undefined, turns, executor, store);
      }
      nextInput = renderObservationFeedback({ observations, remainingTurns: remaining });
    }
    return finalize('budget_exhausted', undefined, turns, executor, store);
  } finally {
    process.off('SIGINT', onSigint);
  }
}

function finalize(
  status: RunHarnessResult['status'],
  report: string | undefined,
  turns: TurnSummary[],
  executor: TaskExecutor,
  store: ReturnType<typeof openRunsStore> | undefined,
): RunHarnessResult {
  const persistenceErrors: RunHarnessResult['persistenceErrors'] = [
    ...executor.persistenceErrors.map((e) => ({ kind: 'task' as const, id: e.taskId, error: e.error.message })),
    ...executor.graphPersistenceErrors.map((e) => ({ kind: 'graph' as const, id: e.graphId, error: e.error.message })),
  ];
  void executor.close().catch(() => undefined);
  if (store) {
    try {
      store.close();
    } catch {
      // ignore close errors
    }
  }
  return { status, report, turns, persistenceErrors };
}

function printPlan(spec: GraphSpec, log: (line: string) => void): void {
  for (const t of spec.tasks) {
    const after = (t.after ?? []).length ? ` after=[${t.after!.join(',')}]` : '';
    log(`  - ${t.id} (${t.type})${after}: ${summarizePayload(t)}`);
  }
}

function summarizePayload(t: GraphSpec['tasks'][number]): string {
  switch (t.type) {
    case 'bash':
      return `${t.payload.command} ${t.payload.args.join(' ')}`.trim();
    case 'read-log':
      return `${t.payload.path} tail=${t.payload.tailLines}${t.payload.grep ? ` grep="${t.payload.grep}"` : ''}`;
    case 'journal':
      return `since=${t.payload.since}${t.payload.priority ? ` priority=${t.payload.priority}` : ''}${t.payload.unit ? ` unit=${t.payload.unit}` : ''}`;
    case 'report':
      return `prompt: ${t.payload.prompt.slice(0, 80)}${t.payload.prompt.length > 80 ? '...' : ''}`;
    case 'note':
      return `"${t.payload.text.slice(0, 80)}${t.payload.text.length > 80 ? '...' : ''}"`;
  }
}

function printObservationSummary(observations: Observation[], log: (line: string) => void): void {
  for (const o of observations) {
    const flag = o.status === 'succeeded' ? 'ok' : o.status;
    log(`    [${flag}] ${o.id} ${o.title} (${o.durationMs}ms, ${o.output.totalLines} lines${o.output.truncated ? ', truncated' : ''})`);
    if (o.error) log(`        error: ${o.error.split('\n')[0]}`);
  }
}

async function confirmPlan(_spec: GraphSpec): Promise<boolean> {
  if (!process.stdin.isTTY) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Run this plan? [y/N] ')).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}
