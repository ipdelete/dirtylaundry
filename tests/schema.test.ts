import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateGraphSpec, type GraphSpec } from '../src/harness/schema.js';

function bash(id: string, after?: string[]): GraphSpec['nodes'][number] {
  return {
    id,
    type: 'bash',
    payload: { command: 'uname', args: [] },
    ...(after ? { after } : {}),
  } as GraphSpec['nodes'][number];
}

function spec(nodes: GraphSpec['nodes']): GraphSpec {
  return { kind: 'graph', rationale: 'test', nodes };
}

describe('validateGraphSpec', () => {
  it('accepts a single-node graph', () => {
    assert.deepEqual(validateGraphSpec(spec([bash('a')])), { ok: true });
  });

  it('rejects duplicate top-level ids', () => {
    const result = validateGraphSpec(spec([bash('a'), bash('a')]));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /duplicate node id: a/);
  });

  it('rejects an after edge to an unknown top-level id', () => {
    const result = validateGraphSpec(spec([bash('a', ['ghost'])]));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /depends on unknown top-level id: ghost/);
  });

  it('rejects a node that depends on itself', () => {
    const result = validateGraphSpec(spec([bash('a', ['a'])]));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /depends on itself/);
  });

  it('rejects an if-condition referencing an unknown top-level id', () => {
    const ifNode = {
      id: 'gate',
      type: 'if' as const,
      cond: { kind: 'task_status' as const, task: 'ghost', equals: 'succeeded' as const },
      then: [bash('child')],
    };
    const result = validateGraphSpec(spec([ifNode as unknown as GraphSpec['nodes'][number]]));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /condition references unknown top-level id: ghost/);
  });

  it('rejects duplicate ids nested inside an if branch', () => {
    const ifNode = {
      id: 'gate',
      type: 'if' as const,
      cond: { kind: 'task_status' as const, task: 'gate', equals: 'succeeded' as const },
      then: [bash('dup'), bash('dup')],
    };
    const result = validateGraphSpec(spec([ifNode as unknown as GraphSpec['nodes'][number]]));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /duplicate node id: dup/);
  });
});
