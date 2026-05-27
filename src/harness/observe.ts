import type { Task } from '@ianphil/ttasks-ts';

import type { LeafNode } from './schema.js';
import type { MaterializeResult } from './materialize.js';

/**
 * Observation: the compact record fed back to the planner on the next turn.
 *
 * Design rule: head + tail + count over full output. Token budget is the
 * dominant constraint over multiple turns. If the planner needs more, it
 * issues a follow-up `read-log` with `grep`.
 */
export interface Observation {
  id: string;
  type: LeafNode['type'];
  title: string;
  status: string;
  durationMs: number;
  payloadEcho: unknown;
  output: {
    headLines: string[];
    tailLines: string[];
    totalLines: number;
    truncated: boolean;
  };
  error?: string;
}

export interface CollectOptions {
  headLines?: number;
  tailLines?: number;
}

export function collectObservations(
  materialized: MaterializeResult,
  options: CollectOptions = {},
): Observation[] {
  const headN = options.headLines ?? 20;
  const tailN = options.tailLines ?? 20;
  const out: Observation[] = [];
  for (const [id, leaf] of materialized.leafById) {
    const task = materialized.taskById.get(id);
    if (!task) continue;
    out.push(observeTask(task, id, leaf, headN, tailN));
  }
  return out;
}

function observeTask(task: Task, id: string, leaf: LeafNode, headN: number, tailN: number): Observation {
  const lines = (task.result?.output ?? '').replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();

  const totalLines = lines.length;
  const truncated = totalLines > headN + tailN;
  const headLines = lines.slice(0, headN);
  const tailLines = truncated ? lines.slice(-tailN) : [];

  const observation: Observation = {
    id,
    type: leaf.type,
    title: task.title,
    status: task.status,
    durationMs: task.result?.duration ?? 0,
    payloadEcho: leaf.payload,
    output: { headLines, tailLines, totalLines, truncated },
  };
  if (task.result?.error || task.error) {
    observation.error = task.result?.error ?? task.error;
  }
  return observation;
}
