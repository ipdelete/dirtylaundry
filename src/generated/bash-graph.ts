import { Task, TaskExecutor, TaskGraph, TaskType, createBashHandler } from "@ianphil/ttasks-ts";

const executor = new TaskExecutor();
executor.register(TaskType.BASH, createBashHandler());

const task = Task.bash('echo "hello world"', { title: "hello-world" });

const graph = new TaskGraph({ title: "demo" });
graph.add(task);

await graph.run(executor);

console.log(task.status);
console.log(task.result?.output.trim());
