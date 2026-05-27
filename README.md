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
pnpm hello
pnpm agent:create:bash
pnpm graph:bash
pnpm agent:create:prompt
pnpm graph:prompt
pnpm typecheck
```
