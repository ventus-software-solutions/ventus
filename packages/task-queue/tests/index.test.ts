import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStorage, type Storage, TaskQueue, type TaskQueueState } from '../src/index.js';

class MemoryStorage implements Storage {
  state: TaskQueueState = { current: null, pending: [], done: [], events: [] };
  lockCalls = 0;

  async read(): Promise<TaskQueueState> {
    return structuredClone(this.state);
  }

  async write(state: TaskQueueState): Promise<void> {
    this.state = structuredClone(state);
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    this.lockCalls += 1;
    return fn();
  }
}

describe('TaskQueue', () => {
  it('enqueues public tasks without AIDE-specific fields and preserves metadata', async () => {
    const storage = new MemoryStorage();
    const queue = new TaskQueue({ storage });

    const task = await queue.enqueue('ship package', {
      priority: 'high',
      source: 'user',
      metadata: { package: '@ventus_software/task-queue' },
    });

    expect(task).toMatchObject({
      description: 'ship package',
      priority: 'high',
      source: 'user',
      attempt: 1,
      metadata: { package: '@ventus_software/task-queue' },
    });
    expect(task).not.toHaveProperty('agreed');
    expect(task).not.toHaveProperty('sourceRef');
    expect(storage.state.events?.map((event) => event.type)).toEqual(['task.enqueued']);
    expect(storage.lockCalls).toBe(1);
  });

  it('uses MemoryStorage through the storage interface for the full lifecycle', async () => {
    const storage = new MemoryStorage();
    const queue = new TaskQueue({ storage });

    await queue.enqueue('normal work');
    await queue.enqueue('low work', { priority: 'low' });
    await queue.enqueue('urgent work', { priority: 'urgent' });
    await queue.enqueue('high work', { priority: 'high' });

    expect((await queue.claimNext())?.description).toBe('urgent work');
    expect(await queue.claimNext()).toMatchObject({ description: 'urgent work' });

    const completed = await queue.completeCurrent({ ok: true });
    expect(completed).toMatchObject({
      description: 'urgent work',
      outcome: 'completed',
      result: { ok: true },
    });

    expect((await queue.claimNext())?.description).toBe('high work');
    expect((await queue.completeCurrent())?.result).toBeUndefined();

    const state = await queue.peek();
    expect(state.current).toBeNull();
    expect(state.pending.map((task) => task.description)).toEqual(['normal work', 'low work']);
    expect(state.done.map((task) => task.description)).toEqual(['high work', 'urgent work']);
    expect(storage.lockCalls).toBe(9);
  });

  it('returns null when there is no work to claim or complete/fail', async () => {
    const queue = new TaskQueue({ storage: new MemoryStorage() });

    expect(await queue.claimNext()).toBeNull();
    expect(await queue.completeCurrent()).toBeNull();
    expect(await queue.failCurrent('nothing')).toBeNull();
  });

  it('changes priority for pending tasks only and re-sorts the queue', async () => {
    const storage = new MemoryStorage();
    const queue = new TaskQueue({ storage });

    const first = await queue.enqueue('first normal');
    const second = await queue.enqueue('second low', { priority: 'low' });
    const current = await queue.claimNext();

    expect(current).toMatchObject({ id: first.id });
    if (!current) {
      throw new Error('Expected current task to exist');
    }
    expect(await queue.changePriority(current.id, 'urgent')).toBeNull();

    const updated = await queue.changePriority(second.id, 'urgent');

    expect(updated).toMatchObject({ id: second.id, priority: 'urgent' });
    expect((await queue.peek()).pending.map((task) => [task.id, task.priority])).toEqual([
      [second.id, 'urgent'],
    ]);
    expect(await queue.changePriority('missing', 'high')).toBeNull();
    expect(storage.lockCalls).toBe(6);
  });

  it('fails current tasks with serialized cause and retries them with delay', async () => {
    const storage = new MemoryStorage();
    const queue = new TaskQueue({ storage });

    await queue.enqueue('transient call', { priority: 'high', metadata: { endpoint: '/sync' } });
    const claimed = await queue.claimNext();
    const failed = await queue.failCurrent(new Error('outer', { cause: new Error('inner') }));

    expect(failed).toMatchObject({
      id: claimed?.id,
      outcome: 'failed',
      error: { name: 'Error', message: 'outer', cause: { message: 'inner' } },
    });

    if (!failed) {
      throw new Error('Expected failed task to exist');
    }

    const retry = await queue.retry(failed.id, { delayMs: 60_000, priority: 'urgent' });

    expect(retry).toMatchObject({
      description: 'transient call',
      priority: 'urgent',
      attempt: 2,
      parentTaskId: failed.id,
      metadata: { endpoint: '/sync' },
    });
    expect(retry?.id).not.toBe(failed?.id);
    expect(retry?.availableAt).toEqual(expect.any(String));
    expect(await queue.claimNext()).toBeNull();
    expect((await queue.list({ status: 'pending', includeUnavailable: false })).pending).toEqual(
      [],
    );
    expect((await queue.list({ status: 'pending' })).pending).toHaveLength(1);
    if (!claimed) {
      throw new Error('Expected claimed task to exist');
    }
    expect(await queue.retry(claimed.id)).toMatchObject({ attempt: 2 });
  });

  it('returns the existing pending retry when the same terminal task is retried twice', async () => {
    const storage = new MemoryStorage();
    const queue = new TaskQueue({ storage });

    await queue.enqueue('retry exactly once');
    await queue.claimNext();
    const failed = await queue.failCurrent('transient failure');
    if (!failed) throw new Error('Expected failed task to exist');

    const firstRetry = await queue.retry(failed.id);
    const secondRetry = await queue.retry(failed.id);

    expect(secondRetry?.id).toBe(firstRetry?.id);
    expect((await queue.peek()).pending).toHaveLength(1);
    expect(
      (await queue.peek()).events?.filter((event) => event.type === 'task.retried'),
    ).toHaveLength(1);
  });

  it('persists completed tasks without undeclared lifecycle fields', async () => {
    const storage = new MemoryStorage();
    const queue = new TaskQueue({ storage });

    await queue.enqueue('complete cleanly');
    await queue.claimNext();
    const completed = await queue.completeCurrent();

    expect(completed).not.toHaveProperty('status');
    expect(completed).not.toHaveProperty('updatedAt');
    expect(storage.state.done[0]).not.toHaveProperty('status');
    expect(storage.state.done[0]).not.toHaveProperty('updatedAt');
  });

  it('cancels pending/current tasks and supersedes only pending/current tasks', async () => {
    const storage = new MemoryStorage();
    const queue = new TaskQueue({ storage });

    const pending = await queue.enqueue('obsolete pending');
    const cancelledPending = await queue.cancel(pending.id, 'not needed');

    expect(cancelledPending).toMatchObject({
      outcome: 'cancelled',
      result: { reason: 'not needed' },
    });
    expect(await queue.cancel(pending.id)).toBeNull();

    const current = await queue.enqueue('obsolete current');
    expect((await queue.claimNext())?.id).toBe(current.id);
    const replacement = await queue.supersede(current.id, {
      description: 'replacement task',
      priority: 'high',
    });

    expect(replacement).toMatchObject({
      description: 'replacement task',
      priority: 'high',
      parentTaskId: current.id,
    });
    const original = await queue.get(current.id);
    expect(original).toMatchObject({ outcome: 'superseded', supersededBy: replacement?.id });
    expect(await queue.supersede(current.id, { description: 'too late' })).toBeNull();
    expect((await queue.list({ outcome: 'superseded' })).done).toHaveLength(1);
  });

  it('gets tasks across states and filters by status/priority/source/outcome', async () => {
    const storage = new MemoryStorage();
    const queue = new TaskQueue({ storage });

    const low = await queue.enqueue('low app', { priority: 'low', source: 'application' });
    const high = await queue.enqueue('high user', { priority: 'high', source: 'user' });
    await queue.claimNext();
    await queue.completeCurrent('done');

    expect(await queue.get(low.id)).toMatchObject({ id: low.id, description: 'low app' });
    expect(await queue.get(high.id)).toMatchObject({ id: high.id, outcome: 'completed' });
    expect(await queue.get('missing')).toBeNull();
    expect(
      (await queue.list({ status: 'pending', priority: 'low' })).pending.map((task) => task.id),
    ).toEqual([low.id]);
    expect(
      (await queue.list({ status: 'done', source: 'user', outcome: 'completed' })).done.map(
        (task) => task.id,
      ),
    ).toEqual([high.id]);
    expect(await queue.list({ status: ['current'] })).toEqual({
      current: null,
      pending: [],
      done: [],
    });
  });

  it('bounds lifecycle events with maxEvents', async () => {
    const storage = new MemoryStorage();
    const queue = new TaskQueue({ storage, maxEvents: 3 });

    await queue.enqueue('one');
    await queue.enqueue('two');
    await queue.claimNext();
    await queue.completeCurrent();

    expect((await queue.peek()).events?.map((event) => event.type)).toEqual([
      'task.enqueued',
      'task.claimed',
      'task.completed',
    ]);
  });
});

describe('FileStorage', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-queue-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('persists queue state under the storage lock', async () => {
    const filePath = path.join(tempDir, 'tasks.json');
    const queue = new TaskQueue({ storage: new FileStorage(filePath) });

    await queue.enqueue('persist me', { source: 'system' });
    await queue.claimNext();
    await queue.completeCurrent('done');

    const raw = JSON.parse(await fs.readFile(filePath, 'utf8')) as TaskQueueState;
    expect(raw.done[0]).toMatchObject({
      description: 'persist me',
      source: 'system',
      outcome: 'completed',
      result: 'done',
    });
    expect(raw.events?.map((event) => event.type)).toEqual([
      'task.enqueued',
      'task.claimed',
      'task.completed',
    ]);
  });

  it('returns an empty queue when the state file is missing', async () => {
    const state = await new FileStorage(path.join(tempDir, 'missing', 'tasks.json')).read();

    expect(state).toEqual({ current: null, pending: [], done: [], events: [] });
  });

  it('creates parent directories and normalizes malformed JSON shape on write/read', async () => {
    const filePath = path.join(tempDir, 'nested', 'tasks.json');
    const storage = new FileStorage(filePath);

    await storage.write({
      current: null,
      pending: [
        {
          id: 'pending',
          description: 'pending task',
          priority: 'urgent',
          source: 'user',
          addedAt: '2026-01-01T00:00:00.000Z',
          attempt: 1,
        },
      ],
      done: [],
    });

    expect(await storage.read()).toMatchObject({
      pending: [{ id: 'pending', priority: 'urgent', attempt: 1 }],
    });
    await fs.writeFile(
      filePath,
      JSON.stringify({
        current: {
          id: '',
          description: 123,
          priority: 'unknown',
          source: 'external',
          addedAt: null,
          metadata: 'ignored',
        },
        pending: 'bad',
        done: [
          {
            id: 'done',
            description: 'legacy done',
            priority: 'bad',
            source: 'bad',
            result: null,
            completedAt: 7,
          },
        ],
        events: [
          {
            id: 'event',
            type: 'task.failed',
            taskId: 'done',
            at: '2026-01-01T00:00:00.000Z',
            data: null,
          },
          { type: 'bad', taskId: 'x' },
        ],
      }),
      'utf8',
    );

    const normalized = await storage.read();
    expect(normalized.current).toMatchObject({
      description: '',
      priority: 'normal',
      source: 'application',
      attempt: 1,
    });
    expect(normalized.current?.id).toMatch(/^task_/);
    expect(normalized.current?.metadata).toBeUndefined();
    expect(normalized.pending).toEqual([]);
    expect(normalized.done[0]).toMatchObject({
      id: 'done',
      description: 'legacy done',
      priority: 'normal',
      outcome: 'completed',
      result: null,
    });
    expect(normalized.done[0].completedAt).toEqual(expect.any(String));
    expect(normalized.events).toEqual([
      { id: 'event', type: 'task.failed', taskId: 'done', at: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('normalizes non-object and partially malformed persisted states', async () => {
    const filePath = path.join(tempDir, 'states.json');
    const storage = new FileStorage(filePath);

    await fs.writeFile(filePath, 'null', 'utf8');
    expect(await storage.read()).toEqual({ current: null, pending: [], done: [], events: [] });

    await fs.writeFile(
      filePath,
      JSON.stringify({
        current: {
          id: 'current',
          description: 'current task',
          priority: 'bad',
          source: 'bad',
          addedAt: 1,
        },
        pending: [
          {
            id: 1,
            description: 'pending task',
            priority: 'low',
            source: 'system',
            addedAt: 2,
            metadata: null,
          },
        ],
        done: [
          {
            id: 2,
            description: 3,
            priority: 'high',
            source: 'user',
            addedAt: 4,
            completedAt: 5,
            outcome: 'bad',
          },
        ],
      }),
      'utf8',
    );

    const normalized = await storage.read();
    expect(normalized.current).toMatchObject({
      id: 'current',
      description: 'current task',
      priority: 'normal',
      source: 'application',
      attempt: 1,
    });
    expect(normalized.current?.addedAt).toEqual(expect.any(String));
    expect(normalized.pending[0]).toMatchObject({
      description: 'pending task',
      priority: 'low',
      source: 'system',
      attempt: 1,
    });
    expect(normalized.pending[0].id).toMatch(/^task_/);
    expect(normalized.pending[0].addedAt).toEqual(expect.any(String));
    expect(normalized.pending[0].metadata).toBeUndefined();
    expect(normalized.done[0]).toMatchObject({
      description: '',
      priority: 'high',
      source: 'user',
      outcome: 'completed',
      attempt: 1,
    });
    expect(normalized.done[0].id).toMatch(/^task_/);
    expect(normalized.done[0].addedAt).toEqual(expect.any(String));
    expect(normalized.done[0].completedAt).toEqual(expect.any(String));
  });

  it('propagates non-missing read errors', async () => {
    const storage = new FileStorage(tempDir);

    await expect(storage.read()).rejects.toThrow();
  });
});
