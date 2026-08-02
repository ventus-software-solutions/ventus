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
  idempotencyKey: 'digest:acct_123:2026-08-02',
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
  deferCurrent(opts?: DeferOptions): Promise<Task | null>;
  resumeCurrent(): Promise<Task | null>;
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

`FileStorage` is the included `Storage` implementation. It stores JSON on disk, serializes mutations with `proper-lockfile`, and writes via atomic temp-file rename. Implement `Storage` to use a database or another shared persistence layer.

The public `Task` type includes the task identity and payload, priority, source, timestamps, attempt number, deterministic queue sequence, and optional application metadata. It also supports:

- `idempotencyKey` to suppress duplicate active work.
- `blockedBy` to wait for successful completion of prerequisite task IDs.
- `availableAt` for delayed work.
- `parentTaskId` for retry and replacement lineage.
- `claimedAt`, `resumeCount`, and `lastResumedAt` for explicit worker restart tracking.

Task IDs use random UUIDs with a `task_` prefix. Existing JSON state remains readable; fields introduced in newer versions are optional when old tasks are loaded.

## Lifecycle behavior

- `enqueue(description, { idempotencyKey })` returns the existing current or pending task with that key. Once it is terminal, the key can be used for a new occurrence.
- `claimNext()` returns the existing current task if one is active; otherwise it claims the highest-priority available task whose `blockedBy` dependencies all completed successfully.
- `deferCurrent({ delayMs, priority, metadata })` returns the current task to the back of its priority band, optionally delaying it or changing its priority.
- `resumeCurrent()` explicitly records that a worker resumed the current task after a restart. Calling `claimNext()` repeatedly does not count as a resume.
- `completeCurrent(result)` moves the current task to `done` with outcome `completed`.
- `failCurrent(error)` moves the current task to `done` with outcome `failed` and serializes `Error.cause` recursively when present.
- `retry(taskId, { delayMs })` creates a new pending task for a failed or superseded done task, links it with `parentTaskId`, increments `attempt`, and sets `availableAt` when delayed.
- `cancel(taskId, reason)` moves a pending or current task to `done` with outcome `cancelled`.
- `supersede(taskId, replacement)` moves a pending or current task to `done` with outcome `superseded` and enqueues the replacement task.
- `get(taskId)` reads a task across current, pending, and done states.
- `list(filter)` returns `FilteredTasks` and can filter by `status`, `priority`, `source`, `outcome`, and `includeUnavailable`.

Lifecycle events are stored in `TaskQueueState.events` and bounded by `maxEvents` (default `1000`; pass `Infinity` for an unbounded in-state audit history). Events cover enqueueing and deduplication, claims and resumes, deferrals, completion and failure, retries, cancellation, priority changes, and superseding.

## Worker restart example

Persist the queue somewhere shared, then make worker startup explicit:

```ts
const state = await queue.peek();
const task = state.current ? await queue.resumeCurrent() : await queue.claimNext();

if (task) {
  try {
    const result = await perform(task);
    await queue.completeCurrent(result);
  } catch (error) {
    await queue.failCurrent(error);
  }
}
```

Only call `resumeCurrent()` when a new worker process intentionally takes over persisted current work. If multiple workers may run concurrently, coordinate worker ownership in your storage implementation or deployment layer; the queue intentionally exposes one current task rather than distributed leases.
