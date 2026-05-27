# dirtylaundry harness plan

A planner-emits-graph harness. The LLM never calls tools. Each turn it emits a
JSON `GraphSpec`. The harness validates, materializes a `ttasks` `TaskGraph`,
runs it, and feeds compact observations back in.

First app on the substrate: log review ("things you should know about today").

## Architecture

```txt
goal ──► Planner LLM ──► GraphSpec (JSON)
                          │
                          ▼
                  Materializer ── TaskGraph
                          │
                          ▼
                    ttasks Executor
                          │
                          ▼
                  Observation record
                          │
                          ▼
              feeds next Planner turn
                          │
                          ▼
              ... until { kind: "done", report }
```

## Contract

The planner returns exactly one JSON value per turn, one of:

```ts
{ kind: "graph", rationale: string, tasks: GraphTask[] }
{ kind: "done",  report: string }
```

`GraphTask`:

```ts
{
  id: string,
  type: "bash" | "read-log" | "journal" | "report" | "note",
  title?: string,
  payload: object,    // type-specific, validated by Zod
  after?: string[],
  timeout?: number
}
```

## Task type palette

Curated, not a generic tool catalog. Each has a typed payload and a policy-enforcing handler.

1. `journal` — `journalctl` with safe defaults. Payload: `{ since, priority?, unit?, grep?, maxLines<=2000 }`.
2. `read-log` — read a file under `/var/log/`. Payload: `{ path, tailLines<=2000, grep? }`.
3. `bash` — last resort. Payload: `{ command (allowlisted), args?: string[] }`. No shell, no pipes.
4. `report` — `Task.prompt` with a fixed system prompt. Payload: `{ prompt }`.
5. `note` — pure transform, no I/O. Payload: `{ text }`.

## Observation record

After a graph runs, one observation per task:

```ts
{
  id, type, status, durationMs,
  payloadEcho: object,
  output: { headLines, tailLines, totalLines, truncated },
  error?: string
}
```

Head+tail+count over full output. Token budget over completeness. If the
planner needs more, it issues a follow-up `read-log` with `grep`.

## Loop

```ts
for (let turn = 0; turn < maxTurns; turn++) {
  const raw = await planner.prompt(renderPlannerPrompt({ goal, palette, history }));
  const parsed = parsePlannerOutput(raw);                 // Zod
  if (parsed.kind === "done") return parsed.report;
  if (parsed.kind === "error") { history.push(parseError); continue; }
  await policyCheck(parsed.spec);
  if (interactive) await confirmPlan(parsed.spec);
  const graph = materialize(parsed.spec, executor);
  await graph.run(executor);
  history.push({ turn, spec: parsed.spec, observations: collect(graph, parsed.spec) });
  if (overBudget(history)) break;
}
```

## Build order

1. **Schemas + Zod** for `GraphSpec` and `Observation`.
2. **Materializer**: `GraphSpec` → `TaskGraph`.
3. **Handlers**: register `bash` (allowlisted), `read-log`, `journal`, `report`, `note`.
4. **Observation collector**: from a finished graph, build compact records.
5. **Planner agent**: reuse the Copilot-backed pi-agent-core agent. Strict JSON system prompt.
6. **Loop + budgets + plan confirmation**.
7. **CLI** entry: `logwatch "what should I know about today?"`.

Stop after step 4 to sanity-check schemas and palette before wiring the loop.

## Deliberate non-goals (for v1)

1. No streaming UI.
2. No tools-on-the-side. If the LLM needs X, X becomes a task type.
3. No cross-run memory store.
4. No multi-agent. One planner. Subordinate `prompt` tasks are *tasks*.
5. No code-emitting fallback. JSON plan or bust.

## The bet

For "gather → cross-reference → summarize" problems, planner-emits-graph is:

1. Easier to reason about than tools-in-a-loop.
2. Safer — plans are inspectable; policies attach to task types.
3. More token-efficient over multi-turn — observations are structured and compact.
4. More reusable — harness changes ~0 between domains; only the palette changes.

## Status

- [x] 1. schemas — `src/harness/schema.ts`, Zod + structural validate (unique ids, edges resolve, no cycles)
- [x] 2. materializer — `src/harness/materialize.ts`, `GraphSpec -> TaskGraph` via `Task.custom` + `Task.prompt`
- [x] 3. handlers — `src/harness/handlers.ts` (bash allowlist, read-log under /var/log, journal, note); report handled by `makeCopilotPromptHandler` + `PiAgentCopilotProvider`
- [x] 4. observation collector — `src/harness/observe.ts`, head+tail+count
- [ ] 5. planner agent
- [ ] 6. loop + budgets + confirmation
- [ ] 7. logwatch CLI

Smoke test: `pnpm harness:smoke` runs a hand-written `GraphSpec` end-to-end (no LLM) and prints observations. Pausing here per plan to sanity-check schemas and palette before wiring the planner loop.
