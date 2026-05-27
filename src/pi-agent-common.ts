import { Agent, type AgentEvent, type AgentTool, type ThinkingLevel } from '@earendil-works/pi-agent-core';
import { getModel } from '@earendil-works/pi-ai';

import { getGitHubCopilotCredentialsInfo } from './copilot-auth.js';

export const COPILOT_PROVIDER = 'github-copilot' as const;
export const COPILOT_MODEL = 'gpt-5.4-mini' as const;

export function reasoningEffortToThinkingLevel(effort: string | null | undefined): ThinkingLevel {
  if (effort === 'minimal' || effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh') return effort;
  return 'off';
}

export interface CreateCopilotAgentOptions {
  systemPrompt?: string;
  reasoningEffort?: string | null;
  sessionId?: string;
  tools?: AgentTool<any>[];
  onEvent?: (event: AgentEvent) => void;
}

export function createGitHubCopilotAgent(options: CreateCopilotAgentOptions = {}): Agent {
  // Important bit: GitHub Copilot provider model selection is provider + model,
  // not OpenAI provider. This is the shape that was easy to mix up.
  const baseModel = getModel(COPILOT_PROVIDER, COPILOT_MODEL);

  let cachedCredentials: Awaited<ReturnType<typeof getGitHubCopilotCredentialsInfo>> | undefined;
  const resolveCredentials = async () => {
    cachedCredentials ??= await getGitHubCopilotCredentialsInfo();
    return cachedCredentials;
  };

  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt ?? 'You are a concise, practical TypeScript coding assistant.',
      // pi-ai OAuth providers can customize model baseUrl from the refreshed
      // Copilot token. We mutate the selected model before returning the API key
      // because we are not using the pi coding-agent AuthStorage/model resolver.
      model: baseModel,
      thinkingLevel: reasoningEffortToThinkingLevel(options.reasoningEffort),
      tools: options.tools ?? [],
    },
    sessionId: options.sessionId,
    getApiKey: async (provider) => {
      if (provider !== COPILOT_PROVIDER) return undefined;
      const credentials = await resolveCredentials();
      if (!credentials) return undefined;
      baseModel.baseUrl = credentials.baseUrl;
      return credentials.apiKey;
    },
  });

  if (options.onEvent) {
    agent.subscribe((event) => {
      options.onEvent?.(event);
    });
  }

  return agent;
}

export function extractLastAssistantText(agent: Agent): string {
  const lastAssistant = [...agent.state.messages].reverse().find((message) => message.role === 'assistant');
  if (!lastAssistant || lastAssistant.role !== 'assistant') return '';

  return lastAssistant.content
    .filter((content) => content.type === 'text')
    .map((content) => content.text)
    .join('');
}

export function throwIfLastAssistantFailed(agent: Agent): void {
  const lastAssistant = [...agent.state.messages].reverse().find((message) => message.role === 'assistant');
  if (!lastAssistant || lastAssistant.role !== 'assistant') return;

  if (lastAssistant.stopReason === 'aborted') {
    const error = new Error(lastAssistant.errorMessage ?? 'GitHub Copilot request was aborted');
    error.name = 'AbortError';
    throw error;
  }

  if (lastAssistant.stopReason === 'error') {
    throw new Error(lastAssistant.errorMessage ?? 'GitHub Copilot request failed');
  }
}
