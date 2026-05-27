import {
  Task,
  TaskExecutor,
  TaskGraph,
  TaskType,
  makeCopilotPromptHandler,
  type Store,
} from '@ianphil/ttasks-ts';

import { PiAgentCopilotProvider } from '../pi-agent-copilot-provider.js';
import { journalHandler, makeBashHandler, noteHandler, readLogHandler } from './handlers.js';
import type { HostCapabilities } from './capabilities.js';
import type { LeafNode } from './schema.js';
import type { Batch, BatchTask } from './runner.js';

/** Custom TaskType strings registered by the harness. */
export const HarnessTaskType = {
  BASH: 'harness:bash',
  READ_LOG: 'harness:read-log',
  JOURNAL: 'harness:journal',
  NOTE: 'harness:note',
} as const;

export interface BuildExecutorOptions {
  reportSystemPrompt?: string;
  reportModel?: string;
  reportTimeoutSeconds?: number;
  store?: Store;
  /** The bash handler is restricted to this host's effective allowlist
   * (intersection of declared commands and what's present on $PATH). */
  capabilities: HostCapabilities;
}

export function buildHarnessExecutor(options: BuildExecutorOptions): TaskExecutor {
  const executor = new TaskExecutor(options.store ? { store: options.store } : undefined);
  executor.register(
    HarnessTaskType.BASH,
    makeBashHandler({ allowlist: options.capabilities.effectiveBashAllowlist }),
  );
  executor.register(HarnessTaskType.READ_LOG, readLogHandler);
  executor.register(HarnessTaskType.JOURNAL, journalHandler);
  executor.register(HarnessTaskType.NOTE, noteHandler);

  const reportProvider = new PiAgentCopilotProvider({
    systemPrompt:
      options.reportSystemPrompt ??
      'You write concise system-health summaries for the human operator. Be specific. Prefer bullet points. No filler.',
  });
  executor.register(
    TaskType.PROMPT,
    makeCopilotPromptHandler({
      provider: reportProvider,
      model: options.reportModel ?? 'gpt-5.4-mini',
      timeout: options.reportTimeoutSeconds ?? 60,
    }),
  );

  return executor;
}

export interface MaterializeResult {
  graph: TaskGraph;
  /** Batch task id -> ttasks Task instance. */
  taskById: Map<string, Task>;
  /** Batch task id -> originating leaf (post-substitution if expanded). */
  leafById: Map<string, LeafNode>;
}

export interface MaterializeOptions {
  turn?: number;
  rationale?: string;
  specId?: string;
}

export function materializeBatch(
  batch: Batch,
  title = 'planner-batch',
  options: MaterializeOptions = {},
): MaterializeResult {
  const graph = new TaskGraph({ title });
  const taskById = new Map<string, Task>();
  const leafById = new Map<string, LeafNode>();
  for (const bt of batch.tasks) leafById.set(bt.id, bt.leaf);

  for (const bt of batch.tasks) {
    const task = buildTask(bt);
    task.metadata = {
      specTaskId: bt.id,
      specType: bt.leaf.type,
      ...(options.specId ? { specId: options.specId } : {}),
      ...(options.turn !== undefined ? { turn: options.turn } : {}),
      ...(options.rationale ? { rationale: options.rationale } : {}),
    };
    taskById.set(bt.id, task);

    const after = (bt.after ?? []).map((depId) => {
      const dep = taskById.get(depId);
      if (!dep) throw new Error(`materializeBatch: unresolved dependency ${bt.id} -> ${depId}`);
      return dep;
    });
    graph.add(task, after.length ? { after } : undefined);
  }

  return { graph, taskById, leafById };
}

function buildTask(bt: BatchTask): Task {
  const leaf = bt.leaf;
  const init = {
    title: leaf.title ?? `${leaf.type}:${bt.id}`,
    ...(leaf.timeout !== undefined ? { timeout: leaf.timeout } : {}),
  };
  switch (leaf.type) {
    case 'bash':
      return Task.custom(HarnessTaskType.BASH, JSON.stringify(leaf.payload), init);
    case 'read-log':
      return Task.custom(HarnessTaskType.READ_LOG, JSON.stringify(leaf.payload), init);
    case 'journal':
      return Task.custom(HarnessTaskType.JOURNAL, JSON.stringify(leaf.payload), init);
    case 'note':
      return Task.custom(HarnessTaskType.NOTE, JSON.stringify(leaf.payload), init);
    case 'report':
      return Task.prompt(leaf.payload.prompt, init);
  }
}
