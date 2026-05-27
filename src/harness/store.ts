import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { SqliteStore } from '@ianphil/ttasks-ts';

/**
 * `~/.local/state/dirtylaundry/runs.db` by default; honours `$XDG_STATE_HOME`.
 *
 * The store is the lifecycle-state ledger ttasks writes as tasks transition.
 * Output, error, returncode, duration, terminationReason all land there.
 * Survives process crashes; `rm runs.db` resets the world.
 */
export function defaultRunsDbPath(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.local', 'state');
  return join(base, 'dirtylaundry', 'runs.db');
}

export function openRunsStore(path = defaultRunsDbPath()): SqliteStore {
  mkdirSync(dirname(path), { recursive: true });
  return new SqliteStore({ path });
}
