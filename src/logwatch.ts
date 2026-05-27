import { requireGitHubCopilotApiKey } from './copilot-auth.js';
import { runHarness } from './harness/loop.js';
import { PLANNER_MODEL_INFO } from './harness/planner.js';

/**
 * logwatch: first app on the planner-emits-graph substrate.
 *
 * Usage:
 *   pnpm logwatch [--interactive] [--max-turns N] [--no-store] [goal...]
 *
 * Default goal: "Review system state and tell me anything I should know about
 * from the last 24 hours."
 */

interface Args {
  goal: string;
  interactive: boolean;
  maxTurns?: number;
  store: 'sqlite' | 'none';
  reasoning?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    goal: '',
    interactive: false,
    store: 'sqlite',
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
      console.log('Usage: pnpm logwatch [--interactive] [--max-turns N] [--no-store] [--reasoning low|medium|high] [goal...]');
      process.exit(0);
    } else {
      rest.push(a);
    }
  }
  args.goal =
    rest.length > 0
      ? rest.join(' ')
      : 'Review system state and tell me anything I should know about from the last 24 hours.';
  return args;
}

const args = parseArgs(process.argv.slice(2));
await requireGitHubCopilotApiKey();

console.log(`logwatch using planner=${PLANNER_MODEL_INFO}`);
console.log(`goal: ${args.goal}`);

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
