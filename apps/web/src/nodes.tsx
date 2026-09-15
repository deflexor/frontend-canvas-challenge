import { createContext, useContext, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { Handle, Position, type NodeProps, type NodeTypes } from '@xyflow/react';
import type { Scenario, GenerationView } from './generationTracker';
import type {
  CanvasNode,
  GeneratorNode as GeneratorNodeType,
  NodeType,
  PromptNode as PromptNodeType,
  ResultNode as ResultNodeType,
} from './graph';
import { NODE_LABELS } from './graph';
import { assetUrl } from './api';

export type CanvasActions = {
  setText: (id: string, text: string) => void;
  removeNode: (id: string) => void;
  generate: (id: string, scenario: Scenario) => void;
  retry: (id: string) => void;
};

export type CanvasValue = {
  actions: CanvasActions;
  /** Последняя генерация по каждой ноде генератора. */
  generations: Map<string, GenerationView>;
  /** Активный результат по ноде результата. */
  resultFor: Map<string, GenerationView>;
};

const CanvasContext = createContext<CanvasValue | null>(null);
CanvasContext.displayName = 'Canvas';

export function CanvasProvider({ value, children }: { value: CanvasValue; children: ReactNode }) {
  return <CanvasContext.Provider value={value}>{children}</CanvasContext.Provider>;
}

const useCanvas = () => useContext(CanvasContext)!;

const RemoveButton = ({ onClick, label }: { onClick: () => void; label: string }) => (
  <button
    type="button"
    className="node__remove nodrag"
    aria-label={label}
    title={label}
    onClick={onClick}
  >
    ✕
  </button>
);

const Header = ({ type }: { type: NodeType }) => (
  <header className="node__header">
    <span className={`node__mark node__mark--${type}`} aria-hidden="true" />
    {NODE_LABELS[type]}
  </header>
);

function PromptNode({ id, data }: NodeProps<PromptNodeType>) {
  const { actions } = useCanvas();
  const onText = (event: ChangeEvent<HTMLTextAreaElement>) =>
    actions.setText(id, event.target.value);
  return (
    <div className="node node--prompt">
      <Header type="prompt" />
      <RemoveButton onClick={() => actions.removeNode(id)} label="Удалить ноду текста" />
      <textarea
        className="node__text nodrag nowheel"
        value={data.text}
        onChange={onText}
        placeholder="Опишите изображение"
        aria-label="Описание изображения"
        rows={3}
      />
      <Handle type="source" position={Position.Right} aria-label="Выход: к генератору" />
    </div>
  );
}

const SCENARIO_LABELS: Record<Scenario, string> = { success: 'Успех', failure: 'Отказ' };

function GeneratorNode({ id, data }: NodeProps<GeneratorNodeType>) {
  const { actions, generations } = useCanvas();
  const [scenario, setScenario] = useState<Scenario>('success');
  const generation = generations.get(id);
  const busy = generation?.status === 'processing';
  const onScenario = (event: ChangeEvent<HTMLSelectElement>) =>
    setScenario(event.target.value as Scenario);
  return (
    <div className="node node--generator">
      <Header type="generator" />
      <RemoveButton onClick={() => actions.removeNode(id)} label="Удалить ноду генератора" />
      <Handle type="target" position={Position.Left} aria-label="Вход: от текста" />
      <label className="node__field nodrag">
        Сценарий проверки
        <select value={scenario} onChange={onScenario} disabled={busy}>
          {Object.entries(SCENARIO_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="nodrag node__primary"
        disabled={busy}
        onClick={() => actions.generate(id, scenario)}
      >
        {busy ? 'Генерация…' : 'Сгенерировать'}
      </button>
      {generation?.status === 'failed' && (
        <p className="node__alert" role="alert">
          Генерация не удалась: {generation.failureCode}.{' '}
          <button type="button" className="nodrag" onClick={() => actions.retry(id)}>
            Повторить
          </button>
        </p>
      )}
      {generation?.status === 'error' && (
        <p className="node__alert" role="alert">
          {generation.message}{' '}
          <button type="button" className="nodrag" onClick={() => actions.retry(id)}>
            Повторить
          </button>
        </p>
      )}
      <Handle type="source" position={Position.Right} aria-label="Выход: к результату" />
    </div>
  );
}

function ResultNode({ id, data }: NodeProps<ResultNodeType>) {
  const { actions, resultFor } = useCanvas();
  const generation = resultFor.get(id);
  return (
    <div className="node node--result">
      <Header type="result" />
      <RemoveButton onClick={() => actions.removeNode(id)} label="Удалить ноду результата" />
      <Handle type="target" position={Position.Left} aria-label="Вход: от генератора" />
      {generation?.status === 'succeeded' && generation.imageUrl ? (
        <img
          className="node__image"
          src={assetUrl(generation.imageUrl)}
          alt={`Результат генерации: ${data.label}`}
        />
      ) : generation?.status === 'processing' ? (
        <p className="node__wait">Генерация…</p>
      ) : generation?.status === 'failed' ? (
        <p className="node__alert" role="alert">
          Генерация не удалась: {generation.failureCode}.
        </p>
      ) : generation?.status === 'error' ? (
        <p className="node__alert" role="alert">
          {generation.message}
        </p>
      ) : (
        <p className="node__empty">Здесь появится изображение</p>
      )}
    </div>
  );
}

export const nodeTypes = {
  prompt: PromptNode,
  generator: GeneratorNode,
  result: ResultNode,
} satisfies NodeTypes;
