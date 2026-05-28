import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { substituteLeaf, withId } from '../src/harness/runner.js';
import type { LeafNode } from '../src/harness/schema.js';

function bashLeaf(id: string, command: string, args: string[], title?: string): LeafNode {
  return {
    id,
    type: 'bash',
    payload: { command, args },
    ...(title ? { title } : {}),
  } as LeafNode;
}

describe('withId', () => {
  it('returns a new leaf with the replaced id, leaving other fields untouched', () => {
    const original = bashLeaf('a', 'uname', ['-a']);
    const copy = withId(original, 'b');
    assert.equal(copy.id, 'b');
    assert.equal(original.id, 'a', 'must not mutate original');
    assert.equal(copy.type, 'bash');
    if (copy.type === 'bash') assert.deepEqual(copy.payload.args, ['-a']);
  });
});

describe('substituteLeaf', () => {
  it('substitutes the placeholder in string payload fields', () => {
    const leaf = bashLeaf('probe', 'systemctl', ['status', '${unit}']);
    const out = substituteLeaf(leaf, 'unit', 'nginx.service', 'probe__0');
    assert.equal(out.id, 'probe__0');
    if (out.type === 'bash') assert.deepEqual(out.payload.args, ['status', 'nginx.service']);
  });

  it('substitutes the placeholder in the title', () => {
    const leaf = bashLeaf('probe', 'systemctl', [], 'check ${unit}');
    const out = substituteLeaf(leaf, 'unit', 'sshd', 'probe__0');
    assert.equal(out.title, 'check sshd');
  });

  it('replaces every occurrence of the placeholder, not just the first', () => {
    const leaf = bashLeaf('probe', 'echo', ['${x}', 'mid-${x}-end', 'plain']);
    const out = substituteLeaf(leaf, 'x', 'Y', 'p');
    if (out.type === 'bash') assert.deepEqual(out.payload.args, ['Y', 'mid-Y-end', 'plain']);
  });

  it('omits the title field when the source leaf has no title', () => {
    const leaf = bashLeaf('probe', 'uname', []);
    const out = substituteLeaf(leaf, 'x', 'Y', 'p');
    assert.equal('title' in out, false);
  });

  it('does not mutate the source leaf', () => {
    const leaf = bashLeaf('probe', 'systemctl', ['status', '${unit}']);
    const argsBefore = [...(leaf.type === 'bash' ? leaf.payload.args : [])];
    substituteLeaf(leaf, 'unit', 'nginx.service', 'probe__0');
    if (leaf.type === 'bash') assert.deepEqual(leaf.payload.args, argsBefore);
  });
});
