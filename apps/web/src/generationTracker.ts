import type { GenerationData } from '@canvas/contracts';
import { ApiError } from './api';

export type Scenario = 'success' | 'failure';

export type GenerationView = {
  /** Ключ идемпотентности последнего запуска; повтор после сетевой ошибки идёт с тем же ключом. */
  key: string | null;
  scenario: Scenario;
  generationId: string | null;
  resultNodeId: string;
  status: 'processing' | 'succeeded' | 'failed' | 'error';
  imageUrl: string | null;
  failureCode: string | null;
  message: string | null;
};

export type GenerationCallbacks = {
  create: (
    nodeId: string,
    graphEtag: string,
    scenario: Scenario,
    key: string,
  ) => Promise<GenerationData>;
  read: (generationId: string) => Promise<GenerationData>;
  onChange: () => void;
};

/**
 * Отслеживание генераций по ноде генератора: запуск с Idempotency-Key, опрос
 * до конечного статуса, восстановление списка после перезагрузки. Один опрос
 * на активную генерацию; замена записи более новой попыткой останавливает старую.
 */
export class GenerationTracker {
  private readonly entries = new Map<string, GenerationView>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Пауза опроса, если ответ не содержит Retry-After; уточняется из /api/config. */
  pollIntervalMs = 500;

  constructor(private readonly callbacks: GenerationCallbacks) {}

  views(): Map<string, GenerationView> {
    return new Map(this.entries);
  }

  view(nodeId: string) {
    return this.entries.get(nodeId);
  }

  /** Новая генерация: всегда новый Idempotency-Key. */
  async start(nodeId: string, resultNodeId: string, scenario: Scenario, graphEtag: string) {
    await this.launch(nodeId, resultNodeId, scenario, graphEtag, crypto.randomUUID());
  }

  /**
   * Повтор запуска: тот же ключ и сценарий, если запрос мог дойти (сетевая ошибка);
   * после конечного отказа сервера ключ исчерпан — берётся новый.
   */
  async retry(nodeId: string, graphEtag: string) {
    const entry = this.entries.get(nodeId);
    if (!entry || entry.status === 'processing') return;
    const reuseKey = entry.status === 'error';
    await this.launch(
      nodeId,
      entry.resultNodeId,
      entry.scenario,
      graphEtag,
      reuseKey ? (entry.key ?? crypto.randomUUID()) : crypto.randomUUID(),
    );
  }

  /** Локальный отказ запуска без запроса: неполная цепочка. */
  fail(nodeId: string, message: string) {
    const entry = this.entries.get(nodeId);
    if (!entry || entry.status === 'processing') return;
    this.entries.set(nodeId, { ...entry, status: 'error', message });
    this.callbacks.onChange();
  }

  /** Восстановление после перезагрузки: список идёт от новых к старым, первая запись по ноде — актуальная. */
  restore(generations: GenerationData[]) {
    const seen = new Set<string>();
    for (const generation of generations) {
      if (seen.has(generation.nodeId)) continue;
      seen.add(generation.nodeId);
      this.entries.set(generation.nodeId, {
        key: null,
        scenario: generation.scenario,
        generationId: generation.id,
        resultNodeId: generation.resultNodeId,
        status: generation.status,
        imageUrl: generation.imageUrl,
        failureCode: generation.failureCode,
        message: null,
      });
      if (generation.status === 'processing') this.schedule(generation.nodeId, generation.id);
    }
    this.callbacks.onChange();
  }

  dispose() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private async launch(
    nodeId: string,
    resultNodeId: string,
    scenario: Scenario,
    graphEtag: string,
    key: string,
  ) {
    this.timers.delete(nodeId);
    this.entries.set(nodeId, {
      key,
      scenario,
      generationId: null,
      resultNodeId,
      status: 'processing',
      imageUrl: null,
      failureCode: null,
      message: null,
    });
    this.callbacks.onChange();
    try {
      this.apply(nodeId, await this.callbacks.create(nodeId, graphEtag, scenario, key));
    } catch (error) {
      this.timers.delete(nodeId);
      this.entries.set(nodeId, {
        ...this.entries.get(nodeId)!,
        status: 'error',
        message: error instanceof ApiError ? error.message : 'Запуск генерации не удался.',
      });
      this.callbacks.onChange();
    }
  }

  private apply(nodeId: string, generation: GenerationData) {
    const entry = this.entries.get(nodeId);
    // Запись могла быть заменена более новой попыткой — старый ответ не подставляется.
    if (!entry || (entry.generationId !== null && entry.generationId !== generation.id)) return;
    this.entries.set(nodeId, {
      ...entry,
      generationId: generation.id,
      status: generation.status,
      imageUrl: generation.imageUrl,
      failureCode: generation.failureCode,
    });
    if (generation.status === 'processing') this.schedule(nodeId, generation.id);
    else this.timers.delete(nodeId);
    this.callbacks.onChange();
  }

  private schedule(nodeId: string, generationId: string, delayMs?: number) {
    const timer = setTimeout(
      () => void this.poll(nodeId, generationId),
      delayMs ?? this.pollIntervalMs,
    );
    this.timers.set(nodeId, timer);
  }

  private async poll(nodeId: string, generationId: string) {
    try {
      const generation = await this.callbacks.read(generationId);
      const entry = this.entries.get(nodeId);
      if (!entry || entry.generationId !== generationId) return;
      this.apply(nodeId, generation);
    } catch (error) {
      const entry = this.entries.get(nodeId);
      if (!entry || entry.generationId !== generationId) return;
      if (error instanceof ApiError && error.status === 404) {
        this.timers.delete(nodeId);
        this.entries.set(nodeId, { ...entry, status: 'error', message: error.message });
        this.callbacks.onChange();
        return;
      }
      // Временный сбой сети: продолжаем опрос, генерация на сервере продолжает выполняться.
      this.schedule(nodeId, generationId);
    }
  }
}
