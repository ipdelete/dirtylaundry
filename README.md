# dirtylaundry

Experimental circular integration spike:

```txt
pi-agent-core creates/uses ttasks-ts graph code
ttasks-ts PROMPT handler uses a CopilotProvider backed by pi-agent-core
```

This repo intentionally demonstrates the odd loop where `@earendil-works/pi-agent-core` is used to generate `@ianphil/ttasks-ts` graph code, and `ttasks-ts` prompt tasks then call back into a `CopilotProvider` implemented with `pi-agent-core`.

## Model/auth

The Copilot model is selected as:

```ts
getModel('github-copilot', 'gpt-5.4-mini')
```

Auth lookup order:

1. `COPILOT_GITHUB_TOKEN`
2. `./auth.json`
3. `~/.pi/agent/auth.json`

`auth.json` is gitignored.

## Commands

```bash
pnpm install
pnpm hello                 # pi-agent-core hello world
pnpm agent:create:bash     # LLM emits a bash-only ttasks graph (legacy spike)
pnpm graph:bash
pnpm agent:create:prompt   # LLM emits a bash+prompt ttasks graph (legacy spike)
pnpm graph:prompt
pnpm harness:smoke         # harness, no LLM, hand-written GraphSpec
pnpm start                 # harness, live (= `pnpm dirtylaundry`)
pnpm typecheck
```

## dirtylaundry

The planner (Copilot via pi-agent-core) emits a `GraphSpec` (JSON) each turn;
the harness validates, materializes a ttasks `TaskGraph`, runs it, and feeds
compact observations back in. No tools, only a curated task palette.

```bash
dirtylaundry                                    # default goal, sqlite store
dirtylaundry "Do a security review of the logs"
dirtylaundry --max-turns 3 "what changed?"
dirtylaundry --interactive                      # confirm each plan before run
dirtylaundry --no-store                         # skip sqlite persistence
echo "audit the last hour of journal warnings" | dirtylaundry
```

### Install the `dirtylaundry` command

One-line shim that execs the CLI via `tsx`:

```bash
mkdir -p ~/.local/bin
cat > ~/.local/bin/dirtylaundry <<'SHIM'
#!/usr/bin/env bash
DIRTYLAUNDRY_ROOT="${DIRTYLAUNDRY_ROOT:-$HOME/src/dirtylaundry}"
cd "$DIRTYLAUNDRY_ROOT" && exec ./node_modules/.bin/tsx src/cli.ts "$@"
SHIM
chmod +x ~/.local/bin/dirtylaundry
```

Make sure `~/.local/bin` is on your `PATH`. Set `DIRTYLAUNDRY_ROOT` if the
repo lives elsewhere.

### Persistence

Runs persist to `~/.local/state/dirtylaundry/runs.db` (or
`$XDG_STATE_HOME/dirtylaundry/runs.db`). Each task is stamped with metadata
`{specId, turn, rationale, specTaskId, specType}` so a future
`dirtylaundry runs show <id>` can reconstruct context.

### Task palette

Curated, not generic. The planner is told to return `done` with a "palette
gap" report rather than contort when a goal needs capabilities the palette
does not provide.

```txt
journal   journalctl with safe defaults
read-log  tail (+ optional grep) of a file under /var/log/
bash      allowlisted command + arg vector, no shell
report    Task.prompt backed by the pi-agent-core Copilot provider
note      pure breadcrumb, no I/O
```
