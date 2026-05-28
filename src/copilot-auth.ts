import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getEnvApiKey } from '@earendil-works/pi-ai';
import {
  getGitHubCopilotBaseUrl,
  getOAuthApiKey,
  type OAuthCredentials,
  type OAuthProvider,
} from '@earendil-works/pi-ai/oauth';

type AuthMap = Record<string, OAuthCredentials & { type?: string; enterpriseUrl?: string }>;

const PROVIDER = 'github-copilot' satisfies OAuthProvider;

export interface GitHubCopilotCredentialsInfo {
  apiKey: string;
  baseUrl: string;
}

function authPathCandidates(): string[] {
  return [
    join(process.cwd(), 'auth.json'),
    join(homedir(), '.pi', 'agent', 'auth.json'),
  ];
}

function readAuth(path: string): AuthMap | undefined {
  if (!existsSync(path)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw) as AuthMap;
  } catch (err) {
    // A malformed candidate (typo, half-written file, foreign blob) must not
    // crash the whole auth resolver. Surface it on stderr and let the caller
    // fall through to the next candidate / return undefined cleanly so
    // `requireGitHubCopilotApiKey()` can produce its real error message.
    console.error(`warning: ignoring unparseable auth file ${path}: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Resolve the GitHub Copilot API key the same way pi users usually expect:
 *
 * 1. `COPILOT_GITHUB_TOKEN` from the environment, handled by `pi-ai`.
 * 2. `auth.json` in this repo, if present.
 * 3. `~/.pi/agent/auth.json`, where pi stores `/login` credentials.
 *
 * Refreshed OAuth credentials are written back to the file they came from.
 */
export async function getGitHubCopilotCredentialsInfo(): Promise<GitHubCopilotCredentialsInfo | undefined> {
  const envKey = getEnvApiKey(PROVIDER);
  if (envKey) {
    return {
      apiKey: envKey,
      baseUrl: getGitHubCopilotBaseUrl(envKey),
    };
  }

  for (const path of authPathCandidates()) {
    const auth = readAuth(path);
    const providerAuth = auth?.[PROVIDER];
    if (!auth || !providerAuth) continue;

    const result = await getOAuthApiKey(PROVIDER, auth);
    if (!result) continue;

    const refreshed: AuthMap[typeof PROVIDER] = { type: 'oauth', ...result.newCredentials };
    auth[PROVIDER] = refreshed;
    writeFileSync(path, `${JSON.stringify(auth, null, 2)}\n`);

    return {
      apiKey: result.apiKey,
      baseUrl: getGitHubCopilotBaseUrl(result.apiKey, refreshed.enterpriseUrl),
    };
  }

  return undefined;
}

export async function getGitHubCopilotApiKey(): Promise<string | undefined> {
  return (await getGitHubCopilotCredentialsInfo())?.apiKey;
}

export async function requireGitHubCopilotApiKey(): Promise<string> {
  const key = await getGitHubCopilotApiKey();
  if (!key) {
    throw new Error(
      'No GitHub Copilot credentials found. Set COPILOT_GITHUB_TOKEN or run `npx @earendil-works/pi-ai login github-copilot`.',
    );
  }
  return key;
}
