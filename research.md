# Research Notes

Where `dirtylaundry` sits in the landscape of LLM agent harnesses, and what to
read to put the work in context. Captured 2026-05-27 after the v1 harness
shipped.

## What this harness actually is

A **planner-emits-graph** loop where:

- the LLM is in the **outer** loop (one LLM turn = one whole graph execution),
- it emits a **structured plan** (a typed JSON DAG), not function calls and not code,
- a real DAG executor runs it with parallelism and dependency semantics,
- a compact observation summary feeds the next turn.

That's a coherent design and it has a name in the literature. We did not
invent the category. We may have found an unusual point in its design space.

## Prior art, ordered by closeness

### 1. LLM Compiler (closest)

**"An LLM Compiler for Parallel Function Calling"** — Kim, Hooper, Gholami,
Dong, Li, Shen, Mahoney, Keutzer (UC Berkeley / ICML 2024, posted late 2023).

- arXiv: <https://arxiv.org/abs/2312.04511>
- Code: <https://github.com/SqueezeAILab/LLMCompiler>

LLM emits a DAG of tool calls with explicit dependencies, an executor runs the
independent nodes in parallel, a "joiner" LLM either finalizes or asks the
planner to replan. If you squint, that's exactly our architecture.

Differences from `dirtylaundry`:

- They encode the DAG via the function-calling API; we use a single JSON
  document validated by Zod.
- They have a separate joiner role; our planner does its own join via a
  `report` task it can schedule for itself.
- They target a generic tool catalog; we deliberately curate a narrow palette.
- Their motivation is parallelism for cost reduction. Ours is separating
  cognitive work (plan, synthesize) from mechanical work (gather) for
  auditability, sandboxing, and the palette-gap honesty property.

### 2. Plan-and-execute family

Same outer-loop shape: plan, then execute, then maybe replan. But "plan" is
typically a numbered list of natural-language steps, not a typed DAG. No
parallelism guarantees.

- **BabyAGI** (Nakajima, 2023): <https://github.com/yoheinakajima/babyagi>
- **LangChain `plan_and_execute`**:
  <https://blog.langchain.com/plan-and-execute-agents/>
- **ReWOO** — "Reasoning Without Observation" (Xu et al., 2023):
  <https://arxiv.org/abs/2305.18323>. Decouples reasoning from external
  observations; closer to our shape than vanilla plan-and-execute.

### 3. CodeAct / Executable Code Actions

**"Executable Code Actions Elicit Better LLM Agents"** — Wang, Chen, Wang, Du,
Chen, Han, Ji, Hovy, Neubig (ICML 2024).

- arXiv: <https://arxiv.org/abs/2402.01030>

LLM emits *code* instead of tool calls. Same idea of "emit a structured
artifact, run it, observe", but with code as the artifact, which we explicitly
rejected for security/eval reasons. The closest spiritual cousin to us on the
"structured artifact, not chat" axis.

### 4. Workflow engines + LLMs

Temporal / Inngest / Prefect with an LLM step. The LLM is usually *inside* a
hand-authored workflow, not authoring the workflow. We inverted that. No
canonical paper; mostly product writeups.

### 5. ReAct (the dominant pattern, what we are NOT)

**"ReAct: Synergizing Reasoning and Acting in Language Models"** — Yao, Zhao,
Yu, Du, Shafran, Narasimhan, Cao (ICLR 2023).

- arXiv: <https://arxiv.org/abs/2210.03629>

LLM in the inner loop, one tool per step. Categorically different cost shape
— tokens scale with depth × breadth because every step roundtrips through the
model. Our shape scales with depth only.

`pi-agent-core`'s default tool-calling mode is ReAct-flavored. We deliberately
gave the planner zero tools and made it emit JSON instead.

## What's distinctive about `dirtylaundry`

Not a new genus. Maybe a new species, maybe just careful engineering. Five
specific calls that I have not seen put together quite this way:

1. **JSON GraphSpec as a single document**, not a sequence of `tool_call`
   objects. The plan is inspectable, diffable, replayable, version-controllable.
   You can hand-author one — the smoke test is exactly that.
2. **Real typed DAG executor underneath** (`ttasks-ts`), not an ad-hoc runner.
   We inherit blocked-task semantics, persistence, metadata, parallelism for
   free. When the synthesizer task auto-blocked because its upstream
   `read-log` tasks failed in the SSH test, that was `ttasks` doing
   graph-correctness work, not us.
3. **Curated palette over generic catalog.** Five task types, each with a
   typed payload and a policy-enforcing handler. The bash allowlist is not a
   feature — it is a refusal to give the LLM a generic `bash` tool. Most
   published harnesses give the LLM the kitchen.
4. **Palette-gap rule baked into the planner.** "If you cannot honestly
   answer with what you have, say so and name what is missing." A cultural
   choice about how the agent should fail. The packages-update run showed it
   working: zero turns wasted, exact diagnosis of the missing capability. I
   do not recall seeing this surfaced explicitly in the literature — papers
   want to show successful task completion, not graceful refusal.
5. **Head+tail+count observations** instead of full tool output. Token budget
   over completeness. Small change, but it changes how big a graph can run
   before context blows up.

## Cognitive ratio framing

The interesting value proposition isn't parallelism (LLM Compiler already
claimed that). It's **separating the cognitive work from the mechanical
work** so the mechanical work is auditable, sandboxable, cheap, and parallel.

Concretely, on `"Do a security review of the logs"`:

```text
1 planner LLM call   (cognitive: what should we look at?)
3 mechanical tasks   in parallel, no LLM   (gather)
1 sub-LLM report     (cognitive: synthesize)
1 planner LLM call   (cognitive: are we done?)
```

Three model calls for the whole review. A ReAct agent on the same problem
would do five to ten. The interesting part is that the **cognitive ratio is
high** — almost every LLM call is doing real thinking, not bookkeeping.

That ratio is a testable, measurable property and is the angle most worth
pursuing if you ever want to write this up.

## How to describe `dirtylaundry` without overclaiming

> *"A planner-emits-graph harness in the LLM Compiler family, with a curated
> typed task palette over a real DAG executor, and a hard rule for honest
> palette-gap reporting."*

Specific, accurate, no overclaim. The pattern is rarely used in practice —
most agent harnesses you will touch are ReAct-style, and most structured-
planning work in the literature did not ship into general developer use. So
while the pattern is not novel, finding it cleanly implemented in a small
repo you can read in an afternoon is genuinely uncommon.

## Open questions worth exploring

1. **Does the palette-gap rule generalize?** It worked on a 2-clause
   pre-prompt addition on `gpt-5.4-mini`. Is the behavior stable across
   models? Does it hold under adversarial prompts that push the planner to
   "just try anything"?
2. **What is the right cognitive-ratio benchmark?** Cost-per-resolved-goal vs
   ReAct on a fixed task set. The harness already records per-turn token use
   indirectly (planner messages persisted via Agent state). A small
   benchmark harness comparing the two on the same goals would be a
   defensible empirical claim.
3. **Palette growth pressure.** When a real user works with this for a week,
   which palette gaps fire most? Those are the next task types to add. This
   is `dirtylaundry`'s own continuous learning loop — the agent tells you
   what to build next.
4. **Persistence beyond a run.** `runs.db` makes "what changed since
   yesterday" expressible as a query plus a `report` task. Has anyone built
   an agent harness where temporal diffing is a first-class primitive? Worth
   a literature pass.
5. **Could the planner itself be smaller?** GraphSpec is small JSON. A
   distilled model trained on `(goal, observations) -> GraphSpec` pairs from
   real runs could plausibly be much cheaper than `gpt-5.4-mini`. The LLM
   Compiler paper does this (`LLMCompiler-7B`). `runs.db` is already the
   training corpus.

## Further reading worth a pass

- **Toolformer** — Schick et al., 2023, <https://arxiv.org/abs/2302.04761>.
  Teaches LLMs to call tools via self-supervised data. Orthogonal to us but
  relevant for the smaller-planner question.
- **Voyager** — Wang et al., 2023, <https://arxiv.org/abs/2305.16291>. LLM
  agent that builds its own skill library. The opposite of our curated
  palette stance; useful as a foil.
- **HuggingGPT / TaskMatrix** — Shen et al., 2023,
  <https://arxiv.org/abs/2303.17580>. LLM as orchestrator over many tools.
  Plan structure is closer to a list than a DAG.
- **AutoGen** — Wu et al., 2023, <https://arxiv.org/abs/2308.08155>.
  Multi-agent conversation framework. Different axis (multi-agent), but
  relevant if `dirtylaundry`'s planner ever needs subagents that are not just
  prompt tasks.
- **OpenDevin / SWE-agent** — code-agent harnesses; different domain but
  similar architectural questions about action surface design.
