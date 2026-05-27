import {
  Task,
  TaskExecutor,
  TaskGraph,
  TaskType,
  makeCopilotPromptHandler,
} from '@ianphil/ttasks-ts';

import { PiAgentCopilotProvider } from '../pi-agent-copilot-provider.js';
import { bashHandler, journalHandler, noteHandler, readLogHandler } from './handlers.js';
import type { GraphSpec, GraphTask } from './schema.js';

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
}

export function buildHarnessExecutor(options: BuildExecutorOptions = {}): TaskExecutor {
  const executor = new TaskExecutor();
  executor.register(HarnessTaskType.BASH, bashHandler);
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
  /** Maps GraphSpec task id -> ttasks Task instance. */
  taskById: Map<string, Task>;
  /** Maps GraphSpec task id -> the original spec entry. Used by the observer. */
  specById: Map<string, GraphTask>;
}

export function materializeGraph(spec: GraphSpec, title = 'planner-graph'): MaterializeResult {
  const graph = new TaskGraph({ title });
  const taskById = new Map<string, Task>();
  const specById = new Map<string, GraphTask>();
  for (const entry of spec.tasks) specById.set(entry.id, entry);

  // Build in declaration order. Dependencies are validated upstream
  // (validateGraphSpec) so any dep referenced is already in spec.tasks.
  for (const entry of spec.tasks) {
    const task = buildTask(entry);
    taskById.set(entry.id, task);

    const after = (entry.after ?? []).map((depId) => {
      const dep = taskById.get(depId);
      if (!dep) {
        // Forward reference. Shouldn't happen given validateGraphSpec ran,
        // but guard anyway.
        throw new Error(`materializeGraph: forward dependency ${entry.id} -> ${depId}`);
      }
      return dep;
    });
    graph.add(task, after.length ? { after } : undefined);
  }

  return { graph, taskById, specById };
}

function buildTask(entry: GraphTask): Task {
  const init = {
    title: entry.title ?? `${entry.type}:${entry.id}`,
    ...(entry.timeout !== undefined ? { timeout: entry.timeout } : {}),
  };
  switch (entry.type) {
    case 'bash':
      return Task.custom(HarnessTaskType.BASH, JSON.stringify(entry.payload), init);
    case 'read-log':
      return Task.custom(HarnessTaskType.READ_LOG, JSON.stringify(entry.payload), init);
    case 'journal':
      return Task.custom(HarnessTaskType.JOURNAL, JSON.stringify(entry.payload), init);
    case 'note':
      return Task.custom(HarnessTaskType.NOTE, JSON.stringify(entry.payload), init);
    case 'report':
      // ttasks Task.prompt + makeCopilotPromptHandler — the prompt text is
      // the payload, no JSON wrapping.
      return Task.prompt(entry.payload.prompt, init);
  }
}
