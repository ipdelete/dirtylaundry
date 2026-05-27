import {
  Task,
  TaskExecutor,
  TaskGraph,
  TaskType,
  createBashHandler,
  makeCopilotPromptHandler,
} from "@ianphil/ttasks-ts";
import { PiAgentCopilotProvider } from "../pi-agent-copilot-provider.js";

const provider = new PiAgentCopilotProvider({
  systemPrompt: "You answer prompt tasks briefly.",
});

const executor = new TaskExecutor();
executor.register(TaskType.BASH, createBashHandler());
executor.register(
  TaskType.PROMPT,
  makeCopilotPromptHandler({ provider, model: "gpt-5.4-mini", timeout: 60 }),
);

const bashTask = Task.bash("echo hello", { title: "hello" });
const promptTask = Task.prompt(
  "Write a one-sentence acknowledgement that the bash task already ran.",
  { title: "acknowledge bash" },
);

const graph = new TaskGraph({ title: "demo" });
graph.add(bashTask);
graph.add(promptTask, { after: [bashTask] });

await graph.run(executor);

console.log(bashTask.status);
console.log(bashTask.result?.output.trim());
console.log(promptTask.status);
console.log(promptTask.result?.output.trim());
