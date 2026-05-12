# @ventus_software/task-queue

File-based stateless-façade task queue with pluggable storage. Battle-tested by [AIDE](https://github.com/ventus-software-solutions/about-aide).

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
const task = await queue.enqueue('Process invoice 1234', { priority: 'high' });

// Claim the next task (returns the current task if one is already claimed)
const next = await queue.claimNext();
if (next) {
  try {
    await doWork(next);
    await queue.completeCurrent({ ok: true });
  } catch (err) {
    await queue.completeCurrent({ error: String(err) });
  }
}

// Inspect state at any time
const state = await queue.peek();
```

## API surface

### `TaskQueue`

```ts
class TaskQueue {
  constructor(options: { storage: Storage });

  enqueue(description: string, opts?: EnqueueOptions): Promise<Task>;
  claimNext(): Promise<Task | null>;
  completeCurrent(result?: unknown): Promise<CompletedTask | null>;
  peek(): Promise<TaskQueueState>;
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

Atomic temp-file writes + `proper-lockfile` for cross-process locking. Backed by a single JSON file you choose.

```ts
class FileStorage implements Storage {
  constructor(filePath: string);
}
```

### Built-in `MemoryStorage` for tests

Not exported from the package — copy this pattern into your test suite:

```ts
class MemoryStorage implements Storage {
  state: TaskQueueState = { current: null, pending: [], done: [] };
  async read() { return structuredClone(this.state); }
  async write(state: TaskQueueState) { this.state = structuredClone(state); }
  async withLock<T>(fn: () => Promise<T>) { return fn(); }
}
```

## Extending the Task type

The public `Task` type carries `id`, `description`, `priority`, `source`, `addedAt`, and an optional `metadata: Record<string, unknown>` field for application-specific data.

If you need fields like `agreedBy: string` or `sourceRef: string`, put them in `metadata` rather than asking us to extend the public type. This is the same pattern AIDE uses for her own internal fields.

## Status

`v0.x.y` — actively developed. Public API may shift before `v1.0.0`. After `1.0.0` we follow [Semantic Versioning](https://semver.org/) strictly with deprecation periods documented in [CHANGELOG.md](./CHANGELOG.md).

## Provenance

This package is written and developed by AIDE — an autonomous AI agent maintained by [Ventus](https://ventus.works). Commits, PRs, and issue triage are AIDE's work, human-reviewed during early operation. See the AIDE repo for more on how that works.

## License

MIT. See [LICENSE](../../LICENSE).

---

Part of the [Ventus](https://ventus.works) open-source package family.
