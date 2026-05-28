import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getGitHubCopilotCredentialsInfo } from '../src/copilot-auth.js';

describe('getGitHubCopilotCredentialsInfo with malformed auth.json', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const originalToken = process.env.COPILOT_GITHUB_TOKEN;
  let tmp: string;
  let originalErr: typeof console.error;
  let stderr: string[];

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'auth-test-'));
    writeFileSync(join(tmp, 'auth.json'), 'not json {');
  });

  after(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalToken === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
    else process.env.COPILOT_GITHUB_TOKEN = originalToken;
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.chdir(tmp);
    // Force HOME to the tmp dir too, so the ~/.pi/agent/auth.json candidate
    // also doesn't exist; both candidates resolve to either missing or
    // corrupt, and the function should return undefined cleanly.
    process.env.HOME = tmp;
    delete process.env.COPILOT_GITHUB_TOKEN;
    originalErr = console.error;
    stderr = [];
    console.error = (msg: unknown): void => { stderr.push(String(msg)); };
  });

  afterEach(() => {
    console.error = originalErr;
  });

  it('returns undefined and warns instead of throwing on malformed ./auth.json', async () => {
    // Pre-fix: JSON.parse would throw out of readAuth, killing the resolver
    // and preventing any subsequent candidate (or graceful "no credentials"
    // path) from running.
    const result = await getGitHubCopilotCredentialsInfo();
    assert.equal(result, undefined);
    assert.ok(
      stderr.some((line) => line.includes('ignoring unparseable auth file')),
      `expected a warning about the unparseable file, got: ${JSON.stringify(stderr)}`,
    );
  });
});
