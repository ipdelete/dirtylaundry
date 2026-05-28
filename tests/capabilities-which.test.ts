import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { which } from '../src/harness/capabilities.js';

describe('which', () => {
  let tmpRoot: string;
  let dirOnlyEntry: string;
  let realBinEntry: string;
  const fakeName = 'xyz-capability-probe';
  const originalPath = process.env.PATH;

  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'which-test-'));
    dirOnlyEntry = join(tmpRoot, 'a');
    realBinEntry = join(tmpRoot, 'b');
    mkdirSync(dirOnlyEntry);
    mkdirSync(realBinEntry);
    // A *directory* in PATH named like the binary.
    mkdirSync(join(dirOnlyEntry, fakeName));
    // A real executable file in a later PATH entry.
    const binPath = join(realBinEntry, fakeName);
    writeFileSync(binPath, '#!/bin/sh\nexit 0\n');
    chmodSync(binPath, 0o755);
  });

  after(() => {
    process.env.PATH = originalPath;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('does not return a directory whose name matches the binary', () => {
    // Only the directory entry exists in PATH.
    process.env.PATH = dirOnlyEntry;
    assert.equal(which(fakeName), null);
  });

  it('skips a matching directory and finds the real executable later in PATH', () => {
    // Directory entry first, then the real binary entry. Pre-fix `which`
    // would return the directory path; post-fix it must skip past and find
    // the actual file.
    process.env.PATH = `${dirOnlyEntry}${delimiter}${realBinEntry}`;
    const got = which(fakeName);
    assert.equal(got, join(realBinEntry, fakeName));
  });
});
