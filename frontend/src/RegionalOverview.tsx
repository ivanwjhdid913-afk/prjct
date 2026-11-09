import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Reach } from './multipleSources';
import { kindLabel, loadRegionalOverview, loadRegionalReaches, normalizedName, readiness, safeSourceUrl, type RegionalData, type RegionalFeature, type RegionalKind } from './regionalOverviewData';
import './regionalOverview.css';

type Props = { visible: boolean; currentReachId: string | null; hasResult: boolean; onApplyReach: (reach: Reach) => void; onReturnResult: () => void };
type LayerKey = RegionalKind | 'prepared';
const initialLayers: Record<LayerKey, boolean> = { boundary: true, river: true, lake: true, reservoir: true, prepared: true };
const layerLabels: Record<LayerKey, string> = { boundary: 'Граница области', river: 'Водотоки', lake: 'Озёра', reservoir: 'Водохранилища', prepared: 'Подготовленные участки' };
type MapEntry = { group: L.GeoJSON; kind: LayerKey; featureId: string; reachId?: string };

function geometryStyle(kind: LayerKey, selected: boolean): L.PathOptions {
  if (kind === 'boundary') return { color: '#6a7868', weight: selected ? 3 : 2, dashArray: '7 5', fillColor: '#e4eadf', fillOpacity: .22 };
  if (kind === 'prepared') return { color: selected ? '#873e15' : '#a55420', weight: selected ? 8 : 6, opacity: 1 };
  if (kind === 'river') return { color: selected ? '#214e60' : '#628999', weight: selected ? 5 : 2.5, opacity: .95 };
  return { color: selected ? '#254f68' : '#547f94', weight: selected ? 3 : 1.5, fillColor: '#8aafbd', fillOpacity: selected ? .65 : .38 };
}

function OverviewMap({ data, reaches, visible, selectedId, layers, onSelect, onTileError }: { data: RegionalData; reaches: Reach[]; visible: boolean; selectedId: string; layers: Record<LayerKey, boolean>; onSelect: (id: string, reachId?: string) => void; onTileError: () => void }) {
  const element = useRef<HTMLDivElement>(null), map = useRef<L.Map | null>(null), entries = useRef<MapEntry[]>([]);
  const select = useRef(onSelect), tileError = useRef(onTileError);
  select.current = onSelect; tileError.current = onTileError;
  useEffect(() => {
    if (!element.current) return;
    const instance = L.map(element.current, { zoomControl: false, zoomSnap: .25, scrollWheelZoom: false, preferCanvas: false, zoomAnimation: !matchMedia('(prefers-reduced-motion: reduce)').matches }).setView([52.7, 39.3], 8);
    instance.attributionControl.setPrefix(false);
    L.control.zoom({ zoomInTitle: 'Увеличить масштаб', zoomOutTitle: 'Уменьшить масштаб' }).addTo(instance);
    map.current = instance;
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).on('tileerror', () => tileError.current()).addTo(instance);
    const added: MapEntry[] = [];
    const add = (geometry: RegionalFeature['geometry'] | Reach['geometry'], kind: LayerKey, featureId: string, name: string, reachId?: string) => {
      const geojson: GeoJSON.Feature = { type: 'Feature', properties: {}, geometry };
      const group = L.geoJSON(geojson, {
        style: geometryStyle(kind, false),
        interactive: kind !== 'boundary',
        onEachFeature: (_feature, layer) => {
          if (kind === 'boundary') return;
          layer.on('click', event => { L.DomEvent.stopPropagation(event); select.current(featureId, reachId); });
          const tooltip = document.createElement('span'); tooltip.textContent = name;
          layer.bindTooltip(tooltip, { sticky: true });
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
      added.push({ group, kind, featureId, reachId });
    };
    for (const feature of data.features) add(feature.geometry, feature.properties.kind, feature.properties.id, feature.properties.name);
    for (const reach of reaches) {
      const feature = data.features.find(item => item.properties.kind === 'river' && item.properties.prepared_reach_ids.includes(reach.id));
      if (feature) add(reach.geometry, 'prepared', feature.properties.id, `Подготовленный участок: ${reach.name}`, reach.id);
    }
    entries.current = added;
    const boundary = added.find(entry => entry.kind === 'boundary');
    if (boundary?.group.getBounds().isValid()) instance.fitBounds(boundary.group.getBounds(), { padding: [22, 22], animate: false });
    return () => { entries.current = []; map.current = null; instance.remove(); };
  }, [data, reaches]);
  useEffect(() => {
    const instance = map.current; if (!instance) return;
    for (const entry of entries.current) {
      entry.group.setStyle(geometryStyle(entry.kind, entry.featureId === selectedId));
      if (layers[entry.kind]) entry.group.addTo(instance); else entry.group.removeFrom(instance);
    }
    for (const entry of entries.current.filter(item => item.kind === 'prepared')) if (layers.prepared) entry.group.bringToFront();
  }, [layers, selectedId, data, reaches]);
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
    const entry = entries.current.find(item => item.featureId === selectedId && item.kind !== 'prepared');
    if (visible && instance && entry?.group.getBounds().isValid()) instance.fitBounds(entry.group.getBounds(), { padding: [40, 40], maxZoom: 12, animate: false });
  }, [selectedId, visible]);
  return <div ref={element} data-testid="regional-map" className="regional-map" role="region" aria-label="Карта поверхностных вод Липецкой области. Для выбора с клавиатуры используйте список объектов." />;
}

export default function RegionalOverview({ visible, currentReachId, hasResult, onApplyReach, onReturnResult }: Props) {
  const [data, setData] = useState<RegionalData | null>(null), [reaches, setReaches] = useState<Reach[]>([]);
  const [error, setError] = useState(''), [reachError, setReachError] = useState(''), [loading, setLoading] = useState(false), [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState(''), [selectedId, setSelectedId] = useState(''), [selectedReachId, setSelectedReachId] = useState('');
  const [layers, setLayers] = useState(initialLayers), [tileFailed, setTileFailed] = useState(false);
  const [activated, setActivated] = useState(visible);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (visible) setActivated(true); }, [visible]);
  useEffect(() => { if (visible) heading.current?.focus({ preventScroll: true }); }, [visible]);
  useEffect(() => {
    if (!activated) return;
    let active = true;
    setLoading(true); setError(''); setReachError('');
    const overview = loadRegionalOverview().then(value => { if (active) setData(value); }).catch(() => { if (active) setError('Не удалось открыть сохранённый обзор. Проверьте соединение и повторите загрузку.'); });
    const registry = loadRegionalReaches().then(value => { if (active) setReaches(value); }).catch(() => { if (active) setReachError('Реестр участков недоступен. Объекты можно просматривать; переход к моделированию появится после повторной загрузки.'); });
    void Promise.all([overview, registry]).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [attempt, activated]);
  const features = useMemo(() => data?.features.filter(feature => feature.properties.kind !== 'boundary') ?? [], [data]);
  const listed = useMemo(() => features.filter(feature => normalizedName(feature.properties.name).includes(normalizedName(query))).sort((a, b) => Number(!!b.properties.prepared_reach_ids.length) - Number(!!a.properties.prepared_reach_ids.length) || a.properties.name.localeCompare(b.properties.name, 'ru')), [features, query]);
  const selected = data?.features.find(feature => feature.properties.id === selectedId);
  const available = selected?.properties.kind === 'river' ? reaches.filter(reach => selected.properties.prepared_reach_ids.includes(reach.id)) : [];
  const activeReach = available.find(reach => reach.id === selectedReachId) ?? available[0];
  const source = data?.metadata.sources.find(item => item.id === selected?.properties.source_id);
  function selectObject(id: string, reachId?: string) { setSelectedId(id); setSelectedReachId(reachId ?? ''); }
  return <section data-testid="regional-overview" className="regional-overview" hidden={!visible} inert={!visible} aria-label="Обзор области">
    <header className="regional-heading"><div><p className="regional-kicker">Липецкая область · поверхностные воды</p><h2 ref={heading} tabIndex={-1}>Обзор области</h2></div><button onClick={onReturnResult}>{hasResult ? 'Вернуться к результату' : 'К моделированию'}</button></header>
    <div data-testid="regional-load-status" className="regional-status" role="status" aria-live="polite">
      {loading ? 'Загрузка сохранённой геометрии…' : error || (data ? `${features.length} водных объектов · ${reaches.length} подготовленных участков` : '')}
      {tileFailed && <span>Подложка недоступна. Сохранённые водные объекты и участки доступны.</span>}
      {reachError && <span>{reachError}</span>}
      {(error || reachError) && <button onClick={() => setAttempt(value => value + 1)} disabled={loading}>Повторить загрузку</button>}
    </div>
    <div className="regional-workspace">
      <aside className="regional-sidebar" aria-label="Поиск и паспорт объекта">
        <div className="regional-search"><label htmlFor="regional-search">Найти водный объект</label><input id="regional-search" data-testid="regional-search" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Например, Дон или Матыра" maxLength={200} autoComplete="off" /></div>
        <div className="regional-object-list" aria-label="Водные объекты"><p className="regional-list-count">{query ? `Найдено: ${listed.length}` : 'Водные объекты'}<span>Выбор открывает паспорт</span></p><ul>{listed.map(feature => <li key={feature.properties.id}><button aria-label={`${feature.properties.name} · ${kindLabel[feature.properties.kind]} · ${readiness(feature)}`} aria-pressed={selectedId === feature.properties.id} onClick={() => selectObject(feature.properties.id)}><span>{feature.properties.name}</span><small>{kindLabel[feature.properties.kind]} · <em className={feature.properties.prepared_reach_ids.length ? 'is-prepared' : ''}>{readiness(feature)}</em></small></button></li>)}</ul>{!!data && !listed.length && <p className="regional-no-match">В сохранённом наборе совпадений нет. Попробуйте другое название.</p>}</div>
        {selected ? <article data-testid="regional-object-card" className="regional-object-card" aria-label={`Паспорт: ${selected.properties.name}`}>
          <p className="regional-kicker">Паспорт объекта · {kindLabel[selected.properties.kind]}</p><h3>{selected.properties.name}</h3><p className="regional-readiness">{readiness(selected)}</p>
          <dl><div><dt>Геометрия</dt><dd>{source && <>{safeSourceUrl(source.url) ? <a href={safeSourceUrl(source.url)} target="_blank" rel="noreferrer">{source.name}</a> : source.name}<small>{source.license} · получено {source.obtained_on}</small></>}</dd></div><div><dt>Расчёт</dt><dd>{available.length ? 'Доступен на подготовленных участках' : 'Для объекта не подключён'}</dd></div></dl>
          {selected.properties.limitation && <p className="regional-limitation">{selected.properties.limitation}</p>}
          {selected.properties.kind === 'river' && !available.length && !selected.properties.limitation && <p className="regional-limitation">Для этого объекта в реестре нет подготовленной расчётной линии и проверенного продолжения.</p>}
          {(selected.properties.kind === 'lake' || selected.properties.kind === 'reservoir') && <p className="regional-limitation">Текущий одномерный речной решатель к озёрам и водохранилищам не подключён.</p>}
          {!!available.length && <div className="regional-reach-choice"><label htmlFor="regional-reach">Подготовленный участок</label><select id="regional-reach" value={activeReach?.id ?? ''} onChange={event => setSelectedReachId(event.target.value)}>{available.map(reach => <option key={reach.id} value={reach.id}>{reach.name} · {(reach.length_m / 1000).toLocaleString('ru', { maximumFractionDigits: 2 })} км</option>)}</select>{activeReach?.id === currentReachId && <small>Текущий участок моделирования</small>}<button className="regional-apply" onClick={() => { if (activeReach) onApplyReach(activeReach); }}>К выбранному участку</button><p>Условия демонстрации — сценарные. Переход к другому участку требует проверки переносимых настроек.</p></div>}
          {!!selected.properties.prepared_reach_ids.length && !available.length && <p className="regional-limitation">Подготовленные участки не найдены в загруженном реестре. Переход к расчёту недоступен.</p>}
        </article> : <div className="regional-card-placeholder"><span aria-hidden="true">↗</span><h3>Выберите реку или водоём</h3><p>На карте или в списке. Паспорт покажет источник геометрии и доступность моделирования.</p></div>}
      </aside>
      <div className="regional-map-column">{data ? <OverviewMap data={data} reaches={reaches} visible={visible} selectedId={selectedId} layers={layers} onSelect={selectObject} onTileError={() => setTileFailed(true)} /> : <div data-testid="regional-map" className="regional-map regional-map-empty">{error ? 'Обзорная геометрия недоступна' : 'Подготовка карты…'}</div>}
        <fieldset className="regional-legend"><legend>Слои карты</legend>{(Object.keys(initialLayers) as LayerKey[]).map(key => <label key={key}><input type="checkbox" checked={layers[key]} onChange={event => setLayers(value => ({ ...value, [key]: event.target.checked }))} /><span aria-hidden="true" className={`regional-swatch regional-swatch-${key}`} />{layerLabels[key]}</label>)}</fieldset>
        <p className="regional-map-note">Обзорная гидрография — картографический слой. Расчёт доступен только на выделенных подготовленных участках; соседство линий не подтверждает гидравлическую связь.</p>
      </div>
    </div>
    {data && <footer className="regional-data-note"><p>{data.metadata.coverage_note}</p><details><summary>Происхождение набора и лицензии</summary><p>{data.metadata.name} · получено {data.metadata.obtained_on} · WGS84, [долгота, широта]</p>{data.metadata.sources.map(item => <p key={item.id}>{safeSourceUrl(item.url) ? <a href={safeSourceUrl(item.url)} target="_blank" rel="noreferrer">{item.name}</a> : item.name} · {item.license} · {item.attribution}<br /><small>Контрольная сумма исходника: {item.raw_sha256}</small></p>)}</details></footer>}
  </section>;
}
