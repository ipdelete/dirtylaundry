import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { reasoningEffortToThinkingLevel } from '../src/pi-agent-common.js';

describe('reasoningEffortToThinkingLevel', () => {
  it('passes recognized levels through unchanged', () => {
    for (const level of ['minimal', 'low', 'medium', 'high', 'xhigh'] as const) {
      assert.equal(reasoningEffortToThinkingLevel(level), level);
    }
  });

  it("returns 'off' for unrecognized or empty values", () => {
    assert.equal(reasoningEffortToThinkingLevel(undefined), 'off');
    assert.equal(reasoningEffortToThinkingLevel(null), 'off');
    assert.equal(reasoningEffortToThinkingLevel(''), 'off');
    assert.equal(reasoningEffortToThinkingLevel('HIGH'), 'off');
    assert.equal(reasoningEffortToThinkingLevel('extreme'), 'off');
  });
});
