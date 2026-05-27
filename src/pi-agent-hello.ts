import { requireGitHubCopilotApiKey } from './copilot-auth.js';
import { COPILOT_MODEL, COPILOT_PROVIDER, createGitHubCopilotAgent, extractLastAssistantText, throwIfLastAssistantFailed } from './pi-agent-common.js';

await requireGitHubCopilotApiKey();

const agent = createGitHubCopilotAgent({
  systemPrompt: 'You are a tiny hello-world assistant. Keep answers short.',
  onEvent: (event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  },
});

console.log(`Using ${COPILOT_PROVIDER}/${COPILOT_MODEL}`);
await agent.prompt('Say hello from pi-agent-core in one short sentence.');
throwIfLastAssistantFailed(agent);

const text = extractLastAssistantText(agent).trim();
if (!text) {
  throw new Error('Agent returned no assistant text.');
}

if (!process.stdout.write('\n')) {
  await new Promise((resolve) => process.stdout.once('drain', resolve));
}
