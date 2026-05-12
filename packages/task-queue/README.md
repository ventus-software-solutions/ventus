# @ventus-software-solutions/task-queue

File-based stateless-facade task queue with pluggable storage.

## Quick start

```ts
import { FileStorage, TaskQueue } from '@ventus-software-solutions/task-queue';

const queue = new TaskQueue({
  storage: new FileStorage('./tasks.json'),
  maxEvents: 1000,
});

await queue.enqueue('send digest email', {
  priority: 'high',
  source: 'application',
  metadata: { accountId: 'acct_123' },
});

const task = await queue.claimNext();
if (task) {
  await queue.completeCurrent({ ok: true });
}
```

## API surface

```ts
class TaskQueue {
  constructor(options: { storage: Storage; maxEvents?: number });

  enqueue(description: string, opts?: EnqueueOptions): Promise<Task>;
  changePriority(taskId: string, newPriority: TaskPriority): Promise<Task | null>;
  claimNext(): Promise<Task | null>;
  completeCurrent(result?: unknown): Promise<CompletedTask | null>;
  failCurrent(error: Error | string): Promise<CompletedTask | null>;
  retry(taskId: string, opts?: RetryOptions): Promise<Task | null>;
  cancel(taskId: string, reason?: string): Promise<CompletedTask | null>;
  supersede(taskId: string, replacement: EnqueueReplacement): Promise<Task | null>;
  get(taskId: string): Promise<Task | CompletedTask | null>;
  list(filter?: TaskFilter): Promise<FilteredTasks>;
  peek(): Promise<TaskQueueState>;
}

interface Storage {
  read(): Promise<TaskQueueState>;
  write(state: TaskQueueState): Promise<void>;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}
```

`FileStorage` is the included `Storage` implementation. It stores JSON on disk, serializes mutations with `proper-lockfile`, and writes via atomic temp-file rename.

The public `Task` type carries `id`, `description`, `priority`, `source`, `addedAt`, `attempt`, optional `availableAt`, optional `parentTaskId`, and optional `metadata: Record<string, unknown>` for application-specific data. AIDE-specific fields such as agreement state and source references are intentionally excluded.

## Lifecycle behavior

- `claimNext()` returns the existing current task if one is active; otherwise it claims the highest-priority pending task whose `availableAt` is not in the future.
- `completeCurrent(result)` moves the current task to `done` with outcome `completed`.
- `failCurrent(error)` moves the current task to `done` with outcome `failed` and serializes `Error.cause` recursively when present.
- `retry(taskId, { delayMs })` creates a new pending task for a failed or superseded done task, links it with `parentTaskId`, increments `attempt`, and sets `availableAt` when delayed.
- `cancel(taskId, reason)` moves a pending or current task to `done` with outcome `cancelled`.
- `supersede(taskId, replacement)` moves a pending or current task to `done` with outcome `superseded` and enqueues the replacement task.
- `get(taskId)` reads a task across current, pending, and done states.
- `list(filter)` returns `FilteredTasks` and can filter by `status`, `priority`, `source`, `outcome`, and `includeUnavailable`.

Lifecycle events are stored in `TaskQueueState.events` and bounded by `maxEvents` (default `1000`; pass `Infinity` for an unbounded in-state audit history). This keeps v0.2.0 storage simple while preserving enough lifecycle history for package consumers.
