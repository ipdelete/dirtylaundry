import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { uniqueByPrefix } from '../src/runs-cli.js';

describe('uniqueByPrefix', () => {
  let originalErr: typeof console.error;
  let stderr: string[];

  beforeEach(() => {
    originalErr = console.error;
    stderr = [];
    console.error = (msg: unknown): void => { stderr.push(String(msg)); };
  });

  afterEach(() => {
    console.error = originalErr;
  });

  it('returns the single match', () => {
    const match = { id: 'run-abc' };
    assert.equal(uniqueByPrefix([match], 'run', 'run-a'), match);
    assert.deepEqual(stderr, []);
  });

  it('returns null and logs no-match error on empty input', () => {
    assert.equal(uniqueByPrefix([], 'run', 'zzz'), null);
    assert.deepEqual(stderr, ['no run matches zzz']);
  });

  it('returns null and logs ambiguity error on multiple matches', () => {
    const matches = [{ id: 'a1' }, { id: 'a2' }];
    assert.equal(uniqueByPrefix(matches, 'plan', 'a'), null);
    assert.equal(stderr[0], 'ambiguous plan id; 2 matches:');
    assert.deepEqual(stderr.slice(1), ['  a1', '  a2']);
  });

  it('prefers an exact id match over a coexisting longer-prefix match', () => {
    // Regression: previously uniqueByPrefix reported ambiguity even when one
    // of the candidates was an exact id match, making it impossible to select
    // e.g. "run-1" once "run-12" also existed.
    const exact = { id: 'run-1' };
    const longer = { id: 'run-12' };
    assert.equal(uniqueByPrefix([exact, longer], 'run', 'run-1'), exact);
    assert.equal(uniqueByPrefix([longer, exact], 'run', 'run-1'), exact);
    assert.deepEqual(stderr, []);
  });
});
