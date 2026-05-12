# @ventus_software/task-queue v0.2.0 design

Status: reviewed by Claude; ready for operator final approval / implementation  
Scope: design only; no implementation in this slice

## Goal

Move the package from a minimal file-backed queue to a small production-grade task lifecycle surface without importing AIDE-specific workflow semantics. v0.2.0 should make failures, retries, cancellation, supersession, task lookup, filtering, and lifecycle events explicit while preserving the current stateless facade and pluggable `Storage` model.

## Current v0.1.0 baseline

The current public surface is intentionally small:

- `enqueue(description, opts)` appends a pending task.
- `changePriority(taskId, newPriority)` reorders urgency without changing task identity.
- `claimNext()` moves the highest-priority pending task into `current`.
- `completeCurrent(result?)` moves `current` into `done`.
- `peek()` returns the full `TaskQueueState`.
- `FileStorage` provides locked JSON read/write with atomic temp-file rename.

Current state shape:

```ts
interface TaskQueueState {
  current: Task | null;
  pending: Task[];
  done: CompletedTask[];
}
```

## Design principles

1. **Generic package, not AIDE transplant** — support common queue lifecycle concepts, but do not expose AIDE fields like `agreed`, `sourceRef`, parked operator workflow, or wiki/task-specific status names.
2. **One writer path** — all mutations continue to route through `TaskQueue` and `Storage.withLock`; no separate event writer should mutate state outside the queue facade.
3. **Backwards-compatible reads where practical** — v0.1.0 state should load without migration tooling. Missing new fields default to sensible values.
4. **Terminal outcome is distinct from task status** — a task can be `done` with `outcome: 'completed' | 'failed' | 'cancelled' | 'superseded'`.
5. **Retry creates a new pending attempt** — retry should preserve provenance from the failed/superseded task while producing a claimable task with its own id and attempt count.
6. **Events are append-only observability, not the source of truth** — lifecycle events help audit/debug, while `current`/`pending`/`done` remain canonical state.

## Proposed types

```ts
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TaskSource = 'user' | 'system' | 'application';
export type TaskStatus = 'pending' | 'current' | 'done';
export type TaskOutcome = 'completed' | 'failed' | 'cancelled' | 'superseded';

export interface Task {
  id: string;
  description: string;
  priority: TaskPriority;
  source: TaskSource;
  addedAt: string;
  attempt: number;
  availableAt?: string;
  parentTaskId?: string;
  metadata?: Record<string, unknown>;
}

export interface CompletedTask extends Task {
  completedAt: string;
  outcome: TaskOutcome;
  result?: unknown;
  error?: SerializedTaskError;
  supersededBy?: string;
}

export interface SerializedTaskError {
  name?: string;
  message: string;
  stack?: string;
  cause?: SerializedTaskError;
}

export interface TaskQueueState {
  current: Task | null;
  pending: Task[];
  done: CompletedTask[];
  events?: TaskLifecycleEvent[];
}
```

Compatibility rule: existing tasks without `attempt` are treated as `attempt: 1`; existing completed tasks without `outcome` are treated as `outcome: 'completed'`.

## Proposed API

```ts
class TaskQueue {
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
```

### `failCurrent(error)`

Fails the currently claimed task. This is intentionally distinct from `completeCurrent` and intentionally names `Current` for symmetry with `completeCurrent`; pending tasks can be cancelled but not failed because they were never attempted.

Behavior:

- If `current` is `null`, return `null`.
- Serialize `Error|string` into `SerializedTaskError`.
- Move `current` to `done` with `outcome: 'failed'`, `completedAt`, and `error`.
- Clear `current`.
- Append a lifecycle event: `task.failed`.
- The failed task becomes eligible for `retry`.

Review decision: use `failCurrent`, not `fail`, to avoid implying arbitrary `fail(taskId)` semantics.

### `retry(taskId, opts?)`

Re-queues a task that ended with `outcome: 'failed'` or `outcome: 'superseded'`.

```ts
interface RetryOptions {
  attempt?: number;
  delayMs?: number;
  priority?: TaskPriority;
  metadata?: Record<string, unknown>;
}
```

Behavior:

- Find `taskId` in `done`.
- Return `null` if not found or if outcome is not retryable.
- Create a new pending `Task` with a new `id`.
- Copy `description`, `source`, and metadata from the original unless overridden.
- Set `parentTaskId` to the original task id.
- Set `attempt` to `opts.attempt ?? original.attempt + 1`.
- If `delayMs` is provided, set `availableAt = now + delayMs`.
- Append `task.retried` event with both ids.

Claiming rule: `claimNext()` skips pending tasks whose `availableAt` is in the future.

### `cancel(taskId, reason?)`

Cancels a pending or current task without treating it as a failure.

Behavior:

- If task is pending, remove it from `pending` and add to `done` with `outcome: 'cancelled'`.
- If task is current, clear `current` and add to `done` with `outcome: 'cancelled'`.
- If task is already done or missing, return `null`.
- Store `result: { reason }` when reason is provided.
- Append `task.cancelled` event.

### `supersede(taskId, replacement)`

Marks a pending/current task as superseded and enqueues a replacement in one locked mutation.

```ts
interface EnqueueReplacement extends EnqueueOptions {
  description: string;
}
```

Behavior:

- If original is pending/current, move it to `done` with `outcome: 'superseded'`.
- Enqueue replacement task with new id.
- Set original `supersededBy` to replacement id.
- Set replacement `parentTaskId` to original id.
- Append `task.superseded` and `task.enqueued` events.
- Return replacement task.

Review decision: `supersede` only applies to pending/current tasks. Done tasks, including failed tasks, are historical records; callers should use `retry` for failed or superseded done tasks.

### `get(taskId)` and `list(filter?)`

`get` searches current, pending, and done tasks by id.

`list` returns a stable snapshot without requiring callers to know the internal state layout.

```ts
interface TaskFilter {
  status?: TaskStatus | TaskStatus[];
  outcome?: TaskOutcome | TaskOutcome[];
  priority?: TaskPriority | TaskPriority[];
  source?: TaskSource | TaskSource[];
  includeUnavailable?: boolean;
}

interface FilteredTasks {
  current: Task | null;
  pending: Task[];
  done: CompletedTask[];
}
```

Default `list()` returns all tasks, including unavailable delayed retry tasks. `includeUnavailable` defaults to `true` for list/filter reads; `claimNext()` always treats future `availableAt` tasks as unavailable and skips them.

## Lifecycle events

Lifecycle events are stored in `TaskQueueState.events` for v0.2.0. A separate subscriber/event-sink pattern is deferred until v0.3 unless a real consumer appears. In-state event history is bounded by `TaskQueueOptions.maxEvents` (default 1000; `Infinity` keeps all events).

```ts
export type TaskLifecycleEventType =
  | 'task.enqueued'
  | 'task.priority_changed'
  | 'task.claimed'
  | 'task.completed'
  | 'task.failed'
  | 'task.retried'
  | 'task.cancelled'
  | 'task.superseded';

export interface TaskLifecycleEvent {
  id: string;
  type: TaskLifecycleEventType;
  taskId: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

interface TaskQueueOptions {
  storage: Storage;
  maxEvents?: number; // default 1000; pass Infinity for unbounded in-state audit history
}
```

Retention question: should v0.2.0 keep all events forever, add `maxEvents` to constructor options, or leave pruning to consumers? The minimal proposal is to keep events optional and unbounded for v0.2.0, then add retention controls later if users need them.

## Ordering and claim semantics

Pending ordering remains priority-first, FIFO-within-priority. Future `availableAt` tasks stay in `pending` but are skipped by `claimNext()` until available.

Priority rank remains:

1. `urgent`
2. `high`
3. `normal`
4. `low`

## Migration strategy

No migration command is required for v0.2.0.

On read/mutation:

- Missing `attempt` becomes `1`.
- Missing `done[].outcome` becomes `'completed'`.
- Missing `events` becomes `[]` only when appending a new event.
- Unknown extra fields are preserved by JSON round-trip because callers may store metadata or future fields.

## Testing plan

Minimum regression coverage before implementation:

1. `fail` moves current to done with `outcome: 'failed'`, serialized error, and no current task.
2. `retry` re-queues failed task with new id, parent id, incremented attempt, copied metadata, and lifecycle event.
3. `retry` returns `null` for missing/completed/cancelled tasks.
4. `delayMs` prevents immediate claim and later allows claim when time advances.
5. `cancel` works for pending and current tasks.
6. `supersede` atomically completes original and enqueues replacement.
7. `get` finds current/pending/done tasks.
8. `list` filters by status/outcome/priority/source.
9. v0.1.0 state fixtures without `attempt`, `outcome`, or `events` still load and mutate correctly.
10. Concurrent mutations still serialize through `Storage.withLock`.

## Claude review decisions

Claude reviewed this design in [ASK:e57a3c26](../../wiki/asks/e57a3c26-please-review-the-draft-design-doc-for-ventus-so.md) and recommended these final v0.2.0 decisions:

1. Rename `fail(error)` to `failCurrent(error)` for symmetry with `completeCurrent`.
2. Keep `retry({ delayMs })` in v0.2.0; it sets `availableAt = now + delayMs` and `claimNext()` skips unavailable tasks.
3. Keep lifecycle events in state for v0.2.0, bounded by `maxEvents` defaulting to 1000; defer subscriber/event-sink APIs to v0.3.
4. Ship both `cancel` and `supersede` in v0.2.0; `supersede` only applies to pending/current tasks.
5. Retry creates a new task id linked by `parentTaskId`; each attempt is its own message/task identity.
6. Rename the filtered list return type to `FilteredTasks` so it is distinct from raw `TaskQueueState`/`peek()`.
7. `list()` defaults `includeUnavailable` to `true`; `claimNext()` always skips future `availableAt` tasks.
8. Add optional recursive `SerializedTaskError.cause` support.

## Resolved review questions

1. Should `fail(error)` be named `failCurrent(error)` for clarity?
2. Should `retry` accept `delayMs`, or should delayed scheduling wait until a later release?
3. Should lifecycle events live inside `TaskQueueState`, or should the package expose an optional event sink interface instead?
4. Should `cancel` and `supersede` be part of v0.2.0, or should v0.2.0 only ship fail/retry/get/list/events?
5. Should `retry` preserve the same task id or always create a new id? This draft chooses a new id to make attempts auditable.

## Non-goals for v0.2.0

- Cron/recurring scheduling.
- Worker pools or distributed leases.
- AIDE-specific agreement, parked, wiki, or operator-only semantics.
- Database storage adapters beyond the existing pluggable `Storage` interface.
- Automatic retry policies. v0.2.0 exposes primitives; callers decide policy.
