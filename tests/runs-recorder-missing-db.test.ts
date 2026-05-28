import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunsReader } from '../src/harness/runs-recorder.js';

describe('RunsReader with missing database file', () => {
  it('does not throw when constructed against a non-existent path', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'runs-reader-test-'));
    try {
      const missing = join(tmp, 'never-created.db');
      // Pre-fix this would throw `unable to open database file`, breaking
      // `dirtylaundry runs list` on a fresh host with no recorded runs.
      const reader = new RunsReader(missing);
      try {
        assert.deepEqual(reader.listRuns(20), []);
        assert.equal(reader.getRun('anything'), null);
        assert.deepEqual(reader.plansForRun('anything'), []);
      } finally {
        reader.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
