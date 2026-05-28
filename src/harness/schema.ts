import { z } from 'zod';

/**
 * GraphSpec — the contract the planner LLM emits each turn.
 *
 * The plan is a list of nodes. A node is either:
 *  - a leaf (journal | read-log | bash | report | note) that runs once, or
 *  - a control node (if | foreach) that resolves into leaves at runtime
 *    based on prior observations.
 *
 * Control flow lives here, not in ttasks-ts. The runner (PlanRunner) walks
 * this graph and emits batches of runnable leaves to the ttasks executor.
 *
 * The harness validates strictly. Anything that does not parse becomes a
 * parse_error observation fed back to the planner on the next turn.
 */

export const TaskId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'task id must match [A-Za-z0-9_-]+');

const NodeCommon = {
  id: TaskId,
  title: z.string().min(1).max(120).optional(),
  /** Ids that must finish before this node is considered. May reference
   * control-node ids; the runner rewrites those to their expanded leaves. */
  after: z.array(TaskId).max(32).optional(),
};

const LeafCommon = {
  ...NodeCommon,
  timeout: z.number().int().positive().max(600).optional(),
};

// ---- leaf payloads ----

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

export const LeafNode = z.discriminatedUnion('type', [
  z.object({ ...LeafCommon, type: z.literal('journal'), payload: JournalPayload }),
  z.object({ ...LeafCommon, type: z.literal('read-log'), payload: ReadLogPayload }),
  z.object({ ...LeafCommon, type: z.literal('bash'), payload: BashPayload }),
  z.object({ ...LeafCommon, type: z.literal('report'), payload: ReportPayload }),
  z.object({ ...LeafCommon, type: z.literal('note'), payload: NotePayload }),
]);

// ---- control flow ----

export const Condition = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('task_status'),
    task: TaskId,
    equals: z.enum(['succeeded', 'failed']),
  }),
  z.object({
    kind: z.literal('output_contains'),
    task: TaskId,
    substring: z.string().min(1).max(200),
  }),
  z.object({
    kind: z.literal('lines_gt'),
    task: TaskId,
    n: z.number().int().nonnegative().max(100000),
  }),
]);

export const ItemSource = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('literal'),
    items: z.array(z.string().min(1).max(500)).min(1).max(64),
  }),
  // Reserved for future: { kind: 'task_lines', task: TaskId, grep?: string, limit?: number }
]);

/** if: pick `then` or `else` branch after `cond.task` resolves.
 * `cond.task` is implicitly added to `after` by the runner. */
export const IfNode = z.object({
  ...NodeCommon,
  type: z.literal('if'),
  cond: Condition,
  then: z.array(LeafNode).min(1).max(16),
  else: z.array(LeafNode).max(16).optional(),
});

/** foreach: expand `body` once per item. `${as}` in body string fields is
 * substituted with the current item before the batch is emitted. */
export const ForeachNode = z.object({
  ...NodeCommon,
  type: z.literal('foreach'),
  over: ItemSource,
  as: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'as must be a simple identifier'),
  body: LeafNode,
});

export const Node = z.discriminatedUnion('type', [
  z.object({ ...LeafCommon, type: z.literal('journal'), payload: JournalPayload }),
  z.object({ ...LeafCommon, type: z.literal('read-log'), payload: ReadLogPayload }),
  z.object({ ...LeafCommon, type: z.literal('bash'), payload: BashPayload }),
  z.object({ ...LeafCommon, type: z.literal('report'), payload: ReportPayload }),
  z.object({ ...LeafCommon, type: z.literal('note'), payload: NotePayload }),
  IfNode,
  ForeachNode,
]);

export const GraphSpec = z.object({
  kind: z.literal('graph'),
  rationale: z.string().min(1).max(2000),
  nodes: z.array(Node).min(1).max(32),
});

export const DoneSpec = z.object({
  kind: z.literal('done'),
  report: z.string().min(1).max(8000),
});

export const PlannerOutput = z.discriminatedUnion('kind', [GraphSpec, DoneSpec]);

export type TaskId = z.infer<typeof TaskId>;
export type LeafNode = z.infer<typeof LeafNode>;
export type IfNode = z.infer<typeof IfNode>;
export type ForeachNode = z.infer<typeof ForeachNode>;
export type Node = z.infer<typeof Node>;
export type GraphSpec = z.infer<typeof GraphSpec>;
export type DoneSpec = z.infer<typeof DoneSpec>;
export type PlannerOutput = z.infer<typeof PlannerOutput>;
export type Condition = z.infer<typeof Condition>;
export type ItemSource = z.infer<typeof ItemSource>;
export type BashPayloadT = z.infer<typeof BashPayload>;
export type ReadLogPayloadT = z.infer<typeof ReadLogPayload>;
export type JournalPayloadT = z.infer<typeof JournalPayload>;
export type ReportPayloadT = z.infer<typeof ReportPayload>;
export type NotePayloadT = z.infer<typeof NotePayload>;

/** Structural validation: unique ids (including nested), edges resolve,
 * conditions reference declared top-level nodes. */
export function validateGraphSpec(spec: GraphSpec): { ok: true } | { ok: false; error: string } {
  const ids = new Set<string>();
  const collect = (node: Node): string | null => {
    if (ids.has(node.id)) return `duplicate node id: ${node.id}`;
    ids.add(node.id);
    if (node.type === 'if') {
      for (const child of node.then) {
        const e = collect(child);
        if (e) return e;
      }
      for (const child of node.else ?? []) {
        const e = collect(child);
        if (e) return e;
      }
    } else if (node.type === 'foreach') {
      const e = collect(node.body);
      if (e) return e;
    }
    return null;
  };
  for (const node of spec.nodes) {
    const e = collect(node);
    if (e) return { ok: false, error: e };
  }

  const topIds = new Set(spec.nodes.map((n) => n.id));
  const topNodeById = new Map(spec.nodes.map((n) => [n.id, n] as const));
  for (const node of spec.nodes) {
    for (const dep of node.after ?? []) {
      if (!topIds.has(dep)) {
        return { ok: false, error: `node ${node.id} depends on unknown top-level id: ${dep}` };
      }
      if (dep === node.id) return { ok: false, error: `node ${node.id} depends on itself` };
    }
    if (node.type === 'if') {
      const target = topNodeById.get(node.cond.task);
      if (!target) {
        return {
          ok: false,
          error: `if node ${node.id} condition references unknown top-level id: ${node.cond.task}`,
        };
      }
      if (target.type === 'if' || target.type === 'foreach') {
        // Control nodes never produce observations; evalCondition would
        // therefore always return false and the `then` branch would be dead
        // code. Reject this at validation time instead of letting the runner
        // silently take the else branch.
        return {
          ok: false,
          error: `if node ${node.id} condition references control node ${node.cond.task} (${target.type}); cond.task must be a leaf`,
        };
      }
    }
  }

  return { ok: true };
}

export function isLeaf(node: Node): node is LeafNode {
  return node.type !== 'if' && node.type !== 'foreach';
}
