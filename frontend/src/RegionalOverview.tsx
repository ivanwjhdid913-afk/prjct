import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Reach, RestorableConditions } from './multipleSources';
import { dischargeDemo } from './inputProvenance';
import { isWatercourse, kindLabel, loadRegionalOverview, loadRegionalReaches, normalizedName, positionLabel, readiness, safeSourceUrl, waterKinds, type RegionalData, type RegionalFeature, type RegionalKind, type WaterKind } from './regionalOverviewData';
import './regionalOverview.css';

type Props = { visible: boolean; currentReachId: string | null; hasResult: boolean; onApplyReach: (reach: Reach) => void; onReturnResult: () => void; onOpenDemo?: (scenario: RestorableConditions) => void };
type LayerKey = RegionalKind | 'prepared';
const initialLayers: Record<LayerKey, boolean> = { boundary: true, river: true, stream: true, lake: true, pond: true, reservoir: true, water: true, prepared: true };
const layerLabels: Record<LayerKey, string> = { boundary: 'Граница области', river: 'Реки', stream: 'Ручьи', lake: 'Озёра', pond: 'Пруды', reservoir: 'Водохранилища', water: 'Без уточнения', prepared: 'Подготовленные участки' };
type MapEntry = { group: L.GeoJSON; kind: LayerKey; featureId: string; reachId?: string };
const PAGE_SIZE = 36;

function geometryStyle(kind: LayerKey, selected: boolean): L.PathOptions {
  if (kind === 'boundary') return { color: '#6a7868', weight: selected ? 3 : 2, dashArray: '7 5', fillColor: '#e4eadf', fillOpacity: .22 };
  if (kind === 'prepared') return { color: selected ? '#873e15' : '#a55420', weight: selected ? 8 : 6, opacity: 1 };
  if (isWatercourse(kind)) return { color: selected ? '#163c54' : kind === 'river' ? '#43869d' : '#82aabb', weight: selected ? 5 : kind === 'river' ? 2.5 : 1.2, opacity: .9 };
  return { color: selected ? '#173f5c' : '#547f94', weight: selected ? 3 : 1, fillColor: selected ? '#5c94b2' : '#89b9cc', fillOpacity: selected ? .78 : .48 };
}

function OverviewMap({ data, reaches, visible, selectedId, selectedReachId, layers, reset, onSelect, onTileError }: { data: RegionalData; reaches: Reach[]; visible: boolean; selectedId: string; selectedReachId: string; layers: Record<LayerKey, boolean>; reset: number; onSelect: (id: string, reachId?: string) => void; onTileError: () => void }) {
  const element = useRef<HTMLDivElement>(null), map = useRef<L.Map | null>(null), entries = useRef<MapEntry[]>([]);
  const byFeature = useRef(new Map<string, MapEntry[]>());
  const previousSelection = useRef('');
  const boundary = useRef<L.LatLngBounds | undefined>(undefined);
  const select = useRef(onSelect), tileError = useRef(onTileError);
  select.current = onSelect; tileError.current = onTileError;
  useEffect(() => {
    if (!element.current) return;
    const instance = L.map(element.current, { zoomControl: false, zoomSnap: .25, scrollWheelZoom: false, preferCanvas: false, zoomAnimation: !matchMedia('(prefers-reduced-motion: reduce)').matches }).setView([52.7, 39.3], 8);
    instance.attributionControl.setPrefix(false);
    L.control.zoom({ zoomInTitle: 'Увеличить масштаб', zoomOutTitle: 'Уменьшить масштаб' }).addTo(instance);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(instance);
    map.current = instance;
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).on('tileerror', () => tileError.current()).addTo(instance);
    const hydroPane = instance.createPane('regional-hydro');
    hydroPane.style.zIndex = '410';
    const preparedPane = instance.createPane('regional-prepared');
    preparedPane.style.zIndex = '420';
    // At regional scale a shared Canvas avoids thousands of SVG paths.
    const renderer = data.features.length > 300 ? L.canvas({ pane: 'regional-hydro', tolerance: 2 }) : undefined;
    const added: MapEntry[] = [];
    const add = (geometry: RegionalFeature['geometry'] | Reach['geometry'], kind: LayerKey, featureId: string, name: string, reachId?: string) => {
      const geojson: GeoJSON.Feature = { type: 'Feature', properties: {}, geometry };
      const group = L.geoJSON(geojson, {
        style: { ...geometryStyle(kind, false), pane: kind === 'prepared' ? 'regional-prepared' : kind === 'boundary' ? 'overlayPane' : 'regional-hydro',
          renderer: kind !== 'boundary' && kind !== 'prepared' ? renderer : undefined },
        interactive: kind !== 'boundary',
        onEachFeature: (_feature, layer) => {
          if (kind === 'boundary') return;
          layer.on('click', event => { L.DomEvent.stopPropagation(event); select.current(featureId, reachId); });
          layer.bindTooltip(() => { const tooltip = document.createElement('span'); tooltip.textContent = name; return tooltip; }, { sticky: true });
        },
      }).addTo(instance);
      group.eachLayer(layer => {
        const path = (layer as L.Path).getElement();
        if (!path) return;
        path.setAttribute('data-regional-feature', featureId);
        if (reachId) path.setAttribute('data-regional-reach', reachId);
        path.setAttribute('tabindex', '-1');
        path.setAttribute('aria-label', name);
        // The adjacent native-button list offers the full equivalent keyboard route.
      });
      const entry = { group, kind, featureId, reachId };
      added.push(entry);
      const existing = byFeature.current.get(featureId);
      if (existing) existing.push(entry); else byFeature.current.set(featureId, [entry]);
    };
    for (const feature of data.features) add(feature.geometry, feature.properties.kind, feature.properties.id, feature.properties.name);
    for (const reach of reaches) {
      const feature = data.features.find(item => item.properties.kind === 'river' && item.properties.prepared_reach_ids.includes(reach.id));
      if (feature) add(reach.geometry, 'prepared', feature.properties.id, `Подготовленный участок: ${reach.name}`, reach.id);
    }
    entries.current = added;
    boundary.current = added.find(entry => entry.kind === 'boundary')?.group.getBounds();
    if (boundary.current?.isValid()) instance.fitBounds(boundary.current, { padding: [22, 22], animate: false });
    return () => { entries.current = []; byFeature.current.clear(); previousSelection.current = ''; map.current = null; instance.remove(); };
  }, [data, reaches]);
  useEffect(() => {
    const instance = map.current; if (!instance) return;
    for (const entry of entries.current) {
      if (layers[entry.kind]) entry.group.addTo(instance); else entry.group.removeFrom(instance);
    }
  }, [layers, data, reaches]);
  useEffect(() => {
    for (const entry of byFeature.current.get(previousSelection.current) ?? []) entry.group.setStyle(geometryStyle(entry.kind, false));
    for (const entry of byFeature.current.get(selectedId) ?? []) entry.group.setStyle(geometryStyle(entry.kind, true)).bringToFront();
    previousSelection.current = selectedId;
  }, [selectedId, data, reaches]);
  useEffect(() => {
    if (!visible || !map.current) return;
    const instance = map.current;
    const timer = window.setTimeout(() => instance.invalidateSize({ pan: false }), 0);
    const observer = new ResizeObserver(() => instance.invalidateSize({ pan: false }));
    if (element.current) observer.observe(element.current);
    return () => { clearTimeout(timer); observer.disconnect(); };
  }, [visible, data]);
  useEffect(() => {
    const instance = map.current;
    const selected = byFeature.current.get(selectedId);
    const entry = selected?.find(item => selectedReachId ? item.reachId === selectedReachId : item.kind !== 'prepared');
    if (visible && instance && entry?.group.getBounds().isValid()) instance.fitBounds(entry.group.getBounds(), { padding: [40, 40], maxZoom: 12, animate: false });
  }, [selectedId, selectedReachId, visible, data, reaches]);
  useEffect(() => {
    if (reset && boundary.current?.isValid()) map.current?.fitBounds(boundary.current, { padding: [22, 22], animate: false });
  }, [reset]);
  return <div ref={element} data-testid="regional-map" data-selected-feature={selectedId} className="regional-map" role="region" aria-label="Карта поверхностных вод Липецкой области. Для выбора с клавиатуры используйте список объектов." />;
}

export default function RegionalOverview({ visible, currentReachId, hasResult, onApplyReach, onReturnResult, onOpenDemo }: Props) {
  const [data, setData] = useState<RegionalData | null>(null), [reaches, setReaches] = useState<Reach[]>([]);
  const [error, setError] = useState(''), [reachError, setReachError] = useState(''), [loading, setLoading] = useState(false), [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState(''), [selectedId, setSelectedId] = useState(''), [selectedReachId, setSelectedReachId] = useState('');
  const [type, setType] = useState<WaterKind | ''>(''), [page, setPage] = useState(0), [reset, setReset] = useState(0);
  const [layers, setLayers] = useState(initialLayers), [tileFailed, setTileFailed] = useState(false);
  const [activated, setActivated] = useState(visible);
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => { list.current?.scrollTo({ top: 0 }); }, [query, type, page]);
  useEffect(() => { if (visible) setActivated(true); }, [visible]);
  useLayoutEffect(() => { if (visible) heading.current?.focus({ preventScroll: true }); }, [visible]);
  useEffect(() => {
    if (!activated) return;
    let active = true;
    setLoading(true); setError(''); setReachError('');
    const overview = loadRegionalOverview().then(value => { if (active) setData(value); }).catch(() => { if (active) setError('Не удалось открыть сохранённый обзор. Проверьте соединение и повторите загрузку.'); });
    const registry = loadRegionalReaches().then(value => { if (active) setReaches(value); }).catch(() => { if (active) setReachError('Реестр участков недоступен. Объекты можно просматривать; переход к моделированию появится после повторной загрузки.'); });
    void Promise.all([overview, registry]).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [attempt, activated]);
  const rows = useMemo(() => {
    const collator = new Intl.Collator('ru');
    return (data?.features.filter(feature => feature.properties.kind !== 'boundary') ?? []).map(feature => ({
      feature, name: normalizedName(feature.properties.name),
    })).sort((a, b) => Number(!!b.feature.properties.prepared_reach_ids.length) - Number(!!a.feature.properties.prepared_reach_ids.length)
      || Number(a.feature.properties.named === false) - Number(b.feature.properties.named === false)
      || collator.compare(a.feature.properties.name, b.feature.properties.name));
  }, [data]);
  const homonyms = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { name, feature } of rows) {
      if (feature.properties.named === false) continue;
      const key = `${feature.properties.kind}:${name}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [rows]);
  const counts = useMemo(() => {
    const totals = new Map<RegionalKind, number>();
    for (const { feature } of rows) totals.set(feature.properties.kind, (totals.get(feature.properties.kind) ?? 0) + 1);
    return totals;
  }, [rows]);
  const listed = useMemo(() => {
    const search = normalizedName(query);
    return rows.filter(({ feature, name }) => (!type || feature.properties.kind === type)
      && (!search || (feature.properties.named !== false && name.includes(search))));
  }, [rows, type, query]);
  const shownLayers = useMemo(() => !type ? layers : {
    ...layers, ...Object.fromEntries(waterKinds.map(kind => [kind, kind === type && layers[kind]])),
    prepared: type === 'river' && layers.prepared,
  }, [layers, type]);
  const selected = data?.features.find(feature => feature.properties.id === selectedId);
  const available = selected?.properties.kind === 'river' ? reaches.filter(reach => selected.properties.prepared_reach_ids.includes(reach.id)) : [];
  const activeReach = available.find(reach => reach.id === selectedReachId) ?? available[0];
  const source = data?.metadata.sources.find(item => item.id === selected?.properties.source_id);
  const demo = useMemo(() => {
    if (!onOpenDemo || activeReach?.id !== 'don-olkhovets') return;
    try { return dischargeDemo(reaches); } catch { return undefined; }
  }, [onOpenDemo, activeReach?.id, reaches]);
  const direction = typeof activeReach?.metadata.direction_basis === 'string' ? activeReach.metadata.direction_basis : '';
  function selectObject(id: string, reachId?: string) { setSelectedId(id); setSelectedReachId(reachId ?? ''); }
  return <section data-testid="regional-overview" className="regional-overview" hidden={!visible} inert={!visible} aria-label="Обзор области">
    <header className="regional-heading"><div><p className="regional-kicker">Липецкая область · поверхностные воды</p><h2 ref={heading} tabIndex={-1}>Обзор области</h2></div><button onClick={onReturnResult}>{hasResult ? 'Вернуться к результату' : 'К моделированию'}</button></header>
    <div data-testid="regional-load-status" className="regional-status" role="status" aria-live="polite">
      {loading ? 'Загрузка сохранённой геометрии…' : error || (data ? `Водные объекты — ${rows.length} · Подготовленные участки — ${reaches.length}` : '')}
      {tileFailed && <span>Подложка недоступна. Сохранённые водные объекты и участки доступны.</span>}
      {reachError && <span>{reachError}</span>}
      {(error || reachError) && <button onClick={() => setAttempt(value => value + 1)} disabled={loading}>Повторить загрузку</button>}
    </div>
    <div className="regional-workspace">
      <aside className="regional-sidebar" aria-label="Поиск и паспорт объекта">
        <div className="regional-search">
          <label htmlFor="regional-type">Тип водного объекта</label><select id="regional-type" value={type} onChange={event => {
            const next = event.target.value as WaterKind | ''; setType(next); setPage(0);
            if (next && selected?.properties.kind !== next) selectObject('');
          }}><option value="">Все типы</option>{waterKinds.map(kind => <option key={kind} value={kind}>{layerLabels[kind]}</option>)}</select>
          <label htmlFor="regional-search">Найти водный объект</label><input id="regional-search" data-testid="regional-search" type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder="Например, Дон или Каменка" maxLength={200} autoComplete="off" />
        </div>
        <div className="regional-object-list" aria-label="Водные объекты"><p className="regional-list-count">{query || type ? `Найдено: ${listed.length}` : 'Водные объекты'}</p><ul ref={list}>{listed.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(({ feature, name }) => {
          const { id, kind } = feature.properties;
          const context = (homonyms.get(`${kind}:${name}`) ?? 0) > 1 ? positionLabel(feature) : '';
          return <li key={id}><button aria-label={[feature.properties.name, kindLabel[kind], readiness(feature), context].filter(Boolean).join(' · ')} aria-pressed={selectedId === id} onClick={() => selectObject(id)}><span>{feature.properties.name}</span><small>{kindLabel[kind]} · <em className={feature.properties.prepared_reach_ids.length ? 'is-prepared' : ''}>{readiness(feature)}</em></small>{context && <small>{context}</small>}</button></li>;
        })}</ul>{listed.length > PAGE_SIZE && <nav className="regional-pages" aria-label="Страницы результатов"><button type="button" aria-label="Предыдущая страница" disabled={!page} onClick={() => setPage(value => value - 1)}>←</button><span>{page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, listed.length)} из {listed.length}</span><button type="button" aria-label="Следующая страница" disabled={(page + 1) * PAGE_SIZE >= listed.length} onClick={() => setPage(value => value + 1)}>→</button></nav>}{!!data && !listed.length && <p className="regional-no-match">Совпадений нет. Измените название или тип.</p>}</div>
        {selected ? <article data-testid="regional-object-card" className="regional-object-card" aria-label={`Паспорт: ${selected.properties.name}`}>
          <p className="regional-kicker">Паспорт объекта · {kindLabel[selected.properties.kind]}</p><h3>{selected.properties.name}</h3><p className="regional-readiness">{readiness(selected)}</p>
          <dl><div><dt>Геометрия</dt><dd>{source && <>{safeSourceUrl(source.url) ? <a href={safeSourceUrl(source.url)} target="_blank" rel="noreferrer">{source.name}</a> : source.name}<small>{source.license} · получено {source.obtained_on}</small></>}</dd></div><div><dt>Положение на карте</dt><dd>{positionLabel(selected)}</dd></div><div><dt>Расчёт</dt><dd>{available.length ? 'Доступен на подготовленных участках' : 'Для объекта не подключён'}</dd></div>{isWatercourse(selected.properties.kind) && <div><dt>Направление течения</dt><dd>{direction ? <><strong>Установлено для выбранного расчётного участка</strong><small>{direction}</small></> : 'Не проверено для расчёта'}</dd></div>}</dl>
          {selected.properties.limitation && <p className="regional-limitation">{selected.properties.limitation}</p>}
          {selected.properties.kind === 'river' && !available.length && !selected.properties.limitation && <p className="regional-limitation">Для этого объекта в реестре нет подготовленной расчётной линии и проверенного продолжения.</p>}
          {!isWatercourse(selected.properties.kind) && <p className="regional-limitation">Текущий одномерный речной решатель к этому водоёму не подключён.</p>}
          {!!available.length && <div className="regional-reach-choice"><label htmlFor="regional-reach">Подготовленный участок</label><select id="regional-reach" value={activeReach?.id ?? ''} onChange={event => setSelectedReachId(event.target.value)}>{available.map(reach => <option key={reach.id} value={reach.id}>{reach.name} · {(reach.length_m / 1000).toLocaleString('ru', { maximumFractionDigits: 2 })} км</option>)}</select>{activeReach?.id === currentReachId && <small>Текущий участок моделирования</small>}<button className="regional-apply" onClick={() => { if (activeReach) onApplyReach(activeReach); }}>К выбранному участку</button>{demo && <button type="button" onClick={() => onOpenDemo?.(demo)}>Учебный расчёт на Дону</button>}</div>}
          {!!selected.properties.prepared_reach_ids.length && !available.length && <p className="regional-limitation">Подготовленные участки не найдены в загруженном реестре. Переход к расчёту недоступен.</p>}
        </article> : <div className="regional-card-placeholder"><span aria-hidden="true">↗</span><h3>Выберите реку или водоём</h3><p>На карте или в списке. Паспорт покажет источник геометрии и доступность моделирования.</p></div>}
      </aside>
      <div className="regional-map-column"><div className="regional-map-toolbar"><span>Гидрография области</span><button type="button" disabled={!data} onClick={() => setReset(value => value + 1)}>Вся область</button></div>{data ? <OverviewMap data={data} reaches={reaches} visible={visible} selectedId={selectedId} selectedReachId={selectedReachId} reset={reset} layers={shownLayers} onSelect={selectObject} onTileError={() => setTileFailed(true)} /> : <div data-testid="regional-map" className="regional-map regional-map-empty">{error ? 'Обзорная геометрия недоступна' : 'Подготовка карты…'}</div>}
        <fieldset className="regional-legend"><legend>Слои карты</legend>{(Object.keys(initialLayers) as LayerKey[]).map(key => <label key={key}><input type="checkbox" checked={layers[key]} onChange={event => setLayers(value => ({ ...value, [key]: event.target.checked }))} /><span aria-hidden="true" className={`regional-swatch regional-swatch-${key}`} />{layerLabels[key]}</label>)}</fieldset>
        <p className="regional-map-note">Обзорная гидрография — картографический слой. Расчёт доступен только на выделенных подготовленных участках; соседство линий не подтверждает гидравлическую связь.</p>
      </div>
    </div>
    {data && <footer className="regional-data-note"><p>{data.metadata.coverage_note}</p><details><summary>Покрытие, источник и лицензия</summary><p>{waterKinds.map(kind => `${layerLabels[kind]} — ${counts.get(kind) ?? 0}`).join(' · ')}</p><p>{data.metadata.name} · получено {data.metadata.obtained_on} · WGS84, [долгота, широта]</p>{data.metadata.sources.map(item => <p key={item.id}>{safeSourceUrl(item.url) ? <a href={safeSourceUrl(item.url)} target="_blank" rel="noreferrer">{item.name}</a> : item.name} · {item.license} · {item.attribution}<br /><small>Контрольная сумма исходника: {item.raw_sha256}</small></p>)}</details></footer>}
  </section>;
}
