import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractJson } from '../src/harness/planner.js';

describe('extractJson', () => {
  it('returns the input trimmed when no fence and no braces', () => {
    assert.equal(extractJson('   hello world   '), 'hello world');
  });

  it('extracts content from a ```json ... ``` fence', () => {
    const wrapped = 'preamble\n```json\n{"a":1}\n```\ntrailing';
    assert.equal(extractJson(wrapped), '{"a":1}');
  });

  it('extracts content from a bare ``` ... ``` fence', () => {
    const wrapped = '```\n{"b":2}\n```';
    assert.equal(extractJson(wrapped), '{"b":2}');
  });

  it('falls back to the outermost { ... } slice when no fence is present', () => {
    const text = 'some chatter {"k":"v","nested":{"x":1}} and trailing junk';
    assert.equal(extractJson(text), '{"k":"v","nested":{"x":1}}');
  });

  it('returns the whole trimmed text when only an opening brace exists', () => {
    // start >= 0 but no closing brace after it: end <= start, so fallback path.
    assert.equal(extractJson('  { incomplete  '), '{ incomplete');
  });
});
