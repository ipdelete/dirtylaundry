# dirtylaundry TODO

Goal: prove the deliberately circular integration:

```txt
pi-agent-core creates/uses ttasks-ts graph code
ttasks-ts PROMPT handler uses a CopilotProvider backed by pi-agent-core
```

Constraints:

- Dependencies come from package/repo sources, not local filesystem links.
- `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` come from npm.
- `@ianphil/ttasks-ts` comes from `github:ianphil/ttasks-ts#v0.3.0`.
- Model selection for Copilot must be `getModel('github-copilot', 'gpt-5.4-mini')`.

## Steps

- [x] Create repo scaffold in `~/src/dirtylaundry`.
- [x] Install packages via pnpm from package/repo sources.
- [x] Add TypeScript config and scripts.
- [x] Create a `pi-agent-core` hello-world script using GitHub Copilot model `gpt-5.4-mini`.
- [x] Add an agent script that asks `pi-agent-core` to create a ttasks graph with a bash task.
- [x] Implement a `ttasks-ts` `CopilotProvider` backed by `pi-agent-core`.
- [x] Add an agent script mode that asks `pi-agent-core` to create a ttasks graph with both bash and prompt tasks.
- [x] Add checked-in generated fallback graph files so the demo remains inspectable without live Copilot credentials.
- [x] Run live Copilot-backed scripts using existing pi credentials in `~/.pi/agent/auth.json`.

## Authentication notes

`pi-ai` can use any of:

1. `COPILOT_GITHUB_TOKEN` in the environment,
2. `auth.json` in this repo created by `npx @earendil-works/pi-ai login github-copilot`, or
3. existing pi credentials at `~/.pi/agent/auth.json`.

`auth.json` is gitignored. The code also applies the Copilot token-derived base URL before streaming, which avoids using the wrong default Copilot endpoint.

## Commands

```bash
pnpm hello
pnpm agent:create:bash
pnpm graph:bash
pnpm agent:create:prompt
pnpm graph:prompt
pnpm typecheck
```
