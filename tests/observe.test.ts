import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { collectObservations } from '../src/harness/observe.js';
import type { MaterializeResult } from '../src/harness/materialize.js';
import type { LeafNode } from '../src/harness/schema.js';

function fakeMaterialized(id: string, output: string): MaterializeResult {
  const task = {
    title: 't',
    status: 'succeeded',
    result: { output, duration: 1 },
    error: undefined,
  };
  const leaf = { id, type: 'note', payload: { text: 'x' } } as unknown as LeafNode;
  return {
    graph: null as unknown as MaterializeResult['graph'],
    taskById: new Map([[id, task]]) as unknown as MaterializeResult['taskById'],
    leafById: new Map([[id, leaf]]),
  };
}

describe('collectObservations output summary', () => {
  it('round-trips every line when total <= headLines+tailLines (not truncated)', () => {
    // 30 lines, head=20, tail=20. Total (30) fits within head+tail (40) so
    // truncated should be false AND every line should be representable from
    // headLines+tailLines. Previously lines [headN..totalLines-1] were silently
    // dropped, which made `truncated: false` a lie and caused
    // PlanRunner.evalCondition's `output_contains` check to miss substrings
    // that landed past headN in a non-truncated output.
    const lines = Array.from({ length: 30 }, (_, i) => `line${i}`);
    const m = fakeMaterialized('a', lines.join('\n'));
    const [obs] = collectObservations(m, { headLines: 20, tailLines: 20 });

    assert.equal(obs.output.totalLines, 30);
    assert.equal(obs.output.truncated, false);

    const hay = [...obs.output.headLines, ...obs.output.tailLines].join('\n');
    for (const l of lines) {
      assert.ok(hay.includes(l), `expected non-truncated summary to contain ${l}`);
    }
  });

  it('truncates head+tail when total > headLines+tailLines', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`);
    const m = fakeMaterialized('a', lines.join('\n'));
    const [obs] = collectObservations(m, { headLines: 5, tailLines: 5 });

    assert.equal(obs.output.totalLines, 100);
    assert.equal(obs.output.truncated, true);
    assert.deepEqual(obs.output.headLines, lines.slice(0, 5));
    assert.deepEqual(obs.output.tailLines, lines.slice(-5));
  });

  it('handles empty output', () => {
    const m = fakeMaterialized('a', '');
    const [obs] = collectObservations(m);
    assert.equal(obs.output.totalLines, 0);
    assert.equal(obs.output.truncated, false);
    assert.deepEqual(obs.output.headLines, []);
    assert.deepEqual(obs.output.tailLines, []);
  });
});
