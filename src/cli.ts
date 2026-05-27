import { requireGitHubCopilotApiKey } from './copilot-auth.js';
import { runHarness } from './harness/loop.js';
import { PLANNER_MODEL_INFO } from './harness/planner.js';

/**
 * dirtylaundry: planner-emits-graph harness CLI.
 *
 * Usage:
 *   dirtylaundry [flags] [goal...]
 *   echo "goal" | dirtylaundry [flags]
 *
 * If no goal is given as args and stdin is piped, the goal is read from stdin.
 * If no goal is given and stdin is a TTY, a sensible default is used.
 */

interface Args {
  goal: string;
  interactive: boolean;
  maxTurns?: number;
  store: 'sqlite' | 'none';
  reasoning?: string;
  goalFromStdin: boolean;
}

async function readStdin(): Promise<string> {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data.trim();
}

async function parseArgs(argv: string[]): Promise<Args> {
  const args: Args = {
    goal: '',
    interactive: false,
    store: 'sqlite',
    goalFromStdin: false,
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--interactive' || a === '-i') args.interactive = true;
    else if (a === '--no-store') args.store = 'none';
    else if (a === '--max-turns') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) throw new Error('--max-turns expects a positive integer');
      args.maxTurns = Math.floor(n);
    } else if (a === '--reasoning') {
      args.reasoning = argv[++i];
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: dirtylaundry [--interactive] [--max-turns N] [--no-store] [--reasoning low|medium|high] [goal...]');
      console.log('       echo "goal" | dirtylaundry [flags]');
      process.exit(0);
    } else {
      rest.push(a);
    }
  }
  if (rest.length > 0) {
    args.goal = rest.join(' ');
  } else if (!process.stdin.isTTY) {
    const piped = await readStdin();
    if (piped) {
      args.goal = piped;
      args.goalFromStdin = true;
    }
  }
  if (!args.goal) {
    args.goal = 'Review system state and tell me anything I should know about from the last 24 hours.';
  }
  return args;
}

const args = await parseArgs(process.argv.slice(2));
await requireGitHubCopilotApiKey();

console.log(`dirtylaundry using planner=${PLANNER_MODEL_INFO}`);
console.log(`goal${args.goalFromStdin ? ' (from stdin)' : ''}: ${args.goal}`);

const result = await runHarness({
  goal: args.goal,
  interactive: args.interactive,
  maxTurns: args.maxTurns,
  store: args.store,
  reasoningEffort: args.reasoning,
});

console.log(`\n=== run finished: ${result.status} ===`);
if (result.report) {
  console.log('\n--- report ---');
  console.log(result.report);
}
if (result.persistenceErrors.length > 0) {
  console.error(`\npersistence errors: ${result.persistenceErrors.length}`);
  for (const e of result.persistenceErrors) console.error(`  ${e.kind} ${e.id}: ${e.error}`);
}
process.exit(result.status === 'done' ? 0 : 1);
