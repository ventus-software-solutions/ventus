import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';

export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TaskSource = 'user' | 'system' | 'application';
export type TaskStatus = 'pending' | 'current' | 'done';

export interface Task {
  id: string;
  description: string;
  priority: TaskPriority;
  source: TaskSource;
  addedAt: string;
  metadata?: Record<string, unknown>;
}

export interface CompletedTask extends Task {
  completedAt: string;
  result?: unknown;
}

export interface TaskQueueState {
  current: Task | null;
  pending: Task[];
  done: CompletedTask[];
}

export interface EnqueueOptions {
  priority?: TaskPriority;
  source?: TaskSource;
  metadata?: Record<string, unknown>;
}

export interface Storage {
  read(): Promise<TaskQueueState>;
  write(state: TaskQueueState): Promise<void>;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
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
  constructor(private readonly options: { storage: Storage }) {}

  async enqueue(description: string, opts: EnqueueOptions = {}): Promise<Task> {
    return this.options.storage.withLock(async () => {
      const state = await this.options.storage.read();
      const task: Task = {
        id: generateId(),
        description,
        priority: opts.priority ?? 'normal',
        source: opts.source ?? 'application',
        addedAt: new Date().toISOString(),
        ...(opts.metadata ? { metadata: opts.metadata } : {}),
      };
      state.pending.push(task);
      state.pending.sort(comparePriority);
      await this.options.storage.write(state);
      return task;
    });
  }

  async claimNext(): Promise<Task | null> {
    return this.options.storage.withLock(async () => {
      const state = await this.options.storage.read();
      if (state.current) return state.current;
      state.pending.sort(comparePriority);
      state.current = state.pending.shift() ?? null;
      await this.options.storage.write(state);
      return state.current;
    });
  }

  async completeCurrent(result?: unknown): Promise<CompletedTask | null> {
    return this.options.storage.withLock(async () => {
      const state = await this.options.storage.read();
      if (!state.current) return null;
      const completed: CompletedTask = {
        ...state.current,
        completedAt: new Date().toISOString(),
        ...(result === undefined ? {} : { result }),
      };
      state.current = null;
      state.done.unshift(completed);
      await this.options.storage.write(state);
      return completed;
    });
  }

  async peek(): Promise<TaskQueueState> {
    return this.options.storage.read();
  }
}

function emptyState(): TaskQueueState {
  return { current: null, pending: [], done: [] };
}

function normalizeState(value: unknown): TaskQueueState {
  if (!value || typeof value !== 'object') return emptyState();
  const raw = value as Partial<TaskQueueState>;
  return {
    current: raw.current ? normalizeTask(raw.current) : null,
    pending: Array.isArray(raw.pending) ? raw.pending.map(normalizeTask) : [],
    done: Array.isArray(raw.done) ? raw.done.map(normalizeCompletedTask) : [],
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
    ...(raw.result === undefined ? {} : { result: raw.result }),
  };
}

function comparePriority(a: Task, b: Task): number {
  const rank: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
  return rank[a.priority] - rank[b.priority] || a.addedAt.localeCompare(b.addedAt);
}

function isPriority(value: unknown): value is TaskPriority {
  return value === 'low' || value === 'normal' || value === 'high' || value === 'urgent';
}

function isSource(value: unknown): value is TaskSource {
  return value === 'user' || value === 'system' || value === 'application';
}

function generateId(): string {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
