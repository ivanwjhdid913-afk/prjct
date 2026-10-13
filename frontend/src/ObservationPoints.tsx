import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

type Body = { id: string; name: string };
type Point = {
  id: string; name: string; water_body_id: string; is_synthetic: boolean; coordinate_source: string;
  geometry: { type: 'Point'; coordinates: [number, number] } | null;
};
type Collection = { water_body: Body; items: Point[]; total: number };
type Detail = Point & { water_body: Body };
type State<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: T };

function isBody(value: unknown): value is Body {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string' && typeof row.name === 'string';
}

function isPoint(value: unknown): value is Point {
  if (!isBody(value)) return false;
  const row = value as unknown as Record<string, unknown>;
  if (typeof row.water_body_id !== 'string' || typeof row.is_synthetic !== 'boolean' || typeof row.coordinate_source !== 'string') return false;
  if (row.geometry === null) return true;
  if (!row.geometry || typeof row.geometry !== 'object') return false;
  const geom = row.geometry as Record<string, unknown>;
  return geom.type === 'Point' && Array.isArray(geom.coordinates) && geom.coordinates.length === 2
    && geom.coordinates.every(value => typeof value === 'number' && Number.isFinite(value))
    && Math.abs(geom.coordinates[0]) <= 180 && Math.abs(geom.coordinates[1]) <= 90;
}

async function readResponse(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(response.status === 404 ? 'Запись не найдена. Вернитесь к каталогу или обновите список.' : 'Не удалось получить данные. Проверьте соединение и повторите запрос.');
  return response.json();
}

function PointMap({ points, selectedId, onSelect }: { points: Point[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markers = useRef(new Map<string, L.Marker>());
  const [tileError, setTileError] = useState(false);
  const [retry, setRetry] = useState(0);
  const mapped = points.filter(point => point.geometry !== null);

  useEffect(() => {
    if (!host.current || !points.some(point => point.geometry)) return;
    setTileError(false);
    const map = L.map(host.current, { scrollWheelZoom: false, zoomAnimation: false, fadeAnimation: false, zoomControl: false });
    mapRef.current = map;
    L.control.zoom({ zoomInTitle: 'Увеличить масштаб', zoomOutTitle: 'Уменьшить масштаб' }).addTo(map);
    const locations: L.LatLngTuple[] = points.flatMap(point => point.geometry ? [[point.geometry.coordinates[1], point.geometry.coordinates[0]]] : []);
    // Establish the view before adding markers so their keyboard elements exist immediately.
    map.fitBounds(locations, { padding: [35, 35], maxZoom: 13, animate: false });
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    // A stalled connection must not leave an apparently blank, unexplained map.
    let timer = window.setTimeout(() => setTileError(true), 10_000);
    tiles.on('loading', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setTileError(true), 10_000);
    });
    tiles.on('load', () => window.clearTimeout(timer));
    tiles.on('tileerror', () => setTileError(true));
    points.forEach((point, index) => {
      if (!point.geometry) return;
      const [longitude, latitude] = point.geometry.coordinates;
      const marker = L.marker([latitude, longitude], {
        icon: L.divIcon({ className: 'point-marker', html: `<span>${index + 1}</span>`, iconSize: [44, 44], iconAnchor: [22, 22] }),
        title: point.name, keyboard: true, riseOnHover: true,
      }).addTo(map).on('click', () => onSelect(point.id));
      const element = marker.getElement();
      if (element) {
        element.setAttribute('aria-label', `Маркер: ${point.name}`);
        element.setAttribute('aria-pressed', 'false');
        element.addEventListener('keydown', event => {
          if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); onSelect(point.id); }
        });
      }
      markers.current.set(point.id, marker);
    });
    const resize = new ResizeObserver(() => map.invalidateSize());
    resize.observe(host.current);
    return () => {
      window.clearTimeout(timer);
      resize.disconnect();
      markers.current.clear();
      mapRef.current = null;
      map.remove();
    };
  }, [points, onSelect, retry]);

  useEffect(() => {
    markers.current.forEach((marker, id) => {
      const selected = id === selectedId;
      marker.getElement()?.classList.toggle('selected', selected);
      marker.getElement()?.setAttribute('aria-pressed', String(selected));
      marker.setZIndexOffset(selected ? 1000 : 0);
      if (selected) mapRef.current?.panTo(marker.getLatLng(), { animate: false });
    });
  }, [selectedId, points, retry]);

  return <section className="map-panel" aria-label="Карта точек наблюдения">
    {mapped.length ? <div ref={host} className="point-map" aria-label="Интерактивная карта. Точки также доступны в списке." />
      : <div className="map-empty"><strong>Нет точек с координатами</strong><p>Карта появится, когда у точек будет задано положение. Список и сведения доступны ниже.</p></div>}
    {tileError && <div className="map-warning" role="status"><strong>Подложка карты недоступна</strong><p>Маркерные обозначения, список и сведения о точках продолжают работать.</p><button onClick={() => setRetry(value => value + 1)}>Повторить загрузку подложки</button></div>}
    <p className="map-caption">На карте: {mapped.length}. Номера соответствуют списку. Выделение означает выбор точки, а не оценку качества воды.</p>
  </section>;
}

export default function ObservationPoints({ waterBodyId, onBack }: { waterBodyId: string; onBack: () => void }) {
  const [collection, setCollection] = useState<State<Collection>>({ status: 'loading' });
  const [detail, setDetail] = useState<State<Detail>>({ status: 'loading' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [detailRevision, setDetailRevision] = useState(0);
  const selectionVersion = useRef(0);
  const title = useRef<HTMLHeadingElement>(null);
  const selectPoint = useCallback((id: string) => {
    selectionVersion.current++;
    setDetail({ status: 'loading' });
    setSelectedId(id);
    setDetailRevision(value => value + 1);
  }, []);

  useEffect(() => { title.current?.focus(); }, [waterBodyId]);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 10_000);
    setCollection({ status: 'loading' });
    setSelectedId(null);
    selectionVersion.current++;
    void fetch(`/api/v1/water-bodies/${encodeURIComponent(waterBodyId)}/observation-points`, { signal: controller.signal })
      .then(readResponse).then(value => {
        const data = value as Collection;
        if (!data || !isBody(data.water_body) || data.water_body.id !== waterBodyId || !Array.isArray(data.items)
          || !data.items.every(point => isPoint(point) && point.water_body_id === waterBodyId)
          || !Number.isInteger(data.total) || data.total !== data.items.length) throw new Error('Получен неполный или некорректный список точек. Повторите запрос.');
        if (active) setCollection({ status: 'ready', data });
      }).catch(error => {
        if (active) setCollection({ status: 'error', message: error instanceof Error && error.name !== 'AbortError' ? error.message : 'Сервер не ответил вовремя. Повторите запрос.' });
      }).finally(() => window.clearTimeout(timer));
    return () => { active = false; controller.abort(); window.clearTimeout(timer); };
  }, [waterBodyId, revision]);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    const version = selectionVersion.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 10_000);
    void fetch(`/api/v1/observation-points/${encodeURIComponent(selectedId)}`, { signal: controller.signal })
      .then(readResponse).then(value => {
        const data = value as Detail;
        if (!isPoint(data) || data.id !== selectedId || !isBody(data.water_body)
          || data.water_body_id !== waterBodyId || data.water_body.id !== waterBodyId) throw new Error('Получены некорректные сведения о точке. Повторите запрос.');
        if (active && version === selectionVersion.current) setDetail({ status: 'ready', data });
      }).catch(error => {
        if (active && version === selectionVersion.current) setDetail({ status: 'error', message: error instanceof Error && error.name !== 'AbortError' ? error.message : 'Сервер не ответил вовремя. Повторите запрос.' });
      }).finally(() => window.clearTimeout(timer));
    return () => { active = false; controller.abort(); window.clearTimeout(timer); };
  }, [selectedId, waterBodyId, detailRevision]);

  return <div className="observations">
    <button className="back-link" onClick={onBack}>Вернуться к каталогу</button>
    <div className="observation-heading"><div><p className="eyebrow">Водный объект / Наблюдения</p><h1 ref={title} tabIndex={-1}>Точки наблюдения</h1>
      {collection.status === 'ready' && <p className="lead">{collection.data.water_body.name}</p>}</div>
      <button disabled={collection.status === 'loading'} onClick={() => { selectionVersion.current++; setCollection({ status: 'loading' }); setRevision(value => value + 1); }}>Обновить точки</button></div>
    {collection.status === 'loading' && <div className="state" role="status">Загружаем точки наблюдения…</div>}
    {collection.status === 'error' && <div className="state error" role="alert"><h2>Не удалось загрузить точки</h2><p>{collection.message}</p><button onClick={() => setRevision(value => value + 1)}>Повторить запрос точек</button></div>}
    {collection.status === 'ready' && <>
      {collection.data.items.some(point => point.is_synthetic) && <aside className="point-notice"><strong>Синтетические точки и вымышленные координаты</strong><p>Демонстрационные точки не являются реальными станциями. Их положение на реальных водных объектах не подтверждено.</p></aside>}
      <PointMap points={collection.data.items} selectedId={selectedId} onSelect={selectPoint} />
      <div className="point-workspace"><section aria-labelledby="points-list-title" className="points-panel">
        <h2 id="points-list-title">Список точек</h2>
        <p className="point-count" role="status">Всего точек: {collection.data.total} · Без координат: {collection.data.items.filter(point => !point.geometry).length}</p>
        {collection.data.items.length === 0 ? <p>У этого объекта пока нет точек наблюдения.</p> : <ol className="points-list">
          {collection.data.items.map((point, index) => <li key={point.id}>
            <button aria-label={`Выбрать точку: ${point.name}`} aria-pressed={selectedId === point.id} onClick={() => selectPoint(point.id)}>
              <span className="point-number">{index + 1}</span><span><strong>{point.name}</strong><span className="point-meta">{point.geometry ? 'Есть координаты' : 'Без координат — не показана на карте'}</span>
                {point.is_synthetic && <span className="synthetic">Синтетические данные</span>}{selectedId === point.id && <span className="point-meta">Выбрана</span>}</span>
            </button></li>)}
        </ol>}
      </section><section className="point-detail" aria-label="Сведения о точке" aria-live="polite" aria-busy={Boolean(selectedId && detail.status === 'loading')}>
        <p className="eyebrow">Карточка наблюдения</p><h2>Сведения о точке</h2>
        {!selectedId ? <p>Выберите точку в списке или на карте.</p> : detail.status === 'loading' ? <p role="status">Загружаем сведения…</p>
          : detail.status === 'error' ? <div role="alert"><p>{detail.message}</p><button onClick={() => selectPoint(selectedId)}>Повторить запрос сведений</button></div>
            : <><h3>{detail.data.name}</h3><dl>
              <dt>Водный объект</dt><dd>{detail.data.water_body.name}</dd>
              <dt>Происхождение</dt><dd>{detail.data.is_synthetic ? 'Синтетические данные' : 'Данные источника'}</dd>
              <dt>Положение · WGS 84 (EPSG:4326)</dt><dd>{detail.data.geometry ? <><span className="coordinate">Долгота: {detail.data.geometry.coordinates[0]}°</span><span className="coordinate">Широта: {detail.data.geometry.coordinates[1]}°</span></> : 'Координаты не заданы'}</dd>
              <dt>Источник координат</dt><dd>{detail.data.coordinate_source}</dd>
            </dl></>}
      </section></div>
    </>}
  </div>;
}
