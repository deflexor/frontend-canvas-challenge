import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canConnect, fromGraph, sameGraph, toGraph } from '../src/graph';
import type { GraphData } from '@canvas/contracts';

const graph = (): GraphData => ({
  nodes: [
    { id: 'p1', type: 'prompt', position: { x: 0, y: 0 }, data: { text: 'Горы' } },
    { id: 'g1', type: 'generator', position: { x: 320, y: 0 }, data: { label: 'Генератор' } },
    { id: 'r1', type: 'result', position: { x: 640, y: 0 }, data: { label: 'Результат' } },
  ],
  edges: [{ id: 'e1', source: 'p1', target: 'g1' }],
  viewport: { x: 12, y: -3, zoom: 1.5 },
});

const index = (g: GraphData) => new Map(g.nodes.map((node) => [node.id, node.type]));

test('серверный граф превращается в React Flow и обратно без потерь', () => {
  const view = fromGraph(graph());
  assert.equal(view.nodes.length, 3);
  assert.deepEqual(view.nodes[0].data, { text: 'Горы' });
  const restored = toGraph(view.nodes, view.edges, view.viewport);
  assert.deepEqual(restored, graph());
  assert.ok(sameGraph(restored, graph()));
});

test('sameGraph различает состав и порядок не различает только при равенстве', () => {
  const a = graph();
  const b = graph();
  assert.ok(sameGraph(a, b));
  b.nodes.pop();
  assert.ok(!sameGraph(a, b));
  const c = graph();
  c.viewport.zoom = 1;
  assert.ok(!sameGraph(a, c));
});

test('правила связей: только текст→генератор→результат, один вход, один выход генератора', () => {
  const g = graph();
  const types = index(g);
  assert.ok(canConnect(types, [], 'p1', 'g1')); // текст → генератор
  assert.ok(canConnect(types, [], 'g1', 'r1')); // генератор → результат
  assert.ok(!canConnect(types, [], 'p1', 'r1')); // текст → результат
  assert.ok(!canConnect(types, [], 'g1', 'p1')); // назад
  assert.ok(!canConnect(types, [], 'p1', 'p1')); // в себя
  assert.ok(!canConnect(types, [], 'unknown', 'g1')); // нет ноды
  // связь p1→g1 существует: второй вход в g1 запрещён
  assert.ok(!canConnect(types, g.edges, 'p1', 'g1'));
  const withInput = graph();
  withInput.nodes.push({
    id: 'p2',
    type: 'prompt',
    position: { x: 0, y: 200 },
    data: { text: 'Море' },
  });
  const types2 = index(withInput);
  assert.ok(!canConnect(types2, withInput.edges, 'p2', 'g1'));
  // но свободный выход текста к другому генератору разрешён
  assert.ok(canConnect(types2, [], 'p1', 'g1'));
  // у генератора уже есть выход к r1: второй запрещён
  const withOutput = graph();
  withOutput.edges.push({ id: 'e2', source: 'g1', target: 'r1' });
  withOutput.nodes.push({
    id: 'r2',
    type: 'result',
    position: { x: 640, y: 200 },
    data: { label: 'Ещё' },
  });
  const types3 = index(withOutput);
  assert.ok(!canConnect(types3, withOutput.edges, 'g1', 'r2'));
  assert.ok(!canConnect(types3, withOutput.edges, 'g1', 'r1')); // дубль
});
