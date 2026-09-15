import type { GenerationData, GenerationRequest, GraphData, SpaceData } from '@canvas/contracts';

const BASE: string = import.meta.env?.VITE_API_BASE ?? 'http://localhost:4001';

/** Относительные адреса ресурсов (например, imageUrl) разворачиваются в адрес API. */
export const assetUrl = (path: string) => BASE + path;

/** Единственный вид ошибки, который видят компоненты: HTTP-статус, код и сообщение в одном месте. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ApiError';
  }
}

export type Result<T> = { data: T; etag: string | null; retryAfterMs: number | null };

type Options = {
  method?: string;
  body?: string;
  /** ETag для заголовка If-Match. */
  etag?: string;
  idempotencyKey?: string;
};

/**
 * Общий механизм отправки: адрес, заголовки, статус, пустое тело и разбор JSON живут здесь.
 * Сетевые, HTTP-ошибки и ошибки разбора приводятся к ApiError. Вызывающий код получает только данные.
 */
export async function request<T>(path: string, options: Options = {}): Promise<Result<T>> {
  const headers = new Headers();
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (options.etag !== undefined) headers.set('If-Match', options.etag);
  if (options.idempotencyKey !== undefined) headers.set('Idempotency-Key', options.idempotencyKey);
  let response: Response;
  try {
    response = await fetch(BASE + path, { ...options, headers });
  } catch (cause) {
    throw new ApiError(0, 'NETWORK', 'Сервер недоступен. Проверьте, что API запущен.', { cause });
  }
  const text = await response.text();
  let data: unknown;
  if (text !== '') {
    try {
      data = JSON.parse(text);
    } catch (cause) {
      throw new ApiError(response.status, 'INVALID_RESPONSE', 'Ответ сервера не является JSON.', {
        cause,
      });
    }
  }
  if (!response.ok) {
    const error = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? `HTTP_${response.status}`,
      error?.message ?? 'Запрос не выполнен.',
    );
  }
  const retryAfter = response.headers.get('Retry-After');
  return {
    data: data as T,
    etag: response.headers.get('ETag'),
    retryAfterMs: retryAfter === null ? null : Number(retryAfter) * 1000,
  };
}

const json = (value: unknown) => JSON.stringify(value);

/** Особенности конкретных запросов: адрес, метод и форма тела. */
export const api = {
  listSpaces: () => request<SpaceData[]>('/api/spaces'),
  createSpace: (title: string) =>
    request<SpaceData>('/api/spaces', { method: 'POST', body: json({ title }) }),
  getSpace: (spaceId: string) => request<SpaceData>(`/api/spaces/${spaceId}`),
  getGraph: (spaceId: string) => request<GraphData>(`/api/spaces/${spaceId}/graph`),
  /** Тело передаётся строкой: байты снимка сохраняются один к одному, как при отправке. */
  putGraph: (spaceId: string, body: string, etag: string) =>
    request<GraphData>(`/api/spaces/${spaceId}/graph`, { method: 'PUT', body, etag }),
  listGenerations: (spaceId: string) =>
    request<GenerationData[]>(`/api/spaces/${spaceId}/generations`),
  createGeneration: (spaceId: string, body: GenerationRequest, idempotencyKey: string) =>
    request<GenerationData>(`/api/spaces/${spaceId}/generations`, {
      method: 'POST',
      body: json(body),
      idempotencyKey,
    }),
  getGeneration: (spaceId: string, generationId: string) =>
    request<GenerationData>(`/api/spaces/${spaceId}/generations/${generationId}`),
};

export type Workspace = {
  title: string;
  graph: GraphData;
  etag: string;
  generations: GenerationData[];
  pollIntervalMs: number;
  maxNodes: number;
  maxEdges: number;
};

/** Первичная загрузка пространства: граф, его ETag, генерации и ограничения. */
export const loadWorkspace = async (spaceId: string): Promise<Workspace> => {
  const [space, graph, generations, config] = await Promise.all([
    api.getSpace(spaceId),
    api.getGraph(spaceId),
    api.listGenerations(spaceId),
    request<{ pollIntervalMs: number; maxNodes: number; maxEdges: number }>('/api/config'),
  ]);
  return {
    title: space.data.title,
    graph: graph.data,
    etag: graph.etag ?? '', // ETag графа выдаётся всегда; без него следующий PUT получит 428
    generations: generations.data,
    pollIntervalMs: config.data.pollIntervalMs,
    maxNodes: config.data.maxNodes,
    maxEdges: config.data.maxEdges,
  };
};
