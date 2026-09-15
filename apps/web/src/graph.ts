import type { Edge as RFEdge, Node as RFNode, Viewport } from '@xyflow/react';
import type { GraphData, NodeData } from '@canvas/contracts';

/** Данные нод: у prompt — текст, у остальных — подпись. Это же форма сохраняется на сервер. */
export type PromptData = { text: string };
export type LabelData = { label: string };
export type PromptNode = RFNode<PromptData, 'prompt'>;
export type GeneratorNode = RFNode<LabelData, 'generator'>;
export type ResultNode = RFNode<LabelData, 'result'>;
export type CanvasNode = PromptNode | GeneratorNode | ResultNode;

export const NODE_LABELS = {
  prompt: 'Текст',
  generator: 'Генератор',
  result: 'Результат',
} as const;
export type NodeType = keyof typeof NODE_LABELS;

/** Стартовая ширина нод; высота — по содержимому, чтобы порты сидели ровно по центру карточки. */
export const DEFAULT_SIZES: Record<NodeType, { width: number }> = {
  prompt: { width: 240 },
  generator: { width: 220 },
  result: { width: 240 },
};

/** Один проход: серверный граф -> ноды и связи React Flow. Служебные поля не сохраняем. */
export const fromGraph = (graph: GraphData) => ({
  nodes: graph.nodes.map<CanvasNode>((node) => {
    const size = DEFAULT_SIZES[node.type];
    return node.type === 'prompt'
      ? {
          id: node.id,
          type: 'prompt',
          position: node.position,
          ...size,
          data: { text: node.data.text },
        }
      : {
          id: node.id,
          type: node.type,
          position: node.position,
          ...size,
          data: { label: node.data.label },
        };
  }),
  edges: graph.edges.map<RFEdge>(({ id, source, target }) => ({ id, source, target })),
  viewport: graph.viewport,
});

/** Один проход: состояние React Flow -> граф для PUT. Только поля схемы, без selected/dragging/measured. */
export const toGraph = (nodes: CanvasNode[], edges: RFEdge[], viewport: Viewport): GraphData => ({
  nodes: nodes.map<NodeData>((node) =>
    node.type === 'prompt'
      ? { id: node.id, type: 'prompt', position: node.position, data: { text: node.data.text } }
      : { id: node.id, type: node.type, position: node.position, data: { label: node.data.label } },
  ),
  edges: edges.map(({ id, source, target }) => ({ id, source, target })),
  viewport,
});

/** Разрешённые направления связей: текст -> генератор -> результат. */
const TARGET_OF: Partial<Record<NodeType, NodeType>> = { prompt: 'generator', generator: 'result' };

/** Единственное правило связи: совместимость типов, один вход и один выход генератора. */
export const canConnect = (
  types: Map<string, NodeType>,
  edges: Pick<RFEdge, 'source' | 'target'>[],
  source: string,
  target: string,
): boolean => {
  if (source === target) return false;
  const sourceType = types.get(source);
  const targetType = types.get(target);
  if (sourceType === undefined || targetType === undefined) return false;
  if (TARGET_OF[sourceType] !== targetType) return false;
  // Свободный вход у цели; у генератора ещё и свободный выход.
  return (
    !edges.some((edge) => edge.target === target) &&
    (sourceType !== 'generator' || !edges.some((edge) => edge.source === source))
  );
};

/**
 * Сравнение снимка графа с серверным. Сервер хранит и возвращает присланные байты,
 * поэтому порядок элементов совпадает и достаточно одного прохода без копий и мутаций.
 */
export const sameGraph = (a: GraphData, b: GraphData): boolean =>
  a.viewport.x === b.viewport.x &&
  a.viewport.y === b.viewport.y &&
  a.viewport.zoom === b.viewport.zoom &&
  a.nodes.length === b.nodes.length &&
  a.edges.length === b.edges.length &&
  a.nodes.every((node, i) => sameNode(node, b.nodes[i])) &&
  a.edges.every((edge, i) => sameEdge(edge, b.edges[i]));

const sameNode = (a: NodeData, b: NodeData | undefined): boolean =>
  b !== undefined &&
  a.id === b.id &&
  a.type === b.type &&
  a.position.x === b.position.x &&
  a.position.y === b.position.y &&
  (a.type === 'prompt'
    ? a.data.text === (b.data as { text: string }).text
    : a.data.label === (b.data as { label: string }).label);

const sameEdge = (a: GraphData['edges'][number], b: GraphData['edges'][number] | undefined) =>
  b !== undefined && a.id === b.id && a.source === b.source && a.target === b.target;
