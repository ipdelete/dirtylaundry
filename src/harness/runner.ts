import type { Condition, GraphSpec, LeafNode, Node } from './schema.js';
import type { Observation } from './observe.js';

/**
 * A Batch is a set of leaf tasks ready to run right now, with `after` edges
 * rewritten to reference only ids in this batch. The runner emits one batch
 * per call to nextBatch(); the harness materializes and executes it, then
 * feeds observations back via recordObservations().
 */
export interface Batch {
  index: number;
  rationale: string;
  tasks: BatchTask[];
}

export interface BatchTask {
  /** Stable id used in observations + persistence. Inherited from the source
   * leaf for top-level nodes, synthesized for expanded children. */
  id: string;
  leaf: LeafNode;
  after?: string[];
}

/**
 * PlanRunner — drives a GraphSpec to completion by emitting batches of leaf
 * tasks. Control nodes (`if`, `foreach`) are expanded between batches using
 * observations from prior batches.
 */
export class PlanRunner {
  private readonly spec: GraphSpec;
  /** Top-level node id -> status. Leaves go pending -> emitted -> done.
   * Control nodes go pending -> done (when expanded). */
  private readonly status = new Map<string, 'pending' | 'emitted' | 'done'>();
  /** All observed leaves (top-level + expanded). */
  private readonly observations = new Map<string, Observation>();
  /** Control node id -> ids of its expanded leaf children. */
  private readonly expansion = new Map<string, string[]>();
  /** Dynamically added leaves from control-node expansion. */
  private readonly dynamicLeaves: DynamicLeaf[] = [];
  private batchIndex = 0;

  constructor(spec: GraphSpec) {
    this.spec = spec;
    for (const node of spec.nodes) this.status.set(node.id, 'pending');
  }

  done(): boolean {
    for (const s of this.status.values()) if (s !== 'done') return false;
    return true;
  }

  recordObservations(obs: Observation[]): void {
    for (const o of obs) {
      this.observations.set(o.id, o);
      if (this.status.get(o.id) === 'emitted') this.status.set(o.id, 'done');
    }
  }

  /** Compute the next runnable batch, or null if nothing can be emitted yet
   * (which, if !done(), means a control node is blocked on a dep that failed
   * or never produced an observation). */
  nextBatch(): Batch | null {
    // Resolve any ready control nodes (expand in place) before collecting leaves.
    let expandedSomething = true;
    while (expandedSomething) {
      expandedSomething = false;
      for (const node of this.spec.nodes) {
        if (this.status.get(node.id) !== 'pending') continue;
        if (node.type !== 'if' && node.type !== 'foreach') continue;
        if (!this.depsSatisfied(this.effectiveAfter(node))) continue;
        if (this.tryExpandControlNode(node)) {
          this.status.set(node.id, 'done');
          expandedSomething = true;
        }
      }
    }

    const tasks: BatchTask[] = [];
    for (const node of this.spec.nodes) {
      if (node.type === 'if' || node.type === 'foreach') continue;
      if (this.status.get(node.id) !== 'pending') continue;
      if (!this.depsSatisfied(node.after)) continue;
      tasks.push({ id: node.id, leaf: node, after: this.rewriteAfter(node.after) });
      this.status.set(node.id, 'emitted');
    }
    for (const dl of this.dynamicLeaves) {
      if (this.status.get(dl.id) !== 'pending') continue;
      if (!this.depsSatisfied(dl.after)) continue;
      tasks.push({ id: dl.id, leaf: dl.leaf, after: this.rewriteAfter(dl.after, dl.id) });
      this.status.set(dl.id, 'emitted');
    }

    if (tasks.length === 0) return null;
    return { index: this.batchIndex++, rationale: this.spec.rationale, tasks };
  }

  /** For diagnostics: ids of nodes still pending. */
  pending(): string[] {
    return [...this.status].filter(([, s]) => s !== 'done').map(([id]) => id);
  }

  // ---- internals ----

  /** For if nodes, the cond's referenced task is an implicit dep. */
  private effectiveAfter(node: Node): string[] | undefined {
    if (node.type !== 'if') return node.after;
    return [...new Set([...(node.after ?? []), node.cond.task])];
  }

  private depsSatisfied(after: string[] | undefined): boolean {
    for (const dep of after ?? []) {
      const targets = this.expansion.get(dep) ?? [dep];
      for (const t of targets) if (this.status.get(t) !== 'done') return false;
    }
    return true;
  }

  /** Rewrite `after` for emission in a batch:
   *   - control-node refs expand to their child leaf ids
   *   - deps already 'done' (ran in a prior batch) are dropped, because the
   *     batch is a self-contained DAG handed to ttasks
   *   - self-refs introduced by aliasing are dropped */
  private rewriteAfter(after: string[] | undefined, selfId?: string): string[] | undefined {
    if (!after || after.length === 0) return undefined;
    const out = new Set<string>();
    const add = (id: string): void => {
      if (id === selfId) return;
      if (this.status.get(id) === 'done') return;
      out.add(id);
    };
    for (const dep of after) {
      for (const t of this.expansion.get(dep) ?? [dep]) add(t);
    }
    return out.size ? Array.from(out) : undefined;
  }

  private tryExpandControlNode(node: Node): boolean {
    if (node.type === 'if') {
      if (!this.observations.has(node.cond.task)) return false;
      const branch = this.evalCondition(node.cond) ? node.then : (node.else ?? []);
      this.registerExpansion(node, branch.map((leaf, i) => {
        const id = `${node.id}__${i}_${leaf.id}`;
        return { id, leaf: withId(leaf, id) };
      }));
      return true;
    }
    if (node.type === 'foreach') {
      if (node.over.kind !== 'literal') {
        throw new Error(`foreach ${node.id}: only kind=literal is supported`);
      }
      this.registerExpansion(node, node.over.items.map((item, i) => {
        const id = `${node.id}__${i}`;
        return { id, leaf: substituteLeaf(node.body, node.as, item, id) };
      }));
      return true;
    }
    return false;
  }

  private registerExpansion(parent: Node, children: Array<{ id: string; leaf: LeafNode }>): void {
    for (const { id, leaf } of children) {
      this.dynamicLeaves.push({ id, leaf, after: parent.after });
      this.status.set(id, 'pending');
    }
    this.expansion.set(parent.id, children.map((c) => c.id));
  }

  private evalCondition(cond: Condition): boolean {
    const obs = this.observations.get(cond.task);
    if (!obs) return false;
    switch (cond.kind) {
      case 'task_status':
        return obs.status === cond.equals;
      case 'output_contains': {
        const hay = [...obs.output.headLines, ...obs.output.tailLines].join('\n');
        return hay.includes(cond.substring);
      }
      case 'lines_gt':
        return obs.output.totalLines > cond.n;
    }
  }
}

interface DynamicLeaf {
  id: string;
  leaf: LeafNode;
  after: string[] | undefined;
}

function withId(leaf: LeafNode, newId: string): LeafNode {
  return { ...leaf, id: newId } as LeafNode;
}

/** Walk a leaf's payload strings and substitute `${as}` with `item`. */
function substituteLeaf(leaf: LeafNode, as: string, item: string, newId: string): LeafNode {
  const token = '${' + as + '}';
  const sub = (s: string): string => s.split(token).join(item);
  const subAny = (v: unknown): unknown => {
    if (typeof v === 'string') return sub(v);
    if (Array.isArray(v)) return v.map(subAny);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, vv]) => [k, subAny(vv)]));
    }
    return v;
  };
  const payload = subAny(leaf.payload) as LeafNode['payload'];
  const title = leaf.title ? sub(leaf.title) : undefined;
  return {
    ...leaf,
    id: newId,
    ...(title !== undefined ? { title } : {}),
    payload,
  } as LeafNode;
}
