import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from './api';
import type { SpaceData } from '@canvas/contracts';
import CanvasPage from './Canvas';

const SPACE_KEY = 'canvas.spaceId';

export default function App() {
  const [spaceId, setSpaceId] = useState<string | null>(() => localStorage.getItem(SPACE_KEY));

  const open = useCallback((id: string) => {
    localStorage.setItem(SPACE_KEY, id);
    setSpaceId(id);
  }, []);

  const leave = useCallback(() => {
    localStorage.removeItem(SPACE_KEY);
    setSpaceId(null);
  }, []);

  return spaceId ? (
    <CanvasPage key={spaceId} spaceId={spaceId} onLeave={leave} />
  ) : (
    <Spaces onOpen={open} />
  );
}

function Spaces({ onOpen }: { onOpen: (id: string) => void }) {
  const [spaces, setSpaces] = useState<SpaceData[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [title, setTitle] = useState('Мой канвас');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api
      .listSpaces()
      .then((result) => setSpaces(result.data))
      .catch((cause: unknown) =>
        setError(
          cause instanceof ApiError ? cause : new ApiError(0, 'UNKNOWN', 'Список недоступен.'),
        ),
      );
  }, []);

  useEffect(load, [load]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.createSpace(title.trim() || 'Мой канвас');
      onOpen(result.data.id);
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause
          : new ApiError(0, 'UNKNOWN', 'Не удалось создать пространство.'),
      );
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <h1>Рабочие пространства</h1>
      <form
        className="screen__form"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <label>
          Название нового пространства
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={80}
            required
          />
        </label>
        <button type="submit" disabled={busy}>
          Создать и открыть
        </button>
      </form>
      {error && (
        <p className="status status--error" role="alert">
          {error.message}{' '}
          <button type="button" onClick={load}>
            Повторить
          </button>
        </p>
      )}
      {spaces === null ? (
        <p role="status">Загрузка…</p>
      ) : spaces.length === 0 ? (
        <p>Пока нет ни одного пространства. Создайте первое выше.</p>
      ) : (
        <ul className="screen__list">
          {spaces.map((space) => (
            <li key={space.id}>
              <button type="button" onClick={() => onOpen(space.id)}>
                {space.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
