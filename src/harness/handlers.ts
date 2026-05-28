import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import type { TaskContext } from '@ianphil/ttasks-ts';

import type { BashPayloadT, JournalPayloadT, NotePayloadT, ReadLogPayloadT } from './schema.js';

/**
 * Handlers for the task-type palette. Each handler:
 *  - Parses JSON payload from `context.payload` (the materializer encodes payloads as JSON).
 *  - Enforces policy (allowlists, path constraints).
 *  - Returns a `SubprocessCompletion`-shaped object so ttasks normalizes
 *    `stdout`/`stderr`/`returncode` into `task.result.output` cleanly.
 */

export interface HandlerResult {
  stdout: string;
  stderr: string;
  returncode: number;
}

export const BASH_ARG_POLICIES: Record<string, (args: string[]) => string | null> = {
  systemctl: (args) => {
    const allowed = new Set(['--failed', '--no-pager', 'status', 'list-units', 'list-unit-files', 'is-active', 'is-enabled', 'show']);
    // Verbs that mutate system state. The bare-name regex below also matches
    // these (since they're plain identifiers), so we must reject them
    // explicitly. Without this, e.g. `systemctl start nginx.service` slips
    // through because `start` matches /^[A-Za-z0-9_-]+$/ as if it were a
    // unit name.
    const denyVerbs = new Set([
      'start', 'stop', 'restart', 'reload', 'try-restart', 'reload-or-restart',
      'enable', 'disable', 'mask', 'unmask', 'preset', 'preset-all',
      'reenable', 'link', 'revert', 'edit', 'set-property',
      'kill', 'clean', 'freeze', 'thaw', 'reset-failed',
      'daemon-reload', 'daemon-reexec',
      'isolate', 'set-default', 'switch-root', 'exit',
      'reboot', 'poweroff', 'halt', 'kexec', 'suspend', 'hibernate', 'hybrid-sleep', 'suspend-then-hibernate',
      'emergency', 'rescue', 'default', 'cancel',
    ]);
    for (const a of args) {
      if (denyVerbs.has(a)) return `disallowed systemctl arg: ${a}`;
      if (!allowed.has(a) && !/^[A-Za-z0-9@._:+-]+\.(service|target|socket|timer|mount|path|scope|slice)$/.test(a) && !/^[A-Za-z0-9_-]+$/.test(a)) return `disallowed systemctl arg: ${a}`;
    }
    return null;
  },
  ps: (args) => {
    for (const a of args) if (!/^[A-Za-z0-9,=_-]+$/.test(a)) return `disallowed ps arg: ${a}`;
    return null;
  },
  ss: (args) => {
    for (const a of args) if (!/^-[A-Za-z]+$/.test(a) && !/^[A-Za-z0-9_:-]+$/.test(a)) return `disallowed ss arg: ${a}`;
    return null;
  },
  df: (args) => {
    for (const a of args) if (!a.startsWith('/') && !/^-{0,2}[A-Za-z0-9_-]+$/.test(a)) return `disallowed arg: ${a}`;
    return null;
  },
  free: simpleFlagPolicy,
  uptime: simpleFlagPolicy,
  who: simpleFlagPolicy,
  last: simpleFlagPolicy,
  hostnamectl: simpleFlagPolicy,
  uname: simpleFlagPolicy,
  lsblk: simpleFlagPolicy,
  mount: simpleFlagPolicy,
  id: simpleFlagPolicy,
  pgrep: (args) => {
    for (const a of args) if (!/^[A-Za-z0-9_.@:/-]+$/.test(a) && !/^-[A-Za-z]+$/.test(a)) return `disallowed pgrep arg: ${a}`;
    return null;
  },
};

function simpleFlagPolicy(args: string[]): string | null {
  for (const a of args) if (!/^-{0,2}[A-Za-z0-9_-]+$/.test(a)) return `disallowed arg: ${a}`;
  return null;
}

async function runProcess(
  command: string,
  args: string[],
  signal: AbortSignal,
  maxBytes = 1_000_000,
): Promise<HandlerResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C' },
    });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const append = (current: string, chunk: string): string => {
      if (current.length + chunk.length > maxBytes) {
        truncated = true;
        return current + chunk.slice(0, Math.max(0, maxBytes - current.length));
      }
      return current + chunk;
    };
    const onAbort = (): void => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: string) => { stderr = append(stderr, chunk); });
    child.on('error', (err) => {
      signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code, sig) => {
      signal.removeEventListener('abort', onAbort);
      const returncode = code ?? (sig ? -1 : 0);
      if (truncated) stderr = `${stderr}\n[truncated: max ${maxBytes} bytes]`;
      resolvePromise({ stdout, stderr, returncode });
    });
  });
}

function parsePayload<T>(context: TaskContext): T {
  return JSON.parse(context.payload) as T;
}

export interface BashHandlerOptions {
  /** Effective allowlist for this host. Subset of DECLARED_BASH_ALLOWLIST. */
  allowlist: ReadonlySet<string>;
}

export function makeBashHandler(options: BashHandlerOptions) {
  const { allowlist } = options;
  return async function bashHandler(context: TaskContext): Promise<HandlerResult> {
    const payload = parsePayload<BashPayloadT>(context);
    if (!allowlist.has(payload.command)) {
      throw new Error(`bash command not in effective allowlist for this host: ${payload.command}`);
    }
    const argErr = BASH_ARG_POLICIES[payload.command]?.(payload.args);
    if (argErr) throw new Error(`bash arg policy violation: ${argErr}`);
    return runProcess(payload.command, payload.args, context.signal);
  };
}

export async function readLogHandler(context: TaskContext): Promise<HandlerResult> {
  const payload = parsePayload<ReadLogPayloadT>(context);
  const path = resolve(payload.path);
  if (!path.startsWith('/var/log/')) throw new Error(`read-log path must be under /var/log/: ${path}`);
  if (!existsSync(path)) throw new Error(`read-log path does not exist: ${path}`);
  if (!statSync(path).isFile()) throw new Error(`read-log path is not a regular file: ${path}`);

  const args = ['-n', String(payload.tailLines), path];
  const tailed = await runProcess('tail', args, context.signal);
  if (!payload.grep) return tailed;

  return await new Promise((resolvePromise, reject) => {
    const child = spawn('grep', ['-E', '--', payload.grep!], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C' },
    });
    let stdout = '';
    let stderr = '';
    const onAbort = (): void => {
      child.kill('SIGTERM');
    };
    context.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.stderr.on('data', (c: string) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => {
      context.signal.removeEventListener('abort', onAbort);
      const returncode = code === 1 ? 0 : (code ?? 0);
      resolvePromise({ stdout, stderr, returncode });
    });
    child.stdin.end(tailed.stdout);
  });
}

export async function journalHandler(context: TaskContext): Promise<HandlerResult> {
  const payload = parsePayload<JournalPayloadT>(context);
  const args = ['--no-pager', '--output=short-iso', '--since', payload.since, '-n', String(payload.maxLines)];
  if (payload.priority) args.push('--priority', payload.priority);
  if (payload.unit) {
    if (!/^[A-Za-z0-9@._:+-]+$/.test(payload.unit)) throw new Error(`invalid unit name: ${payload.unit}`);
    args.push('-u', payload.unit);
  }
  if (payload.grep) args.push('--grep', payload.grep);
  return runProcess('journalctl', args, context.signal);
}

export async function noteHandler(context: TaskContext): Promise<HandlerResult> {
  const payload = parsePayload<NotePayloadT>(context);
  return { stdout: payload.text, stderr: '', returncode: 0 };
}
