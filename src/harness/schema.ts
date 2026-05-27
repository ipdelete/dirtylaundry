import { z } from 'zod';

/**
 * GraphSpec — the contract the planner LLM emits each turn.
 *
 * The harness validates strictly. Anything that does not parse becomes a
 * parse_error observation fed back to the planner on the next turn.
 */

export const TaskId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'task id must match [A-Za-z0-9_-]+');

const Common = {
  id: TaskId,
  title: z.string().min(1).max(120).optional(),
  after: z.array(TaskId).max(32).optional(),
  timeout: z.number().int().positive().max(600).optional(),
};

/** journal: journalctl with safe defaults. */
export const JournalPayload = z.object({
  since: z.string().min(1).max(64),
  priority: z.enum(['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug']).optional(),
  unit: z.string().max(120).optional(),
  grep: z.string().max(200).optional(),
  maxLines: z.number().int().positive().max(2000).default(500),
});

/** read-log: tail (+ optional grep) of a file under /var/log. */
export const ReadLogPayload = z.object({
  path: z
    .string()
    .min(1)
    .refine((p) => p.startsWith('/var/log/'), 'path must start with /var/log/')
    .refine((p) => !p.includes('..'), 'path must not contain ..'),
  tailLines: z.number().int().positive().max(2000).default(500),
  grep: z.string().max(200).optional(),
});

/** bash: allowlisted command + arg vector. No shell, no pipes, no redirection. */
export const BashPayload = z.object({
  command: z.string().min(1).max(64),
  args: z.array(z.string().max(200)).max(32).default([]),
});

/** report: a Task.prompt with a fixed system prompt for final/intermediate summary. */
export const ReportPayload = z.object({
  prompt: z.string().min(1).max(8000),
});

/** note: pure transform. Lets the planner leave breadcrumbs on the graph. */
export const NotePayload = z.object({
  text: z.string().min(1).max(2000),
});

export const GraphTask = z.discriminatedUnion('type', [
  z.object({ ...Common, type: z.literal('journal'), payload: JournalPayload }),
  z.object({ ...Common, type: z.literal('read-log'), payload: ReadLogPayload }),
  z.object({ ...Common, type: z.literal('bash'), payload: BashPayload }),
  z.object({ ...Common, type: z.literal('report'), payload: ReportPayload }),
  z.object({ ...Common, type: z.literal('note'), payload: NotePayload }),
]);

export const GraphSpec = z.object({
  kind: z.literal('graph'),
  rationale: z.string().min(1).max(2000),
  tasks: z.array(GraphTask).min(1).max(32),
});

export const DoneSpec = z.object({
  kind: z.literal('done'),
  report: z.string().min(1).max(8000),
});

export const PlannerOutput = z.discriminatedUnion('kind', [GraphSpec, DoneSpec]);

export type TaskId = z.infer<typeof TaskId>;
export type GraphTask = z.infer<typeof GraphTask>;
export type GraphSpec = z.infer<typeof GraphSpec>;
export type DoneSpec = z.infer<typeof DoneSpec>;
export type PlannerOutput = z.infer<typeof PlannerOutput>;
export type BashPayloadT = z.infer<typeof BashPayload>;
export type ReadLogPayloadT = z.infer<typeof ReadLogPayload>;
export type JournalPayloadT = z.infer<typeof JournalPayload>;
export type ReportPayloadT = z.infer<typeof ReportPayload>;
export type NotePayloadT = z.infer<typeof NotePayload>;

/** Structural validation beyond schema: unique ids, edges resolve, no cycles. */
export function validateGraphSpec(spec: GraphSpec): { ok: true } | { ok: false; error: string } {
  const ids = new Set<string>();
  for (const task of spec.tasks) {
    if (ids.has(task.id)) return { ok: false, error: `duplicate task id: ${task.id}` };
    ids.add(task.id);
  }
  for (const task of spec.tasks) {
    for (const dep of task.after ?? []) {
      if (!ids.has(dep)) return { ok: false, error: `task ${task.id} depends on unknown id: ${dep}` };
      if (dep === task.id) return { ok: false, error: `task ${task.id} depends on itself` };
    }
  }
  // Topological-sort check for cycles.
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const task of spec.tasks) {
    indeg.set(task.id, 0);
    adj.set(task.id, []);
  }
  for (const task of spec.tasks) {
    for (const dep of task.after ?? []) {
      adj.get(dep)!.push(task.id);
      indeg.set(task.id, (indeg.get(task.id) ?? 0) + 1);
    }
  }
  const queue: string[] = [];
  for (const [id, n] of indeg) if (n === 0) queue.push(id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited++;
    for (const next of adj.get(id) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 0) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  if (visited !== spec.tasks.length) return { ok: false, error: 'cycle detected in task graph' };
  return { ok: true };
}
