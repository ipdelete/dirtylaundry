import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parsePlannerOutput } from '../src/harness/planner.js';

describe('parsePlannerOutput', () => {
  it('returns a done result for a valid done payload', () => {
    const raw = JSON.stringify({ kind: 'done', report: 'all clear' });
    const result = parsePlannerOutput(raw);
    assert.equal(result.kind, 'done');
    if (result.kind === 'done') assert.equal(result.report, 'all clear');
  });

  it('returns a graph result for a structurally valid graph payload', () => {
    const raw = JSON.stringify({
      kind: 'graph',
      rationale: 'probe host',
      nodes: [
        { id: 'uname', type: 'bash', payload: { command: 'uname', args: [] } },
      ],
    });
    const result = parsePlannerOutput(raw);
    assert.equal(result.kind, 'graph');
    if (result.kind === 'graph') assert.equal(result.spec.nodes[0].id, 'uname');
  });

  it('tolerates ```json fences around the payload', () => {
    const raw = '```json\n' + JSON.stringify({ kind: 'done', report: 'ok' }) + '\n```';
    const result = parsePlannerOutput(raw);
    assert.equal(result.kind, 'done');
  });

  it('returns kind=error with raw preserved when JSON is invalid', () => {
    const result = parsePlannerOutput('not json at all');
    assert.equal(result.kind, 'error');
    if (result.kind === 'error') {
      assert.match(result.error, /not valid JSON/);
      assert.equal(result.raw, 'not json at all');
    }
  });

  it('returns kind=error when schema validation fails', () => {
    const raw = JSON.stringify({ kind: 'graph', rationale: '', nodes: [] });
    const result = parsePlannerOutput(raw);
    assert.equal(result.kind, 'error');
    if (result.kind === 'error') assert.match(result.error, /schema validation failed/);
  });

  it('returns kind=error when structural validation fails (duplicate ids)', () => {
    const raw = JSON.stringify({
      kind: 'graph',
      rationale: 'dup ids',
      nodes: [
        { id: 'a', type: 'bash', payload: { command: 'uname', args: [] } },
        { id: 'a', type: 'bash', payload: { command: 'uname', args: [] } },
      ],
    });
    const result = parsePlannerOutput(raw);
    assert.equal(result.kind, 'error');
    if (result.kind === 'error') assert.match(result.error, /structural validation failed.*duplicate node id/);
  });
});
