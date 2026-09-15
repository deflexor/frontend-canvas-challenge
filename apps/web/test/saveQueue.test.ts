import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../src/api';
import { SaveQueue, type SaveQueueCallbacks } from '../src/saveQueue';
import type { SaveStatus } from '../src/saveQueue';

/** Пауза до конца микрозадач, чтобы промисы из «сработавшего» таймера дошли до конца. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

type Harness = {
  queue: SaveQueue;
  sends: { body: string; etag: string }[];
  statuses: { status: SaveStatus; error?: unknown }[];
  resolve: (etag: string) => void;
  reject: (error: unknown) => void;
  setReread: (reread: SaveQueueCallbacks['reread']) => void;
};

const setup = (initialEtag = '"etag-0"'): Harness => {
  const sends: { body: string; etag: string }[] = [];
  const statuses: { status: SaveStatus; error?: unknown }[] = [];
  let pending: { resolve: (etag: string) => void; reject: (error: unknown) => void } | null = null;
  let reread: SaveQueueCallbacks['reread'] = async () => {
    throw new Error('reread not expected');
  };
  const callbacks: SaveQueueCallbacks = {
    // Снимок читается в момент отправки: значение зависит от числа уже отправленных тел.
    snapshot: () =>
      JSON.stringify({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 + sends.length } }),
    send: (body, etag) =>
      new Promise<string>((resolve, reject) => {
        sends.push({ body, etag });
        pending = { resolve, reject };
      }),
    reread: () => reread(),
    onStatus: (status, error) => statuses.push({ status, error }),
  };
  return {
    queue: new SaveQueue(initialEtag, callbacks),
    sends,
    statuses,
    resolve: (etag) => {
      pending?.resolve(etag);
      pending = null;
    },
    reject: (error) => {
      pending?.reject(error);
      pending = null;
    },
    setReread: (value) => {
      reread = value;
    },
  };
};

test('серия быстрых правок даёт одно сохранение после паузы', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = setup();
  h.queue.markDirty();
  h.queue.markDirty();
  h.queue.markDirty();
  assert.equal(h.queue.state, 'pending');
  t.mock.timers.tick(499);
  await settle();
  assert.equal(h.sends.length, 0);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(h.sends.length, 1);
  h.resolve('"etag-1"');
  await settle();
  assert.equal(h.queue.state, 'idle');
  assert.deepEqual(
    h.statuses.map((entry) => entry.status),
    ['pending', 'saving', 'idle'],
  );
});

test('правки во время запроса догоняют следующим PUT с ETag из ответа', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = setup();
  h.queue.markDirty();
  t.mock.timers.tick(500);
  await settle();
  h.queue.markDirty(); // правка, пока первый запрос в полёте
  h.resolve('"etag-1"');
  await settle();
  assert.equal(h.sends.length, 2); // новый снимок ушёл после завершения первого
  assert.deepEqual(h.sends[1], {
    body: '{"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":2}}',
    etag: '"etag-1"',
  });
  h.resolve('"etag-2"');
  await settle();
  assert.equal(h.queue.state, 'idle');
  assert.equal(h.queue.currentEtag, '"etag-2"');
});

test('412 переходит в конфликт без повторных попыток; reset возвращает работу', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = setup();
  h.queue.markDirty();
  t.mock.timers.tick(500);
  await settle();
  h.reject(new ApiError(412, 'GRAPH_VERSION_CONFLICT', 'Граф изменился.'));
  await settle();
  assert.equal(h.queue.state, 'conflict');
  assert.equal(h.sends.length, 1);
  h.queue.markDirty(); // правки при конфликте не запускают сохранение
  assert.equal(h.queue.state, 'conflict');
  h.queue.reset('"etag-9"');
  assert.equal(h.queue.state, 'idle');
  h.queue.markDirty();
  t.mock.timers.tick(500);
  await settle();
  assert.deepEqual(h.sends[1], {
    body: '{"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":2}}',
    etag: '"etag-9"',
  });
  h.resolve('"etag-10"');
  await settle();
  assert.equal(h.queue.state, 'idle');
});

test('потерянный ответ: сервер уже хранит снимок — ETag принимается без повторной отправки', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = setup();
  h.setReread(async () => ({
    data: JSON.parse(h.sends[0]?.body ?? 'null') as never,
    etag: '"etag-server"',
  }));
  h.queue.markDirty();
  t.mock.timers.tick(500);
  await settle();
  h.reject(new ApiError(0, 'NETWORK', 'Сервер недоступен.'));
  await settle();
  assert.equal(h.queue.state, 'idle');
  assert.equal(h.queue.currentEtag, '"etag-server"');
  assert.equal(h.sends.length, 1);
});

test('потерянный ответ: сервер не хранит снимок — повтор с актуальным ETag', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = setup();
  h.setReread(async () => ({
    data: { nodes: [], edges: [], viewport: { x: 1, y: 2, zoom: 1 } },
    etag: '"etag-server"',
  }));
  h.queue.markDirty();
  t.mock.timers.tick(500);
  await settle();
  h.reject(new ApiError(0, 'NETWORK', 'Сервер недоступен.'));
  await settle();
  // Повторяются те же байты снимка, но с актуальным ETag сервера.
  assert.deepEqual(h.sends[1], {
    body: '{"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}',
    etag: '"etag-server"',
  });
  h.resolve('"etag-2"');
  await settle();
  assert.equal(h.queue.state, 'idle');
  assert.equal(h.sends.length, 2);
});

test('flush сохраняет сразу, отменяя таймер debounce', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = setup();
  h.queue.markDirty();
  const done = h.queue.flush();
  t.mock.timers.tick(0);
  await settle();
  assert.equal(h.sends.length, 1);
  h.resolve('"etag-1"');
  await done;
  assert.equal(h.queue.state, 'idle');
});

test('без правок flush ничего не отправляет', async () => {
  const h = setup();
  await h.queue.flush();
  assert.equal(h.sends.length, 0);
  assert.equal(h.queue.state, 'idle');
});
