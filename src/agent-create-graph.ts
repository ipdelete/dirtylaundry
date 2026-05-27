import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { requireGitHubCopilotApiKey } from './copilot-auth.js';
import { COPILOT_MODEL, COPILOT_PROVIDER, createGitHubCopilotAgent, extractLastAssistantText, throwIfLastAssistantFailed } from './pi-agent-common.js';

const mode = process.argv[2] === 'prompt' ? 'prompt' : 'bash';
const outputPath = join(process.cwd(), 'src', 'generated', mode === 'prompt' ? 'bash-and-prompt-graph.ts' : 'bash-graph.ts');

await requireGitHubCopilotApiKey();

const agent = createGitHubCopilotAgent({
  systemPrompt: [
    'You are generating a single runnable TypeScript ESM file for a Node 24 project.',
    'Return only one ```ts code block. No prose outside the code block.',
    'Use @ianphil/ttasks-ts exactly as documented.',
  ].join('\n'),
  onEvent: (event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  },
});

const commonInstructions = [
  'The project package.json has type: module and uses tsx.',
  'Use top-level await.',
  'Import Task, TaskExecutor, TaskGraph, TaskType, and createBashHandler from @ianphil/ttasks-ts.',
  'Do not guess alternate APIs. Do not use `as any`.',
  'The exact API is: const executor = new TaskExecutor();',
  'The exact API is: executor.register(TaskType.BASH, createBashHandler());',
  'The exact API is: const task = Task.bash("echo hello", { title: "hello" });',
  'The exact API is: const graph = new TaskGraph({ title: "demo" });',
  'The exact API is: graph.add(task);',
  'The exact API is: await graph.run(executor);',
  'Print task.status and task.result?.output.trim().',
].join('\n');

const bashPrompt = [
  commonInstructions,
  'Create the smallest useful graph with one bash task that echoes a hello-world message.',
].join('\n\n');

const promptPrompt = [
  commonInstructions,
  'Also import makeCopilotPromptHandler from @ianphil/ttasks-ts.',
  'Also import { PiAgentCopilotProvider } from ../pi-agent-copilot-provider.js because this file will be saved under src/generated/.',
  'Construct const provider = new PiAgentCopilotProvider({ systemPrompt: "You answer prompt tasks briefly." });',
  'Register TaskType.PROMPT with makeCopilotPromptHandler({ provider, model: "gpt-5.4-mini", timeout: 60 }).',
  'Create one bash task and one Task.prompt task.',
  'Use this exact dependency API: graph.add(bashTask); graph.add(promptTask, { after: [bashTask] });',
  'Do not add promptTask with graph.add(promptTask) by itself.',
  'The prompt should ask for a one-sentence acknowledgement that the bash task already ran.',
].join('\n\n');

console.log(`Using ${COPILOT_PROVIDER}/${COPILOT_MODEL} to generate ${mode} graph...\n`);
await agent.prompt(mode === 'prompt' ? promptPrompt : bashPrompt);
throwIfLastAssistantFailed(agent);
process.stdout.write('\n');

const text = extractLastAssistantText(agent);
const code = extractTypeScriptCode(text);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${code.trim()}\n`);
console.log(`\nWrote ${outputPath}`);

function extractTypeScriptCode(text: string): string {
  const fenced = text.match(/```(?:ts|typescript)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1];

  if (text.includes("@ianphil/ttasks-ts") && text.includes('TaskGraph')) return text;

  throw new Error('Agent did not return a TypeScript code block.');
}
