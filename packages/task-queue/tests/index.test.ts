import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStorage, type Storage, TaskQueue, type TaskQueueState } from '../src/index.js';

class MemoryStorage implements Storage {
  state: TaskQueueState = { current: null, pending: [], done: [] };
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
      metadata: { package: '@ventus-software-solutions/task-queue' },
    });

    expect(task).toMatchObject({
      description: 'ship package',
      priority: 'high',
      source: 'user',
      metadata: { package: '@ventus-software-solutions/task-queue' },
    });
    expect(task).not.toHaveProperty('agreed');
    expect(task).not.toHaveProperty('sourceRef');
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
    expect(completed).toMatchObject({ description: 'urgent work', result: { ok: true } });

    expect((await queue.claimNext())?.description).toBe('high work');
    expect((await queue.completeCurrent())?.result).toBeUndefined();

    const state = await queue.peek();
    expect(state.current).toBeNull();
    expect(state.pending.map((task) => task.description)).toEqual(['normal work', 'low work']);
    expect(state.done.map((task) => task.description)).toEqual(['high work', 'urgent work']);
    expect(storage.lockCalls).toBe(9);
  });

  it('returns null when there is no work to claim or complete', async () => {
    const queue = new TaskQueue({ storage: new MemoryStorage() });

    expect(await queue.claimNext()).toBeNull();
    expect(await queue.completeCurrent()).toBeNull();
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
      result: 'done',
    });
  });

  it('returns an empty queue when the state file is missing', async () => {
    const state = await new FileStorage(path.join(tempDir, 'missing', 'tasks.json')).read();

    expect(state).toEqual({ current: null, pending: [], done: [] });
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
        },
      ],
      done: [],
    });

    expect(await storage.read()).toMatchObject({
      pending: [{ id: 'pending', priority: 'urgent' }],
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
      }),
      'utf8',
    );

    const normalized = await storage.read();
    expect(normalized.current).toMatchObject({
      description: '',
      priority: 'normal',
      source: 'application',
    });
    expect(normalized.current?.id).toMatch(/^task_/);
    expect(normalized.current?.metadata).toBeUndefined();
    expect(normalized.pending).toEqual([]);
    expect(normalized.done[0]).toMatchObject({
      id: 'done',
      description: 'legacy done',
      priority: 'normal',
      result: null,
    });
    expect(normalized.done[0].completedAt).toEqual(expect.any(String));
  });

  it('normalizes non-object and partially malformed persisted states', async () => {
    const filePath = path.join(tempDir, 'states.json');
    const storage = new FileStorage(filePath);

    await fs.writeFile(filePath, 'null', 'utf8');
    expect(await storage.read()).toEqual({ current: null, pending: [], done: [] });

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
          { id: 2, description: 3, priority: 'high', source: 'user', addedAt: 4, completedAt: 5 },
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
    });
    expect(normalized.current?.addedAt).toEqual(expect.any(String));
    expect(normalized.pending[0]).toMatchObject({
      description: 'pending task',
      priority: 'low',
      source: 'system',
    });
    expect(normalized.pending[0].id).toMatch(/^task_/);
    expect(normalized.pending[0].addedAt).toEqual(expect.any(String));
    expect(normalized.pending[0].metadata).toBeUndefined();
    expect(normalized.done[0]).toMatchObject({ description: '', priority: 'high', source: 'user' });
    expect(normalized.done[0].id).toMatch(/^task_/);
    expect(normalized.done[0].addedAt).toEqual(expect.any(String));
    expect(normalized.done[0].completedAt).toEqual(expect.any(String));
  });

  it('propagates non-missing read errors', async () => {
    const storage = new FileStorage(tempDir);

    await expect(storage.read()).rejects.toThrow();
  });
});
