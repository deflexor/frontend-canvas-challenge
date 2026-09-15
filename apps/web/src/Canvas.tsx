import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
} from '@xyflow/react';
import type {
  Connection,
  Edge as RFEdge,
  EdgeChange,
  IsValidConnection,
  NodeChange,
  OnEdgesChange,
  OnNodesChange,
  Viewport,
} from '@xyflow/react';

import { ApiError, api, loadWorkspace } from './api';
import {
  DEFAULT_SIZES,
  NODE_LABELS,
  canConnect,
  fromGraph,
  toGraph,
  type CanvasNode,
  type NodeType,
} from './graph';
import { SaveQueue, type SaveStatus } from './saveQueue';
import { GenerationTracker, type GenerationView, type Scenario } from './generationTracker';
import { CanvasProvider, nodeTypes } from './nodes';

const FALLBACK_POLL_MS = 500;

type Limits = { maxNodes: number; maxEdges: number; pollIntervalMs: number };

/** Изменения, влияющие на сохранённый граф; выделение и замеры нод сохранение не запускают. */
const changesPersisted = (
  changes: readonly (NodeChange<CanvasNode> | EdgeChange<RFEdge>)[],
): boolean =>
  changes.some(
    (change) =>
      change.type !== 'select' &&
      change.type !== 'dimensions' &&
      !(change.type === 'position' && change.dragging),
  );

function Canvas({ spaceId, onLeave }: { spaceId: string; onLeave: () => void }) {
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [edges, setEdges] = useState<RFEdge[]>([]);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const viewportRef = useRef<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [initialViewport, setInitialViewport] = useState<Viewport | null>(null);
  const [title, setTitle] = useState('');
  const [limits, setLimits] = useState<Limits>({
    maxNodes: 20,
    maxEdges: 20,
    pollIntervalMs: FALLBACK_POLL_MS,
  });
  const [save, setSave] = useState<{ status: SaveStatus; error: ApiError | null }>({
    status: 'idle',
    error: null,
  });
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [generations, setGenerations] = useState<Map<string, GenerationView>>(new Map());
  const [loadError, setLoadError] = useState<ApiError | null>(null);

  const queueRef = useRef<SaveQueue | null>(null);
  const trackerRef = useRef<GenerationTracker | null>(null);
  const { screenToFlowPosition } = useReactFlow();

  const commit = useCallback((nextNodes: CanvasNode[], nextEdges: RFEdge[]) => {
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    setNodes(nextNodes);
    setEdges(nextEdges);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tracker = new GenerationTracker({
      create: (nodeId, graphEtag, scenario, key) =>
        api
          .createGeneration(spaceId, { nodeId, graphETag: graphEtag, scenario }, key)
          .then((result) => result.data),
      read: (generationId) =>
        api.getGeneration(spaceId, generationId).then((result) => result.data),
      onChange: (): void => setGenerations(tracker.views()),
    });
    loadWorkspace(spaceId)
      .then((loaded) => {
        if (cancelled) return;
        const view = fromGraph(loaded.graph);
        tracker.pollIntervalMs = loaded.pollIntervalMs;
        setTitle(loaded.title);
        commit(view.nodes, view.edges);
        viewportRef.current = view.viewport;
        setInitialViewport(view.viewport);
        setLimits({
          maxNodes: loaded.maxNodes,
          maxEdges: loaded.maxEdges,
          pollIntervalMs: loaded.pollIntervalMs,
        });
        queueRef.current = new SaveQueue(loaded.etag, {
          snapshot: () =>
            JSON.stringify(toGraph(nodesRef.current, edgesRef.current, viewportRef.current)),
          send: (body, etag) => api.putGraph(spaceId, body, etag).then((r) => r.etag ?? etag),
          reread: async () => {
            const reread = await api.getGraph(spaceId);
            return { data: reread.data, etag: reread.etag ?? '' };
          },
          onStatus: (status, error) => {
            setSave({ status, error: error ?? null });
            if (status === 'idle') setSavedAt(new Date());
          },
        });
        trackerRef.current = tracker;
        tracker.restore(loaded.generations);
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setLoadError(
            error instanceof ApiError
              ? error
              : new ApiError(0, 'UNKNOWN', 'Не удалось загрузить пространство.'),
          );
      });
    return () => {
      cancelled = true;
      tracker.dispose();
      queueRef.current?.dispose();
    };
  }, [spaceId, commit]);

  const touch = useCallback(() => queueRef.current?.markDirty(), []);

  const handleNodesChange: OnNodesChange<CanvasNode> = useCallback(
    (changes) => {
      commit(applyNodeChanges(changes, nodesRef.current), edgesRef.current);
      if (changesPersisted(changes)) touch();
    },
    [commit, touch],
  );

  const handleEdgesChange: OnEdgesChange<RFEdge> = useCallback(
    (changes) => {
      commit(nodesRef.current, applyEdgeChanges(changes, edgesRef.current));
      if (changesPersisted(changes)) touch();
    },
    [commit, touch],
  );

  const typeIndex = useMemo(
    () => new Map(nodesRef.current.map((node) => [node.id, node.type])),
    [nodes],
  );

  /** Единая проверка связи: правила типов и свободные порты; используется и при перетаскивании. */
  const isValidConnection = useCallback<IsValidConnection>(
    (connection) => {
      const { source, target } = connection;
      return (
        !!source &&
        !!target &&
        edgesRef.current.length < limits.maxEdges &&
        canConnect(typeIndex, edgesRef.current, source, target)
      );
    },
    [typeIndex, limits.maxEdges],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      const { source, target } = connection;
      if (!source || !target || !isValidConnection(connection)) return;
      commit(nodesRef.current, [...edgesRef.current, { id: crypto.randomUUID(), source, target }]);
      touch();
    },
    [commit, isValidConnection, touch],
  );

  const handleMove = useCallback((_: unknown, viewport: Viewport) => {
    // Частое событие во время панорамы: обновляем только ссылку для снимка, без рендера.
    viewportRef.current = viewport;
  }, []);

  const handleMoveEnd = useCallback(
    (_: unknown, viewport: Viewport) => {
      viewportRef.current = viewport;
      touch();
    },
    [touch],
  );

  const addNode = useCallback(
    (type: NodeType) => {
      if (nodesRef.current.length >= limits.maxNodes) return;
      const center = screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      });
      // Сетка без перекрытий: ноды шире 240, шаг 300 по столбцу и 220 по строке.
      const count = nodesRef.current.length;
      const position = {
        x: center.x + (count % 4) * 300 - 450,
        y: center.y + Math.floor(count / 4) * 220 - 110,
      };
      const base = { id: crypto.randomUUID(), type, position, ...DEFAULT_SIZES[type] };
      const node =
        type === 'prompt'
          ? { ...base, data: { text: '' } }
          : { ...base, data: { label: NODE_LABELS[type] } };
      commit([...nodesRef.current, node as CanvasNode], edgesRef.current);
      touch();
    },
    [commit, limits.maxNodes, screenToFlowPosition, touch],
  );

  const setText = useCallback(
    (id: string, text: string) => {
      // Один проход по нодам; неизменённые объекты сохраняют ссылки.
      commit(
        nodesRef.current.map((node) =>
          node.id === id && node.type === 'prompt' ? { ...node, data: { text } } : node,
        ),
        edgesRef.current,
      );
      touch();
    },
    [commit, touch],
  );

  const removeNode = useCallback(
    (id: string) => {
      commit(
        nodesRef.current.filter((node) => node.id !== id),
        edgesRef.current.filter((edge) => edge.source !== id && edge.target !== id),
      );
      touch();
    },
    [commit, touch],
  );

  /** Сохранение не дожидаясь debounce; генерация запускается только при успешном сохранении. */
  const prepare = useCallback(async () => {
    const queue = queueRef.current;
    if (!queue) return false;
    await queue.flush();
    return queue.state === 'idle';
  }, []);

  const generate = useCallback(
    async (id: string, scenario: Scenario) => {
      const tracker = trackerRef.current;
      if (!tracker || !(await prepare())) return;
      const target = edgesRef.current.find((edge) => edge.source === id)?.target;
      const promptId = edgesRef.current.find((edge) => edge.target === id)?.source;
      const prompt = nodesRef.current.find((node) => node.id === promptId);
      if (target === undefined || prompt?.type !== 'prompt' || prompt.data.text.trim() === '') {
        tracker.fail(id, 'Нужна цепочка: непустой текст, этот генератор и результат.');
        return;
      }
      await tracker.start(id, target, scenario, queueRef.current!.currentEtag);
    },
    [prepare],
  );

  const retry = useCallback(
    async (id: string) => {
      const tracker = trackerRef.current;
      if (!tracker || !(await prepare())) return;
      await tracker.retry(id, queueRef.current!.currentEtag);
    },
    [prepare],
  );

  const actions = useMemo(
    () => ({ setText, removeNode, generate, retry }),
    [setText, removeNode, generate, retry],
  );

  /** Результат попадает в ноду с тем resultNodeId, что был при запуске генерации. */
  const resultFor = useMemo(() => {
    const map = new Map<string, GenerationView>();
    for (const view of generations.values()) map.set(view.resultNodeId, view);
    return map;
  }, [generations]);

  const value = useMemo(
    () => ({ actions, generations, resultFor }),
    [actions, generations, resultFor],
  );

  const reloadServerGraph = useCallback(async () => {
    const reread = await api.getGraph(spaceId);
    const view = fromGraph(reread.data);
    commit(view.nodes, view.edges);
    // Viewport не трогаем: пользователь остаётся на своей позиции, сохранится она же.
    queueRef.current?.reset(reread.etag ?? '');
  }, [spaceId, commit]);

  const canAddNodes = nodes.length < limits.maxNodes;
  const canAddEdges = edges.length < limits.maxEdges;

  return (
    <CanvasProvider value={value}>
      <div className="app">
        <header className="topbar">
          <button type="button" onClick={onLeave}>
            Все пространства
          </button>
          <h1 className="topbar__title">{title}</h1>
          <SaveBadge
            status={save.status}
            error={save.error}
            savedAt={savedAt}
            onRetry={touch}
            onReload={reloadServerGraph}
          />
        </header>
        {loadError ? (
          <LoadError error={loadError} onLeave={onLeave} />
        ) : initialViewport === null ? (
          <p className="loading" role="status">
            Загрузка пространства…
          </p>
        ) : (
          <>
            <div className="toolbar" aria-label="Добавить ноду">
              {(Object.keys(NODE_LABELS) as NodeType[]).map((type) => (
                <button
                  key={type}
                  type="button"
                  disabled={!canAddNodes}
                  onClick={() => addNode(type)}
                >
                  + {NODE_LABELS[type]}
                </button>
              ))}
              <span className="toolbar__hint">
                Связи: текст → генератор → результат · нод {nodes.length} из {limits.maxNodes}
                {!canAddEdges && ' · лимит связей'}
              </span>
            </div>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              defaultViewport={initialViewport}
              minZoom={0.1}
              maxZoom={4}
              onNodesChange={handleNodesChange}
              onEdgesChange={handleEdgesChange}
              onConnect={handleConnect}
              onMove={handleMove}
              onMoveEnd={handleMoveEnd}
              isValidConnection={isValidConnection}
            >
              <Background />
              <Controls />
            </ReactFlow>
          </>
        )}
      </div>
    </CanvasProvider>
  );
}

const SAVE_LABELS: Record<Exclude<SaveStatus, 'idle' | 'error' | 'conflict'>, string> = {
  pending: 'Есть несохранённые правки',
  saving: 'Сохранение…',
};

function SaveBadge({
  status,
  error,
  savedAt,
  onRetry,
  onReload,
}: {
  status: SaveStatus;
  error: ApiError | null;
  savedAt: Date | null;
  onRetry: () => void;
  onReload: () => void;
}) {
  if (status === 'conflict')
    return (
      <p className="status status--error" role="alert">
        Конфликт версий: на сервере более новый граф, правки не потеряны.{' '}
        <button type="button" onClick={onReload}>
          Загрузить серверную версию
        </button>
      </p>
    );
  if (status === 'error')
    return (
      <p className="status status--error" role="alert">
        Ошибка сохранения: {error?.message ?? 'не удалось отправить граф'}.{' '}
        <button type="button" onClick={onRetry}>
          Повторить
        </button>
      </p>
    );
  return (
    <p
      className={status === 'pending' ? 'status status--pending' : 'status status--ok'}
      role="status"
    >
      {status === 'idle'
        ? `Сохранено в ${savedAt ? savedAt.toLocaleTimeString() : '—'}`
        : SAVE_LABELS[status]}
    </p>
  );
}

function LoadError({ error, onLeave }: { error: ApiError; onLeave: () => void }) {
  return (
    <div className="screen" role="alert">
      <p>Не удалось открыть пространство: {error.message}</p>
      <button type="button" onClick={onLeave}>
        К списку пространств
      </button>
    </div>
  );
}

export default function CanvasPage({ spaceId, onLeave }: { spaceId: string; onLeave: () => void }) {
  return (
    <ReactFlowProvider>
      <Canvas spaceId={spaceId} onLeave={onLeave} />
    </ReactFlowProvider>
  );
}
