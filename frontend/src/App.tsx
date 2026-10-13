import { useEffect, useRef, useState } from 'react';
import './styles.css';

const kinds = { river: 'Река', lake: 'Озеро', reservoir: 'Водохранилище' };
type WaterBody = { id: string; name: string; kind: keyof typeof kinds; is_synthetic: boolean };
type WaterPage = { items: WaterBody[]; total: number; catalog_total: number; limit: number; offset: number };
type Filters = { q: string; kind: string };
type ViewState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: WaterPage };

function isWaterPage(value: unknown): value is WaterPage {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  return Number.isInteger(data.total) && Number(data.total) >= 0
    && Number.isInteger(data.catalog_total) && Number(data.catalog_total) >= Number(data.total)
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
  const [draft, setDraft] = useState<Filters>({ q: '', kind: '' });
  const [filters, setFilters] = useState<Filters>({ q: '', kind: '' });
  const requestId = useRef(0);
  const limit = 50;

  function requestList(nextFilters = filters, nextOffset = offset) {
    // Invalidate synchronously, before the next effect starts its request.
    requestId.current += 1;
    setView({ status: 'loading' });
    setFilters(nextFilters);
    setOffset(nextOffset);
    setRevision((value) => value + 1);
  }

  function resetFilters() {
    const empty = { q: '', kind: '' };
    setDraft(empty);
    requestList(empty, 0);
  }

  useEffect(() => {
    const controller = new AbortController();
    const currentId = ++requestId.current;
    let active = true;
    setView({ status: 'loading' });
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    async function load() {
      try {
        const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
        if (filters.q) params.set('q', filters.q);
        if (filters.kind) params.set('kind', filters.kind);
        const response = await fetch(`/api/v1/water-bodies?${params}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Request failed');
        const data: unknown = await response.json();
        if (!isWaterPage(data)) throw new Error('Invalid response');
        if (!active || currentId !== requestId.current) return;
        if (offset > 0 && offset >= data.total) {
          setOffset(0);
          return;
        }
        setView({ status: 'ready', data });
      } catch {
        if (active && currentId === requestId.current) setView({ status: 'error' });
      } finally {
        window.clearTimeout(timeout);
      }
    }
    void load();
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [offset, revision, filters]);

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
            <button className="refresh" disabled={view.status === 'loading'} onClick={() => requestList()}>
              {view.status === 'loading' ? 'Загрузка…' : 'Обновить список'}
            </button>
          </div>

          <form className="filters" aria-label="Поиск и фильтрация" onSubmit={(event) => {
            event.preventDefault();
            const next = { ...draft, q: draft.q.trim() };
            setDraft(next);
            requestList(next, 0);
          }}>
            <div className="search-field">
              <label htmlFor="name-search">Название объекта</label>
              <input id="name-search" type="search" maxLength={120} value={draft.q}
                onChange={(event) => setDraft({ ...draft, q: event.target.value })}
                aria-describedby="search-help" placeholder="Например, учебное озеро" />
            </div>
            <div className="kind-field">
              <label htmlFor="kind-filter">Тип объекта</label>
              <select id="kind-filter" value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value })}>
                <option value="">Все типы</option><option value="river">Реки</option>
                <option value="lake">Озёра</option><option value="reservoir">Водохранилища</option>
              </select>
            </div>
            <div className="filter-actions">
              <button className="primary" type="submit">Применить</button>
              <button type="button" onClick={resetFilters}>Сбросить условия</button>
            </div>
            <p id="search-help">Часть названия, до 120 символов. Условия применяются по кнопке или Enter.</p>
            {(filters.q || filters.kind) && <p className="applied-filters">Применено: {filters.q ? `«${filters.q}»` : 'любое название'} · {filters.kind ? kinds[filters.kind as keyof typeof kinds] : 'все типы'}</p>}
          </form>

          {view.status === 'loading' && <div className="state" role="status">
            <p>Загружаем водные объекты…</p>
            <div className="skeleton" aria-hidden="true" /><div className="skeleton" aria-hidden="true" /><div className="skeleton" aria-hidden="true" />
          </div>}

          {view.status === 'error' && <div className="state error" role="alert">
            <span className="state-label">Нет соединения</span>
            <h3>Не удалось загрузить список</h3>
            <p>Проверьте, что приложение и база данных запущены, и повторите попытку.</p>
            <button className="primary" onClick={() => requestList()}>Попробовать снова</button>
          </div>}

          {view.status === 'ready' && <>
            {view.data.items.some((item) => item.is_synthetic) && <aside className="notice">
              <span className="notice-symbol" aria-hidden="true">i</span>
              <div><strong>Учебные примеры</strong><p>Отмеченные записи созданы для демонстрации. Они не описывают реальные водные объекты Липецкой области.</p></div>
            </aside>}
            {view.data.items.length === 0 ? <div className="state" role="status">
              <span className="state-label">{view.data.catalog_total === 0 ? 'Нет записей' : 'Результаты поиска'}</span>
              <h3>{view.data.catalog_total === 0 ? 'В списке пока нет объектов' : 'Совпадений не найдено'}</h3>
              <p>{view.data.catalog_total === 0 ? 'Данные появятся здесь после добавления объектов в базу.' : 'Измените название или тип объекта либо сбросьте условия.'}</p>
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
                <button disabled={offset === 0} onClick={() => requestList(filters, Math.max(0, offset - limit))}>Назад</button>
                <button disabled={offset + limit >= view.data.total} onClick={() => requestList(filters, offset + limit)}>Далее</button>
              </nav>}
            </div>
          </>}
        </section>
        <footer className="page-footer"><span>Наблюдения за водой</span><span>Реестр объектов · Локальная версия</span></footer>
      </main>
    </>
  );
}
