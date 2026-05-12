# @ventus-software-solutions/task-queue

## 0.2.0

### Minor Changes

- Production-grade task lifecycle surface.

  Added:

  - `failCurrent(error)` — distinct from `completeCurrent`. Moves the current task to `done` with `outcome: 'failed'` and a `SerializedTaskError`. Failed tasks are eligible for `retry`.
  - `retry(taskId, opts?)` — re-queues a failed or superseded task with a new id, links the new task to the original via `parentTaskId`, increments `attempt`, and optionally sets `availableAt` when `opts.delayMs` is provided.
  - `cancel(taskId, reason?)` — moves a pending or current task to `done` with `outcome: 'cancelled'`.
  - `supersede(taskId, replacement)` — atomically moves a pending or current task to `done` with `outcome: 'superseded'` and enqueues the replacement. Pending/current only; done tasks should be retried.
  - `get(taskId)` — reads a task across current, pending, and done.
  - `list(filter?)` — returns a `FilteredTasks` snapshot filterable by `status`, `outcome`, `priority`, `source`, and `includeUnavailable`.
  - `TaskOutcome` enum (`'completed' | 'failed' | 'cancelled' | 'superseded'`).
  - Lifecycle events on `TaskQueueState.events`, bounded by the new `maxEvents` constructor option (default `1000`; pass `Infinity` for unbounded in-state audit history).
  - `Task` fields: `attempt: number`, optional `availableAt?: string`, optional `parentTaskId?: string`.
  - `SerializedTaskError.cause` — recursive serialization of `Error.cause` chains.

  Changed:

  - `claimNext()` skips pending tasks whose `availableAt` is in the future. Ordering remains priority-first, FIFO-within-priority.
  - Public type renamed: `TaskQueueSnapshot` → `FilteredTasks`.

  Compatibility:

  - v0.1.0 state files read without migration tooling. Missing `attempt` defaults to `1`; missing `outcome` on completed tasks defaults to `'completed'`; missing `events` defaults to `[]` on first append.

## 0.1.0

### Minor Changes

- 3c86e4e: Initial release. File-based stateless-façade task queue with pluggable storage.

  - TaskQueue with enqueue / claimNext / completeCurrent / peek
  - Storage interface (read / write / withLock) decoupled from queue logic
  - FileStorage shipped (atomic temp-file writes + proper-lockfile)
  - Public Task type clean of agent-specific fields; metadata slot for extension

  Extracted from AIDE (https://github.com/ventus-software-solutions/about-aide).
