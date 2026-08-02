import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';

export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TaskSource = 'user' | 'system' | 'application';
export type TaskStatus = 'pending' | 'current' | 'done';
export type TaskOutcome = 'completed' | 'failed' | 'cancelled' | 'superseded';
export type TaskLifecycleEventType =
  | 'task.enqueued'
  | 'task.enqueue_deduplicated'
  | 'task.priority_changed'
  | 'task.claimed'
  | 'task.deferred'
  | 'task.resumed'
  | 'task.completed'
  | 'task.failed'
  | 'task.retried'
  | 'task.cancelled'
  | 'task.superseded';

export interface Task {
  id: string;
  description: string;
  priority: TaskPriority;
  source: TaskSource;
  addedAt: string;
  attempt: number;
  sequence?: number;
  queuedAt?: string;
  claimedAt?: string;
  resumeCount?: number;
  lastResumedAt?: string;
  availableAt?: string;
  parentTaskId?: string;
  blockedBy?: string[];
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export interface SerializedTaskError {
  name?: string;
  message: string;
  stack?: string;
  cause?: SerializedTaskError;
}

export interface CompletedTask extends Task {
  completedAt: string;
  outcome: TaskOutcome;
  result?: unknown;
  error?: SerializedTaskError;
  supersededBy?: string;
}

export interface TaskLifecycleEvent {
  id: string;
  type: TaskLifecycleEventType;
  taskId: string;
  at: string;
  data?: Record<string, unknown>;
}

export interface TaskQueueState {
  current: Task | null;
  pending: Task[];
  done: CompletedTask[];
  events?: TaskLifecycleEvent[];
}

export interface EnqueueOptions {
  priority?: TaskPriority;
  source?: TaskSource;
  metadata?: Record<string, unknown>;
  availableAt?: string;
  blockedBy?: string[];
  idempotencyKey?: string;
}

export interface RetryOptions {
  attempt?: number;
  delayMs?: number;
  priority?: TaskPriority;
  metadata?: Record<string, unknown>;
}

export interface DeferOptions {
  delayMs?: number;
  priority?: TaskPriority;
  metadata?: Record<string, unknown>;
}

export interface EnqueueReplacement extends EnqueueOptions {
  description: string;
}

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[];
  outcome?: TaskOutcome | TaskOutcome[];
  priority?: TaskPriority | TaskPriority[];
  source?: TaskSource | TaskSource[];
  includeUnavailable?: boolean;
}

export interface FilteredTasks {
  current: Task | null;
  pending: Task[];
  done: CompletedTask[];
}

export interface Storage {
  read(): Promise<TaskQueueState>;
  write(state: TaskQueueState): Promise<void>;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

export interface TaskQueueOptions {
  storage: Storage;
  maxEvents?: number;
}

export class FileStorage implements Storage {
  constructor(private readonly filePath: string) {}

  async read(): Promise<TaskQueueState> {
    try {
      const text = await fs.readFile(this.filePath, 'utf8');
      return normalizeState(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw error;
    }
  }

  async write(state: TaskQueueState): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(normalizeState(state), null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, this.filePath);
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await fs.writeFile(this.filePath, `${JSON.stringify(emptyState(), null, 2)}\n`, 'utf8');
    }
    const release = await lockfile.lock(this.filePath, {
      retries: { retries: 5, minTimeout: 25, maxTimeout: 100 },
    });
    try {
      return await fn();
    } finally {
      await release();
    }
  }
}

export class TaskQueue {
  private readonly maxEvents: number;

  constructor(private readonly options: TaskQueueOptions) {
    this.maxEvents = options.maxEvents ?? 1000;
  }

  async enqueue(description: string, opts: EnqueueOptions = {}): Promise<Task> {
    return this.options.storage.withLock(async () => {
      const state = await this.options.storage.read();
      if (opts.idempotencyKey) {
        const existing =
          (state.current?.idempotencyKey === opts.idempotencyKey ? state.current : null) ??
          state.pending.find((task) => task.idempotencyKey === opts.idempotencyKey) ??
          null;
        if (existing) {
          appendEvent(state, this.maxEvents, 'task.enqueue_deduplicated', existing.id, {
            idempotencyKey: opts.idempotencyKey,
          });
          await this.options.storage.write(state);
          return existing;
        }
      }
      const task = createTask(description, opts, { sequence: allocateSequence(state) });
      state.pending.push(task);
      state.pending.sort(comparePriority);
      appendEvent(state, this.maxEvents, 'task.enqueued', task.id, {
        priority: task.priority,
        source: task.source,
      });
      await this.options.storage.write(state);
      return task;
    });
  }

  async changePriority(taskId: string, newPriority: TaskPriority): Promise<Task | null> {
    return this.options.storage.withLock(async () => {
      const state = await this.options.storage.read();
      const task = state.pending.find((candidate) => candidate.id === taskId) ?? null;
      if (!task) return null;
      const previousPriority = task.priority;
      task.priority = newPriority;
      state.pending.sort(comparePriority);
      appendEvent(state, this.maxEvents, 'task.priority_changed', task.id, {
        previousPriority,
        priority: newPriority,
      });
      await this.options.storage.write(state);
      return task;
    });
  }

  async claimNext(): Promise<Task | null> {
    return this.options.storage.withLock(async () => {
      const state = await this.options.storage.read();
      if (state.current) return state.current;
      state.pending.sort(comparePriority);
      const now = Date.now();
      const resolvedDependencies = new Set(
        state.done.filter((task) => task.outcome === 'completed').map((task) => task.id),
      );
      const nextIndex = state.pending.findIndex(
        (task) => isAvailable(task, now) && dependenciesResolved(task, resolvedDependencies),
      );
      state.current = nextIndex >= 0 ? (state.pending.splice(nextIndex, 1)[0] ?? null) : null;
      if (state.current) {
        state.current.claimedAt ??= new Date().toISOString();
        state.current.resumeCount ??= 0;
        appendEvent(state, this.maxEvents, 'task.claimed', state.current.id);
      }
      await this.options.storage.write(state);
      return state.current;
    });
  }

  async completeCurrent(result?: unknown): Promise<CompletedTask | null> {
    return this.options.storage.withLock(async () => {
      const state = await this.options.storage.read();
      if (!state.current) return null;
      const completed = completeTask(state.current, 'completed', { result });
      state.current = null;
      state.done.unshift(completed);
      appendEvent(state, this.maxEvents, 'task.completed', completed.id);
      await this.options.storage.write(state);
      return completed;
    });
  }

  async failCurrent(error: Error | string): Promise<CompletedTask | null> {
    return this.options.storage.withLock(async () => {
      const state = await this.options.storage.read();
      if (!state.current) return null;
      const completed = completeTask(state.current, 'failed', { error: serializeError(error) });
      state.current = null;
      state.done.unshift(completed);
      appendEvent(state, this.maxEvents, 'task.failed', completed.id, {
        message: completed.error?.message,
      });
      await this.options.storage.write(state);
      return completed;
    });
  }

  async retry(taskId: string, opts: RetryOptions = {}): Promise<Task | null> {
    return this.options.storage.withLock(async () => {
      const state = await this.options.storage.read();
      const original = state.done.find((task) => task.id === taskId) ?? null;
      if (!original || (original.outcome !== 'failed' && original.outcome !== 'superseded'))
        return null;
      const existingRetry =
        (state.current?.parentTaskId === original.id ? state.current : null) ??
        state.pending.find((task) => task.parentTaskId === original.id) ??
        null;
      if (existingRetry) return existingRetry;
      const delayMs = opts.delayMs ?? 0;
      const metadata = opts.metadata ?? original.metadata;
      const task = createTask(
        original.description,
        {
          priority: opts.priority ?? original.priority,
          source: original.source,
          ...(original.blockedBy ? { blockedBy: original.blockedBy } : {}),
          ...(original.idempotencyKey ? { idempotencyKey: original.idempotencyKey } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
          ...(delayMs > 0 ? { availableAt: new Date(Date.now() + delayMs).toISOString() } : {}),
        },
        {
          attempt: opts.attempt ?? original.attempt + 1,
          parentTaskId: original.id,
          sequence: allocateSequence(state),
        },
      );
      state.pending.push(task);
      state.pending.sort(comparePriority);
      appendEvent(state, this.maxEvents, 'task.retried', original.id, {
        retryTaskId: task.id,
        delayMs,
      });
      await this.options.storage.write(state);
      return task;
    });
  }

  async cancel(taskId: string, reason?: string): Promise<CompletedTask | null> {
    return this.options.storage.withLock(async () => {
      const state = await this.options.storage.read();
      const pendingIndex = state.pending.findIndex((task) => task.id === taskId);
      const task =
        pendingIndex >= 0
          ? state.pending.splice(pendingIndex, 1)[0]
          : state.current?.id === taskId
            ? state.current
            : null;
      if (!task) return null;
      if (state.current?.id === taskId) state.current = null;
      const completed = completeTask(
        task,
        'cancelled',
        reason === undefined ? {} : { result: { reason } },
      );
      state.done.unshift(completed);
      appendEvent(
        state,
        this.maxEvents,
        'task.cancelled',
        completed.id,
        reason === undefined ? undefined : { reason },
      );
      await this.options.storage.write(state);
      return completed;
    });
  }

  async supersede(taskId: string, replacement: EnqueueReplacement): Promise<Task | null> {
    return this.options.storage.withLock(async () => {
      const state = await this.options.storage.read();
      const pendingIndex = state.pending.findIndex((task) => task.id === taskId);
      const original =
        pendingIndex >= 0
          ? state.pending.splice(pendingIndex, 1)[0]
          : state.current?.id === taskId
            ? state.current
            : null;
      if (!original) return null;
      const replacementTask = createTask(replacement.description, replacement, {
        attempt: 1,
        parentTaskId: original.id,
        sequence: allocateSequence(state),
      });
      const completed = completeTask(original, 'superseded', { supersededBy: replacementTask.id });
      if (state.current?.id === original.id) state.current = null;
      state.done.unshift(completed);
      state.pending.push(replacementTask);
      state.pending.sort(comparePriority);
      appendEvent(state, this.maxEvents, 'task.superseded', original.id, {
        supersededBy: replacementTask.id,
      });
      appendEvent(state, this.maxEvents, 'task.enqueued', replacementTask.id, {
        parentTaskId: original.id,
        priority: replacementTask.priority,
        source: replacementTask.source,
      });
      await this.options.storage.write(state);
      return replacementTask;
    });
  }

  async deferCurrent(opts: DeferOptions = {}): Promise<Task | null> {
    return this.options.storage.withLock(async () => {
      const state = await this.options.storage.read();
      if (!state.current) return null;
      const delayMs = opts.delayMs ?? 0;
      const now = new Date();
      const { availableAt: _previousAvailableAt, ...current } = state.current;
      const task: Task = {
        ...current,
        priority: opts.priority ?? state.current.priority,
        queuedAt: now.toISOString(),
        sequence: allocateSequence(state),
        ...(delayMs > 0 ? { availableAt: new Date(now.getTime() + delayMs).toISOString() } : {}),
        ...(opts.metadata ? { metadata: { ...state.current.metadata, ...opts.metadata } } : {}),
      };
      state.current = null;
      state.pending.push(task);
      state.pending.sort(comparePriority);
      appendEvent(state, this.maxEvents, 'task.deferred', task.id, { delayMs });
      await this.options.storage.write(state);
      return task;
    });
  }

  async resumeCurrent(): Promise<Task | null> {
    return this.options.storage.withLock(async () => {
      const state = await this.options.storage.read();
      if (!state.current) return null;
      state.current.resumeCount = (state.current.resumeCount ?? 0) + 1;
      state.current.lastResumedAt = new Date().toISOString();
      appendEvent(state, this.maxEvents, 'task.resumed', state.current.id, {
        resumeCount: state.current.resumeCount,
      });
      await this.options.storage.write(state);
      return state.current;
    });
  }

  async get(taskId: string): Promise<Task | CompletedTask | null> {
    const state = await this.options.storage.read();
    if (state.current?.id === taskId) return state.current;
    return (
      state.pending.find((task) => task.id === taskId) ??
      state.done.find((task) => task.id === taskId) ??
      null
    );
  }

  async list(filter: TaskFilter = {}): Promise<FilteredTasks> {
    const state = await this.options.storage.read();
    const statuses = toSet(filter.status);
    const includeUnavailable = filter.includeUnavailable ?? true;
    const now = Date.now();
    return {
      current:
        shouldIncludeStatus(statuses, 'current') &&
        state.current &&
        matchesTaskFilter(state.current, filter, 'current')
          ? state.current
          : null,
      pending: shouldIncludeStatus(statuses, 'pending')
        ? state.pending.filter(
            (task) =>
              (includeUnavailable || isAvailable(task, now)) &&
              matchesTaskFilter(task, filter, 'pending'),
          )
        : [],
      done: shouldIncludeStatus(statuses, 'done')
        ? state.done.filter((task) => matchesTaskFilter(task, filter, 'done'))
        : [],
    };
  }

  async peek(): Promise<TaskQueueState> {
    return this.options.storage.read();
  }
}

function emptyState(): TaskQueueState {
  return { current: null, pending: [], done: [], events: [] };
}

function normalizeState(value: unknown): TaskQueueState {
  if (!value || typeof value !== 'object') return emptyState();
  const raw = value as Partial<TaskQueueState>;
  return {
    current: raw.current ? normalizeTask(raw.current) : null,
    pending: Array.isArray(raw.pending) ? raw.pending.map(normalizeTask) : [],
    done: Array.isArray(raw.done) ? raw.done.map(normalizeCompletedTask) : [],
    events: Array.isArray(raw.events)
      ? raw.events
          .map(normalizeEvent)
          .filter((event): event is TaskLifecycleEvent => Boolean(event))
      : [],
  };
}

function createTask(
  description: string,
  opts: EnqueueOptions = {},
  derived: { attempt?: number; parentTaskId?: string; sequence?: number } = {},
): Task {
  const now = new Date().toISOString();
  return {
    id: generateId(),
    description,
    priority: opts.priority ?? 'normal',
    source: opts.source ?? 'application',
    addedAt: now,
    queuedAt: now,
    attempt: derived.attempt ?? 1,
    ...(derived.sequence === undefined ? {} : { sequence: derived.sequence }),
    ...(opts.availableAt ? { availableAt: opts.availableAt } : {}),
    ...(derived.parentTaskId ? { parentTaskId: derived.parentTaskId } : {}),
    ...(opts.blockedBy ? { blockedBy: [...opts.blockedBy] } : {}),
    ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  };
}

function normalizeTask(value: unknown): Task {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<Task>;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : generateId(),
    description: typeof raw.description === 'string' ? raw.description : '',
    priority: isPriority(raw.priority) ? raw.priority : 'normal',
    source: isSource(raw.source) ? raw.source : 'application',
    addedAt: typeof raw.addedAt === 'string' ? raw.addedAt : new Date().toISOString(),
    attempt:
      typeof raw.attempt === 'number' && Number.isFinite(raw.attempt) && raw.attempt > 0
        ? raw.attempt
        : 1,
    ...(typeof raw.sequence === 'number' && Number.isFinite(raw.sequence)
      ? { sequence: raw.sequence }
      : {}),
    ...(typeof raw.queuedAt === 'string' ? { queuedAt: raw.queuedAt } : {}),
    ...(typeof raw.claimedAt === 'string' ? { claimedAt: raw.claimedAt } : {}),
    ...(typeof raw.resumeCount === 'number' &&
    Number.isFinite(raw.resumeCount) &&
    raw.resumeCount >= 0
      ? { resumeCount: raw.resumeCount }
      : {}),
    ...(typeof raw.lastResumedAt === 'string' ? { lastResumedAt: raw.lastResumedAt } : {}),
    ...(typeof raw.availableAt === 'string' ? { availableAt: raw.availableAt } : {}),
    ...(typeof raw.parentTaskId === 'string' ? { parentTaskId: raw.parentTaskId } : {}),
    ...(Array.isArray(raw.blockedBy)
      ? {
          blockedBy: raw.blockedBy.filter(
            (id): id is string => typeof id === 'string' && id.length > 0,
          ),
        }
      : {}),
    ...(typeof raw.idempotencyKey === 'string' ? { idempotencyKey: raw.idempotencyKey } : {}),
    ...(raw.metadata && typeof raw.metadata === 'object'
      ? { metadata: raw.metadata as Record<string, unknown> }
      : {}),
  };
}

function normalizeCompletedTask(value: unknown): CompletedTask {
  const task = normalizeTask(value);
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<CompletedTask>;
  return {
    ...task,
    completedAt: typeof raw.completedAt === 'string' ? raw.completedAt : new Date().toISOString(),
    outcome: isOutcome(raw.outcome) ? raw.outcome : 'completed',
    ...(raw.result === undefined ? {} : { result: raw.result }),
    ...(raw.error ? { error: normalizeSerializedError(raw.error) } : {}),
    ...(typeof raw.supersededBy === 'string' ? { supersededBy: raw.supersededBy } : {}),
  };
}

function normalizeEvent(value: unknown): TaskLifecycleEvent | null {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<TaskLifecycleEvent>;
  if (!isEventType(raw.type) || typeof raw.taskId !== 'string') return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : generateId(),
    type: raw.type,
    taskId: raw.taskId,
    at: typeof raw.at === 'string' ? raw.at : new Date().toISOString(),
    ...(raw.data && typeof raw.data === 'object'
      ? { data: raw.data as Record<string, unknown> }
      : {}),
  };
}

function completeTask(
  task: Task,
  outcome: TaskOutcome,
  extras: Partial<CompletedTask> = {},
): CompletedTask {
  const now = new Date().toISOString();
  const { result, ...rest } = extras;
  const baseCompleted = {
    ...task,
    completedAt: now,
    outcome,
    ...rest,
  };
  const completed: CompletedTask =
    result === undefined
      ? baseCompleted
      : {
          ...baseCompleted,
          result,
        };
  return completed;
}

function appendEvent(
  state: TaskQueueState,
  maxEvents: number,
  type: TaskLifecycleEventType,
  taskId: string,
  data?: Record<string, unknown>,
): void {
  const events = state.events ?? [];
  events.push({
    id: generateId(),
    type,
    taskId,
    at: new Date().toISOString(),
    ...(data ? { data } : {}),
  });
  state.events =
    maxEvents === Number.POSITIVE_INFINITY ? events : events.slice(-Math.max(0, maxEvents));
}

function serializeError(error: Error | string | unknown): SerializedTaskError {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
      ...(cause === undefined ? {} : { cause: serializeError(cause) }),
    };
  }
  return { message: String(error) };
}

function normalizeSerializedError(value: unknown): SerializedTaskError {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<SerializedTaskError>;
  return {
    ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
    message: typeof raw.message === 'string' ? raw.message : '',
    ...(typeof raw.stack === 'string' ? { stack: raw.stack } : {}),
    ...(raw.cause ? { cause: normalizeSerializedError(raw.cause) } : {}),
  };
}

function comparePriority(a: Task, b: Task): number {
  const rank: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
  const sequenceOrder =
    a.sequence !== undefined && b.sequence !== undefined ? a.sequence - b.sequence : 0;
  return (
    rank[a.priority] - rank[b.priority] ||
    sequenceOrder ||
    (a.queuedAt ?? a.addedAt).localeCompare(b.queuedAt ?? b.addedAt) ||
    compareOptionalNumber(a.sequence, b.sequence) ||
    a.id.localeCompare(b.id)
  );
}

function compareOptionalNumber(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a - b;
}

function allocateSequence(state: TaskQueueState): number {
  const tasks: Task[] = [
    ...(state.current ? [state.current] : []),
    ...state.pending,
    ...state.done,
  ];
  return (
    tasks.reduce(
      (maximum, task) =>
        typeof task.sequence === 'number' && Number.isFinite(task.sequence)
          ? Math.max(maximum, task.sequence)
          : maximum,
      0,
    ) + 1
  );
}

function dependenciesResolved(task: Task, resolvedDependencies: Set<string>): boolean {
  return (
    !task.blockedBy?.length || task.blockedBy.every((taskId) => resolvedDependencies.has(taskId))
  );
}

function isAvailable(task: Task, now = Date.now()): boolean {
  return !task.availableAt || Date.parse(task.availableAt) <= now;
}

function matchesTaskFilter(
  task: Task | CompletedTask,
  filter: TaskFilter,
  status: TaskStatus,
): boolean {
  const priorities = toSet(filter.priority);
  const sources = toSet(filter.source);
  const outcomes = toSet(filter.outcome);
  if (priorities && !priorities.has(task.priority)) return false;
  if (sources && !sources.has(task.source)) return false;
  if (outcomes) return status === 'done' && outcomes.has((task as CompletedTask).outcome);
  return true;
}

function shouldIncludeStatus(statuses: Set<TaskStatus> | null, status: TaskStatus): boolean {
  return !statuses || statuses.has(status);
}

function toSet<T extends string>(value: T | T[] | undefined): Set<T> | null {
  if (value === undefined) return null;
  return new Set(Array.isArray(value) ? value : [value]);
}

function isPriority(value: unknown): value is TaskPriority {
  return value === 'low' || value === 'normal' || value === 'high' || value === 'urgent';
}

function isSource(value: unknown): value is TaskSource {
  return value === 'user' || value === 'system' || value === 'application';
}

function isOutcome(value: unknown): value is TaskOutcome {
  return (
    value === 'completed' || value === 'failed' || value === 'cancelled' || value === 'superseded'
  );
}

function isEventType(value: unknown): value is TaskLifecycleEventType {
  return (
    value === 'task.enqueued' ||
    value === 'task.enqueue_deduplicated' ||
    value === 'task.priority_changed' ||
    value === 'task.claimed' ||
    value === 'task.deferred' ||
    value === 'task.resumed' ||
    value === 'task.completed' ||
    value === 'task.failed' ||
    value === 'task.retried' ||
    value === 'task.cancelled' ||
    value === 'task.superseded'
  );
}

function generateId(): string {
  return `task_${randomUUID()}`;
}
