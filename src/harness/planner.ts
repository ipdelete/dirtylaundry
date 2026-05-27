import {
  COPILOT_MODEL,
  COPILOT_PROVIDER,
  createGitHubCopilotAgent,
  extractLastAssistantText,
  throwIfLastAssistantFailed,
} from '../pi-agent-common.js';
import { renderCapabilitiesForPlanner, type HostCapabilities } from './capabilities.js';
import type { Observation } from './observe.js';
import { PlannerOutput, validateGraphSpec, type GraphSpec } from './schema.js';

/**
 * The planner is a pi-agent-core Agent with no tools. Each turn it emits one
 * JSON value (a `GraphSpec` or a `done` signal). The harness validates,
 * runs the plan to completion (resolving control flow across batches),
 * then feeds all observations back next turn.
 */

export const PLANNER_SYSTEM_PROMPT = [
  'You are a planning agent. You output JSON only. No prose. No code fences.',
  '',
  'Each turn you produce exactly ONE JSON value matching one of these shapes:',
  '',
  'A) Graph plan:',
  '   {',
  '     "kind": "graph",',
  '     "rationale": string,',
  '     "nodes": [ Node, ... ]   // 1..32 top-level nodes',
  '   }',
  '',
  'B) Done signal:',
  '   {',
  '     "kind": "done",',
  '     "report": string   // your final "things you should know" summary',
  '   }',
  '',
  'A Node is either a LEAF (runs once) or a CONTROL node (if/foreach).',
  '',
  'Common fields on every node:',
  '   id:    unique within this graph; [A-Za-z0-9_-]+',
  '   title: optional human label',
  '   after: optional array of node ids that must finish first',
  '',
  'LEAF nodes have:  type, payload, optional timeout (seconds, <=600).',
  '  - journal:  payload { since, priority?, unit?, grep?, maxLines? (<=2000, default 500) }',
  '  - read-log: payload { path (MUST start with /var/log/), tailLines? (<=2000, default 500), grep? }',
  '  - bash:     payload { command, args? }',
  '              Allowed commands ONLY: uptime, who, last, df, free, systemctl, hostnamectl, uname, ss, lsblk, mount, ps, id, pgrep.',
  '              The Host context section below lists which of these actually exist on this host.',
  '              No shell, no pipes, no redirection. Args go in the array.',
  '  - report:   payload { prompt }   // calls a sub-LLM to produce a summary',
  '  - note:     payload { text }     // pure breadcrumb, no I/O',
  '',
  'CONTROL nodes:',
  '  if   { id, type: "if", cond, then: [LEAF,...], else?: [LEAF,...], after?, title? }',
  '         cond is one of:',
  '           { kind: "task_status",     task: id, equals: "succeeded"|"failed" }',
  '           { kind: "output_contains", task: id, substring: string }',
  '           { kind: "lines_gt",        task: id, n: integer }',
  '         The referenced cond.task is implicitly an `after` dep; the matching',
  '         branch runs in a later batch once cond is resolvable.',
  '  foreach { id, type: "foreach", over: { kind: "literal", items: [string,...] },',
  '            as: identifier, body: LEAF }',
  '            `${as}` in any string field of `body` is substituted per item.',
  '            All expanded leaves run in parallel.',
  '',
  'Execution model: you emit ONE plan per turn. The harness drives it to',
  'completion across as many internal batches as needed, then returns the',
  'observations of every leaf (top-level and expanded). Use `if`/`foreach`',
  'aggressively instead of waiting a turn just to branch or fan out.',
  '',
  'Rules:',
  ' - Output exactly one JSON value. Nothing else.',
  ' - Prefer parallelism. Only set `after` for true data dependencies.',
  ' - On the last turn, return { "kind": "done", "report": ... }.',
  ' - Do not invent task types, commands, or fields. Stay strictly within the schema.',
  ' - PALETTE GAP RULE: If the goal cannot be honestly answered with the available',
  '   task types AND the host context below, do not contort or guess. Return',
  '   { "kind": "done", "report": ... } immediately, stating plainly which task',
  '   type(s) or host capabilities would be needed. A short, honest "cannot answer',
  '   with this palette" report is better than a confident-looking report built on',
  '   data you could not actually gather.',
].join('\n');

export interface RenderGoalOptions {
  goal: string;
  maxTurns: number;
  capabilities: HostCapabilities;
}

export function renderGoalMessage(options: RenderGoalOptions): string {
  return [
    `Goal: ${options.goal}`,
    `Budget: up to ${options.maxTurns} turns. Use "done" to end early.`,
    '',
    'Host context:',
    renderCapabilitiesForPlanner(options.capabilities),
    '',
    'Produce the first JSON value now.',
  ].join('\n');
}

export interface RenderFeedbackOptions {
  observations: Observation[];
  remainingTurns: number;
}

export function renderObservationFeedback(options: RenderFeedbackOptions): string {
  return [
    `Remaining turns: ${options.remainingTurns}`,
    'Observations from every leaf executed in the previous plan (JSON):',
    JSON.stringify(options.observations, null, 2),
    '',
    'Produce the next JSON value now.',
  ].join('\n');
}

export function renderErrorFeedback(error: string, remainingTurns: number): string {
  return [
    `Remaining turns: ${remainingTurns}`,
    `Your previous output was rejected: ${error}`,
    'Produce a corrected JSON value now.',
  ].join('\n');
}

/** Tolerant JSON extraction. Models occasionally wrap output in ```json fences
 * despite instructions. */
export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

export type PlannerParseResult =
  | { kind: 'graph'; spec: GraphSpec }
  | { kind: 'done'; report: string }
  | { kind: 'error'; error: string; raw: string };

export function parsePlannerOutput(raw: string): PlannerParseResult {
  let json: unknown;
  try {
    json = JSON.parse(extractJson(raw));
  } catch (err) {
    return { kind: 'error', error: `not valid JSON: ${(err as Error).message}`, raw };
  }
  const parsed = PlannerOutput.safeParse(json);
  if (!parsed.success) {
    return {
      kind: 'error',
      error: `schema validation failed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      raw,
    };
  }
  if (parsed.data.kind === 'done') return { kind: 'done', report: parsed.data.report };
  const structural = validateGraphSpec(parsed.data);
  if (!structural.ok) return { kind: 'error', error: `structural validation failed: ${structural.error}`, raw };
  return { kind: 'graph', spec: parsed.data };
}

export interface PlannerOptions {
  systemPrompt?: string;
  reasoningEffort?: string | null;
}

export interface Planner {
  next(input: string): Promise<string>;
  abort(): void;
}

export function createPlanner(options: PlannerOptions = {}): Planner {
  const agent = createGitHubCopilotAgent({
    systemPrompt: options.systemPrompt ?? PLANNER_SYSTEM_PROMPT,
    reasoningEffort: options.reasoningEffort,
  });
  return {
    async next(input: string): Promise<string> {
      await agent.prompt(input);
      throwIfLastAssistantFailed(agent);
      return extractLastAssistantText(agent);
    },
    abort(): void {
      agent.abort();
    },
  };
}

export const PLANNER_MODEL_INFO = `${COPILOT_PROVIDER}/${COPILOT_MODEL}`;
