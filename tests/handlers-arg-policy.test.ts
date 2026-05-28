import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BASH_ARG_POLICIES } from '../src/harness/handlers.js';

describe('BASH_ARG_POLICIES', () => {
  describe('systemctl', () => {
    const policy = BASH_ARG_POLICIES.systemctl;
    it('allows safe flags and a unit name', () => {
      assert.equal(policy(['--failed']), null);
      assert.equal(policy(['status', 'nginx.service']), null);
      assert.equal(policy(['status', 'sshd']), null);
    });
    it('rejects shell metacharacters in unit names', () => {
      assert.match(policy(['status', 'nginx;rm -rf /'])!, /disallowed systemctl arg/);
      assert.match(policy(['status', '$(id)'])!, /disallowed systemctl arg/);
    });
  });

  describe('df', () => {
    const policy = BASH_ARG_POLICIES.df;
    it('allows absolute paths and simple flags', () => {
      assert.equal(policy(['/']), null);
      assert.equal(policy(['-h', '/var']), null);
      assert.equal(policy(['--human-readable']), null);
    });
    it('rejects non-absolute paths', () => {
      assert.match(policy(['var/log'])!, /disallowed arg/);
      assert.match(policy(['../etc'])!, /disallowed arg/);
    });
  });

  describe('pgrep', () => {
    const policy = BASH_ARG_POLICIES.pgrep;
    it('allows process names and short flags', () => {
      assert.equal(policy(['-f', 'node']), null);
      assert.equal(policy(['/usr/bin/sshd']), null);
    });
    it('rejects shell metacharacters', () => {
      assert.match(policy(['; rm -rf /'])!, /disallowed pgrep arg/);
      assert.match(policy(['$(whoami)'])!, /disallowed pgrep arg/);
    });
  });

  describe('uname (simpleFlagPolicy)', () => {
    const policy = BASH_ARG_POLICIES.uname;
    it('accepts no args', () => {
      assert.equal(policy([]), null);
    });
    it('accepts short and long flags', () => {
      assert.equal(policy(['-a']), null);
      assert.equal(policy(['--all']), null);
    });
    it('rejects anything that is not a flag', () => {
      assert.match(policy(['/etc/passwd'])!, /disallowed arg/);
      assert.match(policy(['; ls'])!, /disallowed arg/);
    });
  });
});
