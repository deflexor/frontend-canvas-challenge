import { ApiError } from './api';
import { sameGraph } from './graph';
import type { GraphData } from '@canvas/contracts';

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'error' | 'conflict';

export type SaveQueueCallbacks = {
  /** Сериализованный снимок текущего графа; читается только в момент отправки. */
  snapshot: () => string;
  send: (body: string, etag: string) => Promise<string>;
  /** Повторное чтение графа для проверки потерянного ответа. */
  reread: () => Promise<{ data: GraphData; etag: string }>;
  onStatus: (status: SaveStatus, error?: ApiError) => void;
};

/**
 * Очередь сохранений графа: debounce после последнего изменения, не более одного
 * PUT одновременно, правки во время запроса догоняют его следующим проходом цикла.
 * Снимок берётся в момент отправки, поэтому ответ не может затереть более новые правки.
 */
export class SaveQueue {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private dirty = false;
  private status: SaveStatus = 'idle';

  constructor(
    private etag: string,
    private readonly callbacks: SaveQueueCallbacks,
    private readonly debounceMs = 500,
  ) {}

  get state() {
    return this.status;
  }

  get currentEtag() {
    return this.etag;
  }

  private setStatus(status: SaveStatus, error?: ApiError) {
    if (this.status === status) return; // уведомляем только о переходе
    this.status = status;
    this.callbacks.onStatus(status, error);
  }

  /** Локальное изменение; перезапускает таймер debounce. */
  markDirty() {
    if (this.status === 'conflict') return; // правки ждут решения пользователя о конфликте
    this.dirty = true;
    this.setStatus('pending');
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }

  /** Сохранить не дожидаясь таймера; разрешается цепочка из предыдущих запусков. */
  flush(): Promise<void> {
    this.cancelTimer();
    return (this.chain = this.chain.then(() => this.run()));
  }

  /** Применить серверную версию после конфликта или при загрузке графа. */
  reset(etag: string) {
    this.cancelTimer();
    this.dirty = false;
    this.etag = etag;
    this.setStatus('idle');
  }

  /** Остановить отложенное сохранение (закрытие пространства, размонтирование). */
  dispose() {
    this.cancelTimer();
  }

  private cancelTimer() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async run() {
    if (!this.dirty || this.status === 'conflict') return;
    this.setStatus('saving');
    try {
      while (this.dirty) {
        this.dirty = false;
        const body = this.callbacks.snapshot();
        try {
          this.etag = await this.callbacks.send(body, this.etag);
        } catch (error) {
          // Ответ потерялся, но запрос мог выполниться: перечитываем граф и сравниваем со снимком.
          if (!(error instanceof ApiError) || error.status !== 0) throw error;
          const remote = await this.callbacks.reread();
          if (sameGraph(remote.data, JSON.parse(body) as GraphData)) {
            this.etag = remote.etag;
          } else {
            this.etag = await this.callbacks.send(body, remote.etag);
          }
        }
      }
      this.setStatus('idle');
    } catch (error) {
      this.dirty = true; // правки сохранены локально и не теряются
      this.setStatus(
        error instanceof ApiError && error.status === 412 ? 'conflict' : 'error',
        error instanceof ApiError ? error : undefined,
      );
    }
  }
}
