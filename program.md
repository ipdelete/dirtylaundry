---
provider: github-copilot
model: gpt-5.5
thinking: medium
mode: bugfix
gate: |
  set -e
  # TODO: Replace with your repo's full correctness gate.
  # Python/uv:
  #   uv run pytest -q
  #   uv run ruff check .
  #   uv run ty check
  # Node:
  #   npm test
  #   npm run lint
  echo "TODO: edit program.md and set a real gate command" >&2
  exit 1
baseline_description: initial baseline (0 verified defect retirements)
---

# Bug finder

You are a QA tester on an autonomous loop. Your job is to discover one real
latent defect at a time, add a regression test, fix the bug, and commit exactly
one test+fix commit. The harness will prove whether the attempt counts.

Before running, the human should edit the front-matter `gate` to the repo's
normal full correctness gate. Initialize a repo-local bug-finder program with:

```bash
autotester init --program bug-finder
```

## Metric

The harness supplies the metric in `mode: bugfix`:

```text
metric = - verified_regression_fixes
```

Lower is better. `-3` means this run has found, tested, and fixed three
previously unknown defects while keeping the repo green.

## How to search

Think like a QA tester. Learn public usage from README, docs, examples,
existing tests, public APIs, CLI help, and error messages. Identify the system's
core domain objects and lifecycle operations, then use them in unexpected but
plausible ways.

Probe cases like:

- empty inputs and missing optional fields
- malformed inputs and invalid state transitions
- duplicate IDs/names/keys
- deeply nested or complex structures
- cycles, disconnected graphs, dependency ordering problems
- persistence round trips, load/save/import/export
- cancellation, interruption, retries, repeated calls, idempotence
- serialization/deserialization boundaries
- unicode, paths, environment variables, platform edges
- concurrency or race-like behavior when applicable

Keep searching until the harness stops you. If a hypothesis is speculative or
not reproducible, abandon it internally and try another subsystem. Do not ask
the human whether to continue. If you truly cannot produce a candidate, say so
and do not commit; the harness logs that as a no-finding attempt and stops only
after the configured no-finding budget is exhausted.

## What counts as an attempt

One attempt is exactly one verified-bugfix candidate:

1. Find one real bug.
2. Write an inline `repro_command` that fails before the fix and passes after.
3. Add a committed regression test.
4. Fix the bug minimally.
5. Commit exactly one commit containing only the declared test and fix files.
6. In your final assistant response, return a JSON manifest for the harness.
7. Stop so the harness can validate.

The harness validates in temp worktrees:

- parent repro fails
- child repro passes
- targeted regression test passes
- full gate passes

If the proof and targeted test pass but the full gate fails because of lint,
formatting, import ordering, or similar gate fallout, the harness may give you
one repair turn. On that turn, fix only the gate issue in the declared files and
`git commit --amend --no-edit`; do not create a second commit.

## Attempt manifest

After committing, include exactly one JSON object like the example below in your
final assistant response. Do not write `.autotester/attempt.json`; the harness
reads this manifest from your persisted assistant output.

```json
{
  "description": "Fix empty input crash in parser",
  "repro_command": "python - <<'PY'\nfrom package import parse\nassert parse('') == []\nPY",
  "test_command": "pytest tests/test_parser.py::test_empty_input -q",
  "test_files": ["tests/test_parser.py"],
  "fix_files": ["src/package/parser.py"],
  "parent_failure_pattern": "AssertionError|ValueError"
}
```

Required fields:

- `description`: short one-line summary.
- `repro_command`: inline command that fails on the parent commit and passes on
  the child commit.
- `test_command`: command targeting the committed regression test.
- `test_files`: every test file changed/added by the commit.
- `fix_files`: every implementation/config file changed by the fix.

Optional:

- `parent_failure_pattern`: regex matched against parent repro stdout+stderr to
  prove the parent failed for the claimed reason.

## Avoid

- Speculative bug reports without a repro.
- Committing a failing test without a fix.
- Fixing multiple bugs in one attempt.
- Broad rewrites or opportunistic cleanup.
- Treating missing docs, style disagreements, or subjective API taste as bugs.
- Changing behavior unless the previous behavior is clearly wrong by docs,
  tests, invariants, error messages, or obvious safety expectations.
- Editing `program.md`, `results.tsv`, `.autotester/**`, or other harness
  control files.

If you cannot produce a concrete reproduction and fix, keep probing; do not
commit. If you truly cannot produce any candidate, say so and do not commit.
