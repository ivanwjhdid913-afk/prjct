import { useEffect, useState } from 'react';
import './styles.css';

const kinds = { river: 'Река', lake: 'Озеро', reservoir: 'Водохранилище' };
type WaterBody = { id: string; name: string; kind: keyof typeof kinds; is_synthetic: boolean };
type WaterPage = { items: WaterBody[]; total: number; limit: number; offset: number };
type ViewState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: WaterPage };

function isWaterPage(value: unknown): value is WaterPage {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  return Number.isInteger(data.total) && Number(data.total) >= 0
    && Number.isInteger(data.limit) && Number(data.limit) > 0
    && Number.isInteger(data.offset) && Number(data.offset) >= 0
    && Array.isArray(data.items) && data.items.every((item: unknown) => {
      if (!item || typeof item !== 'object') return false;
      const row = item as Record<string, unknown>;
      return typeof row.id === 'string' && typeof row.name === 'string'
        && typeof row.kind === 'string' && Object.hasOwn(kinds, row.kind)
        && typeof row.is_synthetic === 'boolean';
    });
}

export default function App() {
  const [view, setView] = useState<ViewState>({ status: 'loading' });
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const limit = 50;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setView({ status: 'loading' });
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    async function load() {
      try {
        const response = await fetch(`/api/v1/water-bodies?limit=${limit}&offset=${offset}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Request failed');
        const data: unknown = await response.json();
        if (!isWaterPage(data)) throw new Error('Invalid response');
        if (active && offset > 0 && offset >= data.total) {
          setOffset(0);
          return;
        }
        if (active) setView({ status: 'ready', data });
      } catch {
        if (active) setView({ status: 'error' });
      } finally {
        window.clearTimeout(timeout);
      }
    }
    void load();
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [offset, revision]);

  return (
    <>
      <a className="skip-link" href="#content">К списку объектов</a>
      <header className="masthead">
        <div className="brand">
          <svg className="brand-mark" viewBox="0 0 40 40" fill="none" aria-hidden="true">
            <path d="M4 15c6-9 12 9 18 0s12 9 16 0M4 24c6-9 12 9 18 0s12 9 16 0" stroke="currentColor" strokeWidth="2.5" />
          </svg>
          <span>Наблюдения за водой</span>
        </div>
        <span className="edition">Учебный проект</span>
      </header>
      <main id="content" tabIndex={-1}>
        <section className="introduction" aria-labelledby="page-title">
          <p className="eyebrow">Реестр / Водные объекты</p>
          <h1 id="page-title">Водные объекты<span className="title-dot">.</span></h1>
          <p className="lead">Реки, озёра и водохранилища в одном списке.<br className="desktop-break" /> Начальная точка для работы с наблюдениями.</p>
        </section>

        <section className="register" aria-labelledby="list-title" aria-busy={view.status === 'loading'}>
          <div className="register-heading">
            <div><p className="eyebrow">01 / Каталог</p><h2 id="list-title">Список объектов</h2></div>
            <button className="refresh" disabled={view.status === 'loading'} onClick={() => setRevision(revision + 1)}>
              {view.status === 'loading' ? 'Загрузка…' : 'Обновить список'}
            </button>
          </div>

          {view.status === 'loading' && <div className="state" role="status">
            <p>Загружаем водные объекты…</p>
            <div className="skeleton" aria-hidden="true" /><div className="skeleton" aria-hidden="true" /><div className="skeleton" aria-hidden="true" />
          </div>}

          {view.status === 'error' && <div className="state error" role="alert">
            <span className="state-label">Нет соединения</span>
            <h3>Не удалось загрузить список</h3>
            <p>Проверьте, что приложение и база данных запущены, и повторите попытку.</p>
            <button className="primary" onClick={() => setRevision(revision + 1)}>Попробовать снова</button>
          </div>}

          {view.status === 'ready' && <>
            {view.data.items.some((item) => item.is_synthetic) && <aside className="notice">
              <span className="notice-symbol" aria-hidden="true">i</span>
              <div><strong>Учебные примеры</strong><p>Отмеченные записи созданы для демонстрации. Они не описывают реальные водные объекты Липецкой области.</p></div>
            </aside>}
            {view.data.items.length === 0 ? <div className="state" role="status">
              <span className="state-label">Нет записей</span>
              <h3>В списке пока нет объектов</h3>
              <p>Данные появятся здесь после добавления объектов в базу.</p>
            </div> : <ul className="water-list" aria-label="Водные объекты">
              {view.data.items.map((item, index) => <li className="water-row" key={item.id}>
                <span className="row-number" aria-hidden="true">{String(offset + index + 1).padStart(2, '0')}</span>
                <div className="object-name"><h3>{item.name}</h3>
                  {item.is_synthetic && <span className="synthetic">Синтетические данные</span>}
                </div>
                <span className={`kind ${item.kind}`}>{kinds[item.kind]}</span>
              </li>)}
            </ul>}
            <div className="list-footer">
              <span role="status">{view.data.items.length === 0 ? `Всего объектов: ${view.data.total}` : `Показано ${offset + 1}–${offset + view.data.items.length} из ${view.data.total}`}</span>
              {(offset > 0 || offset + limit < view.data.total) && <nav aria-label="Страницы списка">
                <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Назад</button>
                <button disabled={offset + limit >= view.data.total} onClick={() => setOffset(offset + limit)}>Далее</button>
              </nav>}
            </div>
          </>}
        </section>
        <footer className="page-footer"><span>Наблюдения за водой</span><span>Реестр объектов · Локальная версия</span></footer>
      </main>
    </>
  );
}
