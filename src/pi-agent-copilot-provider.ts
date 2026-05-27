import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import type {
  CopilotProvider,
  CopilotProviderSession,
  CopilotSendOptions,
  CopilotSessionCreateOptions,
} from '@ianphil/ttasks-ts';

import {
  createGitHubCopilotAgent,
  extractLastAssistantText,
  throwIfLastAssistantFailed,
} from './pi-agent-common.js';

export interface PiAgentCopilotProviderOptions {
  systemPrompt?: string;
  tools?: AgentTool<any>[];
}

/**
 * ttasks-ts CopilotProvider adapter backed by pi-agent-core.
 *
 * ttasks-ts thinks it is talking to a Copilot-like provider. Underneath, each
 * provider session is a pi-agent-core Agent using:
 *
 *   getModel('github-copilot', 'gpt-5.4-mini')
 */
export class PiAgentCopilotProvider implements CopilotProvider {
  public constructor(private readonly options: PiAgentCopilotProviderOptions = {}) {}

  public async createSession(options: CopilotSessionCreateOptions): Promise<CopilotProviderSession> {
    const agent = createGitHubCopilotAgent({
      systemPrompt: this.options.systemPrompt,
      reasoningEffort: options.reasoningEffort,
      sessionId: typeof options.sessionOptions?.sessionId === 'string' ? options.sessionOptions.sessionId : undefined,
      tools: options.tools ? (this.options.tools ?? []) : [],
      onEvent: (event) => options.onEvent?.(event),
    });

    if (options.workingDirectory) {
      agent.state.messages.push({
        role: 'user',
        content: `Working directory hint: ${options.workingDirectory}`,
        timestamp: Date.now(),
      });
    }

    return new PiAgentCopilotProviderSession(agent);
  }
}

class PiAgentCopilotProviderSession implements CopilotProviderSession {
  public constructor(private readonly agent: Agent) {}

  public async sendAndWait(prompt: string, options: CopilotSendOptions): Promise<unknown> {
    if (options.signal?.aborted) throwAbortError();

    const onAbort = (): void => {
      this.agent.abort();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const promptPromise = this.agent.prompt(prompt);
      const timeoutSeconds = options.timeout;
      const raced = timeoutSeconds === null || timeoutSeconds === undefined
        ? promptPromise
        : Promise.race([
            promptPromise,
            new Promise<never>((_, reject) => {
              timeout = setTimeout(() => {
                this.agent.abort();
                reject(new Error(`pi-agent-core turn timed out after ${String(timeoutSeconds)}s`));
              }, Math.ceil(timeoutSeconds * 1000));
            }),
          ]);

      await raced;
      if (options.signal?.aborted) throwAbortError();
      throwIfLastAssistantFailed(this.agent);
      return { assistantText: extractLastAssistantText(this.agent) };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  public abort(): void {
    this.agent.abort();
  }

  public close(): void {
    this.agent.abort();
  }
}

function throwAbortError(): never {
  const error = new Error('aborted');
  error.name = 'AbortError';
  throw error;
}
