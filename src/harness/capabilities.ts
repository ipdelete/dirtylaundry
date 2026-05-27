import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * Capability detection. Probes $PATH at startup so the harness can:
 *   1. Intersect the declared bash allowlist with what actually exists,
 *      producing an effective allowlist used by the bash handler.
 *   2. Tell the planner up-front what host it is on and which commands
 *      are available, so its palette-gap rule fires per-host instead of
 *      letting tasks fail with ENOENT in silence.
 *
 * Sync on purpose: we run this exactly once per process, before any tasks.
 */

/** The full set of commands the harness *could* allow, before host probing.
 * Mirrors `BASH_ALLOWLIST` in handlers.ts; kept here so capability detection
 * does not require importing the handler module. */
export const DECLARED_BASH_ALLOWLIST: readonly string[] = [
  'uptime',
  'who',
  'last',
  'df',
  'free',
  'systemctl',
  'hostnamectl',
  'uname',
  'ss',
  'lsblk',
  'mount',
  'ps',
  'id',
  'pgrep',
];

export interface HostCapabilities {
  platform: NodeJS.Platform;
  /** Subset of DECLARED_BASH_ALLOWLIST that exists on this host's $PATH. */
  effectiveBashAllowlist: ReadonlySet<string>;
  /** journalctl present and runnable. */
  hasJournalctl: boolean;
  /** tail present (read-log requires it). */
  hasTail: boolean;
  /** grep present (read-log --grep requires it). */
  hasGrep: boolean;
}

export function which(bin: string): string | null {
  const path = process.env.PATH ?? '';
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, bin);
    try {
      accessSync(full, constants.X_OK);
      return full;
    } catch {
      // try next entry
    }
  }
  return null;
}

export function detectCapabilities(): HostCapabilities {
  return {
    platform: process.platform,
    effectiveBashAllowlist: new Set(DECLARED_BASH_ALLOWLIST.filter((bin) => which(bin))),
    hasJournalctl: which('journalctl') !== null,
    hasTail: which('tail') !== null,
    hasGrep: which('grep') !== null,
  };
}

/** Render a short, planner-facing summary of capabilities. */
export function renderCapabilitiesForPlanner(caps: HostCapabilities): string {
  const bash = Array.from(caps.effectiveBashAllowlist).sort().join(', ') || '(none available)';
  const missing = DECLARED_BASH_ALLOWLIST.filter((b) => !caps.effectiveBashAllowlist.has(b));
  const missingLine = missing.length ? `Missing on this host: ${missing.sort().join(', ')}.` : 'All declared bash commands are available.';
  const journal = caps.hasJournalctl ? 'available' : 'NOT available (do not emit `journal` tasks; treat as palette gap)';
  const readlog = caps.hasTail ? `available${caps.hasGrep ? '' : ' (but `grep` is missing; do not use `read-log.grep`)'}` : 'NOT available';
  return [
    `Host platform: ${caps.platform}`,
    `Effective bash allowlist (only these will succeed): ${bash}.`,
    missingLine,
    `journal task: ${journal}.`,
    `read-log task: ${readlog}.`,
  ].join('\n');
}
