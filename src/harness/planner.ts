import {
  COPILOT_MODEL,
  COPILOT_PROVIDER,
  createGitHubCopilotAgent,
  extractLastAssistantText,
  throwIfLastAssistantFailed,
} from '../pi-agent-common.js';
import type { Observation } from './observe.js';
import { PlannerOutput, validateGraphSpec, type GraphSpec } from './schema.js';

/**
 * The planner is a pi-agent-core Agent with no tools. Each turn it emits one
 * JSON value (a `GraphSpec` or a `done` signal). The harness validates and
 * either runs the graph or terminates.
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
  '     "tasks": [ GraphTask, ... ]   // 1..32 tasks',
  '   }',
  '',
  'B) Done signal:',
  '   {',
  '     "kind": "done",',
  '     "report": string   // your final "things you should know" summary',
  '   }',
  '',
  'GraphTask shape:',
  '   {',
  '     "id": string,                  // unique within this graph; [A-Za-z0-9_-]+',
  '     "type": one of ["journal","read-log","bash","report","note"],',
  '     "title": string?,',
  '     "payload": object,             // type-specific, see below',
  '     "after": [string]?,            // ids that must finish before this runs',
  '     "timeout": number?             // seconds, <=600',
  '   }',
  '',
  'Payload schemas:',
  '  journal:  { since: string, priority?: "emerg"|"alert"|"crit"|"err"|"warning"|"notice"|"info"|"debug", unit?: string, grep?: string, maxLines?: <=2000 (default 500) }',
  '  read-log: { path: string (MUST start with /var/log/), tailLines?: <=2000 (default 500), grep?: string }',
  '  bash:     { command: string, args?: string[] }',
  '            Allowed commands ONLY: uptime, who, last, df, free, systemctl, hostnamectl, uname, ss, lsblk, mount, ps, id, pgrep.',
  '            No shell, no pipes, no redirection. Args go in the array.',
  '  report:   { prompt: string }                  // calls a sub-LLM to produce a summary',
  '  note:     { text: string }                    // pure breadcrumb, no I/O',
  '',
  'Rules:',
  ' - Output exactly one JSON value. Nothing else.',
  ' - Prefer parallelism. Only set "after" for true data dependencies.',
  ' - Keep graphs small (3-8 tasks usually). Multiple turns are fine.',
  ' - On the last turn, return { "kind": "done", "report": ... }.',
  ' - For final synthesis, include a `report` task in an earlier turn so the report has fresh context, then summarize its output in your "done" report.',
  ' - Do not invent task types, commands, or fields. Stay strictly within the schema.',
].join('\n');

export interface PlannerTurnRecord {
  turn: number;
  spec?: GraphSpec;
  observations?: Observation[];
  parseError?: string;
  policyError?: string;
}

/**
 * The planner Agent keeps conversation history natively across `.prompt()`
 * calls, so we send only what's new each turn: the goal on turn 0, then
 * observations or error feedback on subsequent turns.
 */

export interface RenderGoalOptions {
  goal: string;
  maxTurns: number;
}

export function renderGoalMessage(options: RenderGoalOptions): string {
  return [
    `Goal: ${options.goal}`,
    `Budget: up to ${options.maxTurns} turns. Use "done" to end early.`,
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
    'Observations from the previous graph run (JSON):',
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

/**
 * Tolerant JSON extraction. Models occasionally wrap output in ```json fences
 * despite instructions. Strip what we can; let Zod fail loudly on anything
 * still malformed.
 */
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
