# @ventus_software/task-queue

File-based stateless-façade task queue with pluggable storage. Battle-tested by [AIDE](https://github.com/ventus-software-solutions/aide).

## Why this exists

Most Node task queues require Redis (BullMQ, Bee-Queue) or a SQL backend. That's overkill for many projects — a small autonomous agent, a personal automation, a single-server app that just needs reliable durable task processing without spinning up infrastructure.

`@ventus_software/task-queue` is **storage-agnostic** with a battle-tested **file-based** backend included. The queue logic and the persistence are cleanly separated, so you can plug in your own storage (SQLite, Redis, in-memory for tests) without forking.

The design pattern — *stateless façade over single-source-of-truth file* — was developed inside AIDE to handle concurrent writers safely without a database. It's been running every minute of AIDE's autonomy loop for months.

## Install

```sh
npm install @ventus_software/task-queue
# or
pnpm add @ventus_software/task-queue
```

Requires Node 20+.

## Quick start

```ts
import { TaskQueue, FileStorage } from '@ventus_software/task-queue';

const queue = new TaskQueue({
  storage: new FileStorage('./tasks.json'),
});

// Enqueue
const task = queue.enqueue('Process invoice 1234', { priority: 'high' });

// Process
const next = queue.startNext();
if (next) {
  try {
    await doWork(next);
    queue.complete({ outcome: 'success' });
  } catch (err) {
    queue.complete({ outcome: 'failed', evidence: String(err) });
  }
}
```

## API surface

### `TaskQueue`

```ts
class TaskQueue {
  constructor(options: { storage: Storage });

  enqueue(description: string, opts?: EnqueueOptions): Task;
  startNext(): Task | undefined;
  complete(result: CompleteResult): void;
  removePending(id: string): boolean;
  head(): TaskQueueState;
}
```

### `Storage` (interface)

```ts
interface Storage {
  read(): Promise<TaskQueueState>;
  write(state: TaskQueueState): Promise<void>;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}
```

### `FileStorage` (the one included implementation)

```ts
class FileStorage implements Storage {
  constructor(path: string, opts?: FileStorageOptions);
}
```

## Extending the Task type

The public `Task` type carries `id`, `description`, `priority`, `source`, `addedAt`, and an optional `metadata: Record<string, unknown>` field for application-specific data.

If you need fields like `agreedBy: string` or `sourceRef: string`, put them in `metadata` rather than asking us to extend the public type. This is the same pattern AIDE uses for her own internal fields.

## Status

`v0.x.y` — actively developed. Public API may shift before `v1.0.0`. After `1.0.0` we follow [Semantic Versioning](https://semver.org/) strictly with deprecation periods documented in [CHANGELOG.md](./CHANGELOG.md).

## Provenance

This package is written and developed by AIDE — an autonomous AI agent maintained by [Ventus Software Solutions](https://github.com/ventus-software-solutions). Commits, PRs, and issue triage are AIDE's work, human-reviewed during early operation. See the AIDE repo for more on how that works.

## License

MIT. See [LICENSE](../../LICENSE).
