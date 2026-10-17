import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './simulation.css';

const fields = [
  { key: 'river_flow_m3_s', label: 'Расход реки Qr, м³/с', initial: 10, min: .1, max: 1000, help: 'Поток воды выше условного источника.' },
  { key: 'effluent_flow_m3_s', label: 'Расход стоков q, м³/с', initial: .1, min: 0, max: 100, help: 'Постоянный расход после начала сценария; 0 — без источника.' },
  { key: 'background_mg_l', label: 'Фоновая концентрация cb, мг/л', initial: 10, min: 0, max: 10000, help: 'Изначально одинакова на всём участке.' },
  { key: 'effluent_mg_l', label: 'Концентрация стоков ce, мг/л', initial: 100, min: 0, max: 10000, help: 'Хлориды в условном выпуске. Это не измерение предприятия.' },
  { key: 'velocity_m_s', label: 'Скорость течения u, м/с', initial: .25, min: .02, max: 2, help: 'Постоянная средняя скорость вдоль линии.' },
  { key: 'dispersion_m2_s', label: 'Продольная дисперсия D, м²/с', initial: 5, min: .1, max: 100, help: 'Перемешивание вдоль потока; поперечное смешение уже завершено.' },
  { key: 'length_m', label: 'Длина участка L, м', initial: 10000, min: 100, max: 20000, help: 'Длина отображаемой линии, без выходного буфера.' },
  { key: 'duration_hours', label: 'Длительность, ч', initial: 24, min: .1, max: 48, help: 'Время от включения постоянного сброса.' },
] as const;
type Key = typeof fields[number]['key'];
type Inputs = Record<Key, number>;
type Draft = Record<Key, string>;
type Line = { type: 'LineString'; coordinates: [number, number][] };
type Reach = { id: string; name: string; length_m: number; geometry: Line; distances_m: number[]; metadata: Record<string, unknown> };
type Result = {
  inputs: Inputs;
  reach_id?: string | null; source_distance_m?: number; source_coordinate?: [number, number] | null;
  reach_metadata?: Record<string, unknown> | null; segment_geometries?: Line[] | null;
  derived: { total_flow_m3_s: number; area_m2: number; load_kg_s: number; excess_load_kg_s: number; steady_mg_l: number; travel_hours: number };
  distances_m: number[]; times_hours: number[]; concentrations_mg_l: number[][];
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  scale_mg_l: [number, number];
};
const initialDraft = Object.fromEntries(fields.map(field => [field.key, String(field.initial)])) as Draft;
const format = (value: number, digits = 2) => value.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const coordinate = (point: unknown): point is [number, number] => Array.isArray(point) && point.length === 2 && point.every(finite) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90;
function validLine(value: unknown): value is Line {
  return record(value) && value.type === 'LineString' && Array.isArray(value.coordinates) && value.coordinates.length >= 2 && value.coordinates.length <= 10000 && value.coordinates.every(coordinate);
}
function validReach(value: unknown): value is Reach {
  if (!record(value) || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || !value.name || !record(value.metadata) || !validLine(value.geometry)) return false;
  const distances = value.distances_m;
  return finite(value.length_m) && value.length_m >= 100 && value.length_m <= 20000
    && Array.isArray(distances) && distances.length === value.geometry.coordinates.length
    && distances[0] === 0 && distances.every((distance, index) => finite(distance) && (index === 0 || distance > distances[index - 1]))
    && Math.abs(distances[distances.length - 1] - value.length_m) <= 1e-6;
}

function validResult(value: unknown): value is Result {
  if (!value || typeof value !== 'object') return false;
  const row = value as Result;
  return !!row.inputs && fields.every(field => finite(row.inputs[field.key]))
    && !!row.derived && ['total_flow_m3_s', 'area_m2', 'load_kg_s', 'excess_load_kg_s', 'steady_mg_l', 'travel_hours'].every(key => finite(row.derived[key as keyof Result['derived']]))
    && Array.isArray(row.distances_m) && row.distances_m.length > 0 && row.distances_m.length <= 200 && row.distances_m.every(finite)
    && Array.isArray(row.times_hours) && row.times_hours.length > 0 && row.times_hours.length <= 100 && row.times_hours.every(finite)
    && Array.isArray(row.concentrations_mg_l) && row.concentrations_mg_l.length === row.times_hours.length
    && row.concentrations_mg_l.every(values => Array.isArray(values) && values.length === row.distances_m.length && values.every(finite))
    && validLine(row.geometry)
    && (row.reach_id == null ? row.geometry.coordinates.length === row.distances_m.length + 1
      : typeof row.reach_id === 'string' && !!row.reach_id && record(row.reach_metadata) && coordinate(row.source_coordinate)
        && finite(row.source_distance_m) && row.source_distance_m >= 0
        && Array.isArray(row.segment_geometries) && row.segment_geometries.length === row.distances_m.length && row.segment_geometries.every(validLine))
    && Array.isArray(row.scale_mg_l) && row.scale_mg_l.length === 2 && row.scale_mg_l.every(finite) && row.scale_mg_l[0] <= row.scale_mg_l[1];
}

function color(value: number, scale: [number, number]) {
  const share = scale[1] === scale[0] ? .5 : Math.max(0, Math.min(1, (value - scale[0]) / (scale[1] - scale[0])));
  const palette = [[36, 101, 180], [22, 166, 176], [225, 212, 90], [239, 138, 52], [185, 31, 82]];
  const position = share * (palette.length - 1), index = Math.min(palette.length - 2, Math.floor(position));
  return `rgb(${palette[index].map((channel, axis) => Math.round(channel + (palette[index + 1][axis] - channel) * (position - index))).join(', ')})`;
}

function mapPadding(): L.FitBoundsOptions {
  if (window.matchMedia('(max-width: 760px) and (max-height: 740px)').matches)
    return { paddingTopLeft: [45, 70], paddingBottomRight: [45, 160], animate: false };
  return window.matchMedia('(max-width: 760px)').matches
    ? { paddingTopLeft: [45, 90], paddingBottomRight: [45, 210], animate: false }
    : { paddingTopLeft: [65, 105], paddingBottomRight: [265, 65], animate: false };
}

function CalculationMap({ result, values, selected, onSelect, suspended }: { result: Result; values: number[]; selected: number; onSelect: (index: number) => void; suspended: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const segments = useRef<L.Polyline[]>([]);
  const [tileError, setTileError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!host.current) return;
    setTileError(false);
    const map = L.map(host.current, { scrollWheelZoom: false, zoomAnimation: false, fadeAnimation: false, zoomControl: false, zoomSnap: .25 });
    map.attributionControl.setPrefix(false);
    L.control.zoom({ zoomInTitle: 'Увеличить масштаб', zoomOutTitle: 'Уменьшить масштаб' }).addTo(map);
    const points: L.LatLngTuple[] = result.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    map.fitBounds(points, mapPadding());
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
    let timer = window.setTimeout(() => setTileError(true), 10_000);
    tiles.on('loading', () => { window.clearTimeout(timer); timer = window.setTimeout(() => setTileError(true), 10_000); });
    tiles.on('load', () => window.clearTimeout(timer));
    tiles.on('tileerror', () => setTileError(true));
    L.polyline(points, { color: '#fff', weight: 16, opacity: .98, interactive: false, smoothFactor: 0 }).addTo(map);
    L.polyline(points, { color: '#183e50', weight: 12, opacity: .65, interactive: false, smoothFactor: 0 }).addTo(map);
    segments.current = result.distances_m.map((_, index) => L.polyline(result.segment_geometries?.[index].coordinates.map(([lon, lat]) => [lat, lon] as L.LatLngTuple) ?? [points[index], points[index + 1]], { color: color(result.concentrations_mg_l[0][index], result.scale_mg_l), weight: 9, dashArray: result.reach_id ? undefined : '7 5', className: 'simulation-segment', smoothFactor: 0 }).addTo(map).on('click', () => onSelect(index)));
    sourceMarker(points[0]).addTo(map);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
    for (const index of [0, Math.floor(points.length / 2), points.length - 2]) {
      const a = map.project(points[index]); const b = map.project(points[index + 1]);
      const angle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
      L.marker(points[index], { interactive: false, keyboard: false, icon: L.divIcon({ className: 'simulation-arrow', html: `<span style="transform:rotate(${angle}deg)">➜</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(map);
    }
    const resize = new ResizeObserver(() => map.invalidateSize()); resize.observe(host.current);
    return () => { window.clearTimeout(timer); resize.disconnect(); segments.current = []; map.remove(); };
  }, [result, onSelect, revision]);
  useEffect(() => {
    segments.current.forEach((segment, index) => {
      segment.setStyle({ color: color(values[index], result.scale_mg_l), weight: selected === index ? 11 : 9 });
      const element = segment.getElement();
      element?.setAttribute('data-concentration', String(values[index]));
      element?.setAttribute('data-selected', String(selected === index));
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${format(result.distances_m[index], 0)} м: ${format(values[index], 4)} мг/л`;
      element?.replaceChildren(title);
    });
  }, [values, selected, result, revision]);
  return <section className="map-panel" aria-label="Карта расчётного участка" inert={suspended}>
    <p className="simulation-map-label">{result.reach_id ? String(result.reach_metadata?.name ?? "Реальное русло · сценарный расчёт") : "Условный расчётный участок — не реальное русло"}</p>
    <div ref={host} className="point-map simulation-map" aria-label="Расчётные сегменты на карте. Выбор с клавиатуры доступен ниже." />
    {tileError && <div className="map-warning" role="status"><strong>Подложка карты недоступна</strong><p>Расчётная линия и численные результаты доступны.</p><button onClick={() => setRevision(value => value + 1)}>Повторить загрузку подложки</button></div>}
    <p className="map-caption">{result.reach_id ? 'Реальная геометрия · ' : 'Пунктир — синтетическая геометрия · '}Толщина линии — условный знак, не ширина загрязнения.</p>
  </section>;
}

function sourceMarker(point: L.LatLngExpression) {
  return L.marker(point, { keyboard: false, interactive: false, icon: L.divIcon({ className: 'scenario-source-marker', html: '<span></span>', iconSize: [24, 24], iconAnchor: [12, 12] }) }).bindTooltip('Сценарный источник', { permanent: true, direction: 'right', className: 'scenario-source-tooltip', offset: [14, 0] });
}

function sourcePoint(reach: Reach, distance: number): [number, number] {
  const index = Math.max(0, reach.distances_m.findIndex(value => value >= distance) - 1);
  const span = reach.distances_m[index + 1] - reach.distances_m[index];
  const share = Math.max(0, Math.min(1, (distance - reach.distances_m[index]) / span));
  const a = reach.geometry.coordinates[index], b = reach.geometry.coordinates[index + 1];
  return [a[1] + (b[1] - a[1]) * share, a[0] + (b[0] - a[0]) * share];
}

function ReachPreview({ reach, distance }: { reach: Reach; distance: number }) {
  const host = useRef<HTMLDivElement>(null);
  const marker = useRef<L.Marker | null>(null);
  const [tileError, setTileError] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    setTileError(false);
    const map = L.map(host.current, { scrollWheelZoom: false, zoomAnimation: false, fadeAnimation: false, zoomSnap: .25 });
    map.attributionControl.setPrefix(false);
    const points = reach.geometry.coordinates.map(([lon, lat]) => [lat, lon] as L.LatLngTuple);
    map.fitBounds(points, mapPadding());
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
    tiles.on('tileerror', () => setTileError(true));
    L.polyline(points, { color: 'white', weight: 10, smoothFactor: 0 }).addTo(map);
    L.polyline(points, { color: '#397b86', weight: 5, smoothFactor: 0 }).addTo(map);
    L.circleMarker(points[points.length - 1], { radius: 5, color: '#163b38', fillOpacity: 1 }).bindTooltip('Конец участка · ниже по течению').addTo(map);
    marker.current = sourceMarker(points[0]).addTo(map);
    L.control.scale({ imperial: false }).addTo(map);
    const resize = new ResizeObserver(() => map.invalidateSize()); resize.observe(host.current);
    return () => { resize.disconnect(); marker.current = null; map.remove(); };
  }, [reach]);
  useEffect(() => { marker.current?.setLatLng(sourcePoint(reach, distance)); }, [reach, distance]);
  return <div className="reach-preview"><div ref={host} className="point-map" aria-label="Выбранный участок и сценарный источник" />{tileError && <p className="map-caption">Подложка недоступна. Геометрия участка и источник показаны независимо от неё.</p>}</div>;
}

export default function Simulation() {
  const [mode, setMode] = useState('river');
  const [parametersOpen, setParametersOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const profileWasOpen = useRef(false);
  useEffect(() => {
    if (profileOpen) document.querySelector<HTMLButtonElement>('.profile-close')?.focus({ preventScroll: true });
    else if (profileWasOpen.current) document.querySelector<HTMLButtonElement>('.profile-toggle')?.focus({ preventScroll: true });
    profileWasOpen.current = profileOpen;
  }, [profileOpen]);
  const [reaches, setReaches] = useState<Reach[]>([]);
  const [reachId, setReachId] = useState('');
  const [source, setSource] = useState('0');
  const [reachError, setReachError] = useState('');
  const [reachRevision, setReachRevision] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [draft, setDraft] = useState<Draft>({ ...initialDraft, duration_hours: '4' });
  const [result, setResult] = useState<Result | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error' | 'cancelled'>('idle');
  const [message, setMessage] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Key, string>>>({});
  const [time, setTime] = useState(0);
  const [selected, setSelected] = useState(0);
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { title.current?.focus({ preventScroll: true }); return () => { request.current++; controller.current?.abort(); }; }, []);
  const reach = reaches.find(item => item.id === reachId);
  const sourceValid = !!reach && source.trim() !== '' && Number.isFinite(Number(source)) && Number(source) >= 0 && Number(source) <= reach.length_m - 100;
  const displayLength = mode === 'river' && reach ? Math.max(0, reach.length_m - Number(source || 0)) : Number(draft.length_m);
  useEffect(() => {
    const abort = new AbortController();
    setReachError('');
    fetch('/api/v1/river-reaches', { signal: abort.signal }).then(async response => {
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (!record(data) || !Array.isArray(data.items) || !data.items.length || !data.items.every(validReach)) throw new Error();
      const items = data.items;
      setReaches(items); setReachId(current => current || items[0].id);
    }).catch(() => { if (!abort.signal.aborted) setReachError('Не удалось загрузить подготовленный участок. Повторите запрос.'); });
    return () => abort.abort();
  }, [reachRevision]);
  useEffect(() => {
    if (!playing || !result) return;
    let frame = 0, previous = 0, accumulated = 0;
    const last = result.times_hours.length - 1;
    const tick = (now: number) => {
      if (previous) accumulated += Math.min(now - previous, 100);
      previous = now;
      if (accumulated >= 32) {
        const increment = accumulated / 24000 * last * speed;
        accumulated = 0;
        setTime(current => { const next = Math.min(last, Math.round((current + increment) * 1000) / 1000); if (next === last) setPlaying(false); return next; });
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, result]);
  const stale = result !== null && ((mode === 'river' ? reachId !== result.reach_id || Number(source) !== result.source_distance_m || !sourceValid : !!result.reach_id) || fields.some(field => (mode !== 'river' || field.key !== 'length_m') && (draft[field.key].trim() === '' || Number(draft[field.key]) !== result.inputs[field.key])));


  async function calculate(demonstration = false) {
    const chosenReach = demonstration ? reaches[0] : reach;
    if (demonstration ? !chosenReach : !form.current?.reportValidity() || (mode === 'river' && !sourceValid)) return;
    const nextDraft = demonstration ? { ...initialDraft, duration_hours: '4' } : draft;
    const nextMode = demonstration ? 'river' : mode;
    if (demonstration) { setMode('river'); setReachId(chosenReach!.id); setSource('0'); setDraft(nextDraft); }
    setParametersOpen(false);
    setPlaying(false);
    const inputs = Object.fromEntries(fields.filter(field => nextMode !== 'river' || field.key !== 'length_m').map(field => [field.key, Number(nextDraft[field.key])]));
    const payload = nextMode === 'river' ? { ...inputs, reach_id: chosenReach!.id, source_distance_m: demonstration ? 0 : Number(source) } : inputs;
    const id = ++request.current;
    controller.current?.abort();
    const currentController = new AbortController(); controller.current = currentController;
    setStatus('loading'); setMessage(''); setFieldErrors({});
    const timeout = window.setTimeout(() => currentController.abort(), 60_000);
    try {
      const response = await fetch('/api/v1/simulations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: currentController.signal });
      const data: unknown = await response.json();
      if (id !== request.current) return;
      if (!response.ok) {
        const detail = data && typeof data === 'object' && 'detail' in data ? data.detail : null;
        if (Array.isArray(detail)) {
          const errors: Partial<Record<Key, string>> = {};
          detail.forEach(item => { const key = item?.loc?.at(-1); if (fields.some(field => field.key === key)) errors[key as Key] = 'Проверьте значение и допустимый диапазон.'; });
          setFieldErrors(errors);
        }
        throw new Error(response.status === 422 ? (typeof detail === 'string' ? detail : 'Проверьте параметры расчёта.') : response.status === 503 ? 'Расчётный сервис занят или недоступен. Повторите попытку немного позже.' : 'Проверьте соединение с сервером и повторите попытку.');
      }
      if (!validResult(data)) throw new Error('Сервер вернул неполные результаты. Повторите расчёт.');
      setPlaying(false); setResult(data); setTime(0); setSelected(0); setStatus('ready');
    } catch (error) {
      if (id !== request.current) return;
      setMessage(currentController.signal.aborted ? 'Превышено время ожидания. Повторите расчёт.' : error instanceof Error ? error.message : 'Проверьте соединение с сервером.');
      setStatus('error');
    } finally { window.clearTimeout(timeout); }
  }

  const lower = Math.floor(time), fraction = time - lower;
  const values = result?.concentrations_mg_l[lower].map((value, index) => value + fraction * ((result.concentrations_mg_l[Math.min(lower + 1, result.times_hours.length - 1)][index]) - value));
  const shownHours = result ? result.times_hours[lower] + fraction * (result.times_hours[Math.min(lower + 1, result.times_hours.length - 1)] - result.times_hours[lower]) : 0;
  const span = result ? result.scale_mg_l[1] - result.scale_mg_l[0] : 0;
  const profile = result && values ? values.map((value, index) => `${85 + 645 * result.distances_m[index] / result.inputs.length_m},${span === 0 ? 110 : 190 - 160 * (value - result.scale_mg_l[0]) / span}`).join(' ') : '';
  return <div className="simulation">
    <header className="model-heading"><div><h1 ref={title} tabIndex={-1}>Моделирование</h1><span className="scenario-badge">Сценарная симуляция · хлориды</span></div><div className="workspace-tools"><button className="mobile-parameters-toggle" aria-expanded={parametersOpen} aria-controls="model-parameters" onClick={() => setParametersOpen(value => !value)}>Параметры</button><button className="demo-button" disabled={!reaches.length || status === 'loading'} onClick={() => { void calculate(true); }}>Запустить демонстрацию</button></div></header>
    <div className="model-workspace">
      <aside id="model-parameters" className={`simulation-parameters${parametersOpen ? ' is-open' : ''}`} aria-labelledby="parameters-title">
        <div className="parameters-heading"><div><p className="eyebrow">Сценарий</p><h2 id="parameters-title">Условия расчёта</h2></div><button className="close-parameters" aria-label="Закрыть параметры" onClick={() => { setParametersOpen(false); document.querySelector<HTMLButtonElement>('.mobile-parameters-toggle')?.focus(); }}>×</button></div>
        <form ref={form} onSubmit={event => { event.preventDefault(); void calculate(); }}>
          <div className="parameter-scroll">
            <div className="scenario-geometry"><label htmlFor="scenario-mode">Геометрия сценария</label><select id="scenario-mode" value={mode} onChange={event => { setMode(event.target.value); setPlaying(false); }}><option value="river">Реальное речное русло</option><option value="synthetic">Синтетический участок</option></select></div>
            {mode === 'river' && <section className="river-setup" aria-label="Выбор речного участка">
              {reachError ? <div role="alert"><p>{reachError}</p><button type="button" onClick={() => setReachRevision(value => value + 1)}>Повторить загрузку участка</button></div> : !reach ? <p role="status">Загрузка участка…</p> : <>
                <label htmlFor="reach-id">Подготовленный участок</label><select id="reach-id" value={reachId} onChange={event => { setReachId(event.target.value); setPlaying(false); }}>{reaches.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select>
                <p className="simulation-hint">{format(reach.length_m / 1000, 3)} км · направление вниз по течению</p>
                <label htmlFor="source-distance">Положение сценарного источника, м</label><input id="source-distance" required type="number" min={0} max={reach.length_m - 100} step="any" value={source} onChange={event => { setSource(event.target.value); setPlaying(false); }} aria-describedby="source-help" /><input className="source-slider" type="range" min={0} max={Math.floor(reach.length_m - 100)} step={1} value={sourceValid ? Number(source) : 0} aria-label="Переместить сценарный источник вдоль русла" onChange={event => { setSource(event.target.value); setPlaying(false); }} /><p className="simulation-hint" id="source-help">От начала вниз по течению; ниже источника — не менее 100 м. {sourceValid ? `Для расчёта: ${format(displayLength, 1)} м.` : 'Укажите допустимое положение.'}</p>
              </>}
            </section>}
            <div className="parameter-section-title">Нагрузка и поток <span>Заданы пользователем</span></div>
            <div className="simulation-fields">{fields.map(field => <div className="simulation-field" key={field.key}>
              <label htmlFor={field.key}>{field.label}</label><input id={field.key} type="number" required step="any" min={field.min} max={field.max} value={mode === 'river' && field.key === 'length_m' ? (reach ? String(Number(displayLength.toFixed(3))) : '') : draft[field.key]} readOnly={mode === 'river' && field.key === 'length_m'} aria-describedby={`${field.key}-help${fieldErrors[field.key] ? ` ${field.key}-error` : ''}`} aria-invalid={!!fieldErrors[field.key]} onChange={event => { setDraft(current => ({ ...current, [field.key]: event.target.value })); setPlaying(false); }} />
              <p id={`${field.key}-help`} className="field-help">{mode === 'river' && field.key === 'length_m' ? 'Определяется руслом ниже источника.' : field.help} От {format(field.min, field.min < 1 ? 2 : 0)} до {format(field.max, 0)}.</p>{fieldErrors[field.key] && <p className="simulation-field-error" id={`${field.key}-error`}>{fieldErrors[field.key]}</p>}
            </div>)}</div>
            <details className="simulation-assumptions"><summary>Методика и происхождение данных</summary><p><strong>{mode === 'river' ? 'Реальное русло · условный сброс' : 'Синтетический сценарий'}</strong></p><p>Источник — условная граница после полного смешения. Это не подтверждённый выпуск предприятия. Нагрузка и гидрология заданы пользователем; концентрации рассчитаны. Проверка по реальным наблюдениям не выполнена.</p>{mode === 'river' && reach && <p className="geometry-credit">Геометрия: {String(reach.metadata.attribution ?? reach.name)}. {typeof reach.metadata.source_url === 'string' && /^https?:\/\//.test(reach.metadata.source_url) && <a href={reach.metadata.source_url} target="_blank" rel="noreferrer">Источник данных ↗</a>}</p>}<p>Один полностью перемешанный участок, течение и продольная дисперсия; без притоков, реакций, подпора и поперечного смешения. Озёра и водохранилища не моделируются. Толщина линии не означает ширину загрязнения.</p><p>Демонстрация задаёт синтетические параметры: Qr = 10 м³/с, q = 0,1 м³/с, cb = 10 мг/л, ce = 100 мг/л, u = 0,25 м/с, D = 5 м²/с, источник в начале Дона, длительность 4 ч. Кнопка демонстрации заменяет текущие условия этими значениями.</p></details>
          </div>
          <div className="simulation-actions"><button className="primary" type="submit" disabled={mode === 'river' && (!reach || !sourceValid)}>{status === 'loading' ? 'Запустить новый расчёт' : 'Рассчитать'}</button>{status === 'loading' && <button type="button" onClick={() => { request.current++; controller.current?.abort(); setStatus('cancelled'); }}>Отменить ожидание</button>}<span>Изменённые условия применяются по кнопке</span></div>
        </form>
      </aside>
      <section className="model-canvas" aria-label="Рабочая область модели">
        <div className="model-map-stage">
          {result && values ? <CalculationMap result={result} values={values} selected={selected} onSelect={setSelected} suspended={profileOpen} /> : mode === 'river' && reach ? <ReachPreview reach={reach} distance={sourceValid ? Number(source) : 0} /> : <div className="map-waiting"><div className="map-waiting-symbol" aria-hidden="true">∿</div><strong>{mode === 'river' ? 'Подготовленный участок Дона' : 'Синтетическая геометрия'}</strong><p>{mode === 'river' ? reachError || 'Загружаем речное русло…' : 'Условная линия появится после расчёта. Она не описывает реальную реку.'}</p></div>}
          <div className="map-topline"><div><span className="map-kicker">{result ? 'Рассчитанные концентрации' : 'Подготовленный участок'}</span>{result ? <h2 id="result-title">Результат расчёта</h2> : <h2>{mode === 'river' ? reach?.name ?? 'Загрузка участка…' : 'Условный участок'}</h2>}<p>{result?.reach_id ? String(result.reach_metadata?.name ?? 'Реальное русло') : result ? 'Синтетическая геометрия' : mode === 'river' ? 'Реальная геометрия · сценарный источник' : 'Геометрия и параметры — синтетические'}</p></div></div>
          <div className="map-status-stack">
            {stale && <p className="simulation-stale" role="status">Параметры изменены. Результат относится к предыдущим условиям.</p>}
            {status === 'loading' && <p className="calculation-status" role="status">Выполняется расчёт… {result && <span>Показан предыдущий расчёт.</span>}</p>}
            {status === 'cancelled' && <p className="calculation-status" role="status">Ожидание отменено. Сервер может ещё завершать вычисление.</p>}
            {status === 'error' && <div className="simulation-error" role="alert"><strong>Не удалось выполнить расчёт</strong><p>{message}</p><button onClick={() => { void calculate(); }}>Повторить расчёт</button></div>}
          </div>
          {result && values ? <aside className="map-inspector" inert={profileOpen} aria-label="Концентрация и выбранный сегмент">
            <div className="simulation-legend" data-testid="concentration-scale"><strong>Концентрация · мг/л</strong><div aria-hidden="true" className="simulation-gradient" style={span === 0 ? { background: color(result.scale_mg_l[0], result.scale_mg_l) } : undefined} /><span>{format(result.scale_mg_l[0], 4)}</span>{span !== 0 && <span>{format(result.scale_mg_l[1], 4)}</span>}<small>{span === 0 ? 'Концентрация одинакова на всём участке и во все моменты расчёта.' : 'Постоянная шкала этого расчёта.'} Цвет не означает нормативную оценку.</small></div>
            <div className="simulation-selection"><label htmlFor="simulation-segment">Расчётный сегмент</label><select id="simulation-segment" value={selected} onChange={event => setSelected(Number(event.target.value))}>{result.distances_m.map((distance, index) => <option key={index} value={index}>{index + 1} · {format(distance, 0)} м</option>)}</select><p aria-live={playing ? 'off' : 'polite'}><strong data-testid="selected-concentration">{format(values[selected], 4)} мг/л</strong><span>{format(result.distances_m[selected], 0)} м от источника · {format(shownHours)} ч</span></p></div>
            <button className="profile-toggle" aria-controls="model-profile" aria-expanded={profileOpen} onClick={() => setProfileOpen(value => !value)}>{profileOpen ? 'Свернуть профиль' : 'Профиль и показатели'}<span aria-hidden="true">{profileOpen ? '−' : '↗'}</span></button>
          </aside> : <div className="map-start-hint"><strong>Увидеть распространение по руслу</strong><p>Запустите демонстрацию: 4 модельных часа, синтетическая нагрузка и параметры потока.</p></div>}
          {result && values && <aside id="model-profile" className={`profile-drawer${profileOpen ? ' is-open' : ''}`} aria-label="Профиль и показатели" hidden={!profileOpen}>
            <div className="profile-drawer-heading"><h2>Профиль и показатели</h2><button className="profile-close" aria-label="Закрыть профиль" onClick={() => setProfileOpen(false)}>×</button></div>
            <section className="simulation-profile" aria-labelledby="profile-title"><h3 id="profile-title">Профиль концентрации по расстоянию</h3><p>Центры расчётных сегментов · {format(shownHours)} ч</p><svg viewBox="0 0 760 235" role="img" aria-label="Расчётный профиль концентрации. Все значения доступны в таблице ниже."><path d="M85 25V195H735" fill="none" stroke="currentColor" /><polyline points={profile} fill="none" stroke="var(--accent)" strokeWidth="3" /><text x="85" y="17">мг/л</text>{span === 0 ? <text x="75" y="114" textAnchor="end">{format(result.scale_mg_l[0], 1)}</text> : <><text x="75" y="34" textAnchor="end">{format(result.scale_mg_l[1], 1)}</text><text x="75" y="194" textAnchor="end">{format(result.scale_mg_l[0], 1)}</text></>}<text x="85" y="220">0</text><text x="730" y="220" textAnchor="end">{format(result.inputs.length_m, 0)} м</text></svg>
              <details><summary>Таблица профиля</summary><div className="simulation-table"><table aria-label="Рассчитанный профиль"><thead><tr><th>Сегмент</th><th>Расстояние, м</th><th>Концентрация, мг/л</th></tr></thead><tbody>{result.distances_m.map((distance, index) => <tr key={index}><td>{index + 1}</td><td>{format(distance, 0)}</td><td>{format(values[index], 4)}</td></tr>)}</tbody></table></div></details>
            </section>
            <dl className="simulation-summary"><div><dt>Площадь сечения</dt><dd>{format(result.derived.area_m2)} м²</dd></div><div><dt>Нагрузка выпуска</dt><dd>{format(result.derived.load_kg_s, 4)} кг/с</dd></div><div><dt>Нагрузка сверх фона</dt><dd>{format(result.derived.excess_load_kg_s, 4)} кг/с</dd></div><div><dt>Установившаяся концентрация</dt><dd>{format(result.derived.steady_mg_l, 4)} мг/л</dd></div></dl>
            <p className="simulation-hint">L/u = {format(result.derived.travel_hours, 3)} ч — характерное время переноса, не точное время первого появления вещества. Установившийся профиль постоянен вдоль участка.</p>
            <details className="simulation-used-inputs"><summary>Параметры показанного расчёта</summary><dl>{fields.map(field => <div key={field.key}><dt>{field.label}</dt><dd>{format(result.inputs[field.key], 3)}</dd></div>)}</dl></details>
            <p className="simulation-result-origin">{result.reach_id ? `${String(result.reach_metadata?.name ?? 'Реальное русло')} · источник на ${format(result.source_distance_m ?? 0, 1)} м. Геометрия из документированного источника.` : 'Синтетическая геометрия.'} Нагрузка и гидрология заданы пользователем. Концентрации рассчитаны; проверка по наблюдениям не выполнена.</p>
          </aside>}
        </div>
        <footer className="model-timeline" aria-label="Управление модельным временем">
          <div className="timeline-buttons"><button disabled={!result} type="button" className="playback-button" onClick={() => { if (result && !playing && time >= result.times_hours.length - 1) setTime(0); setPlaying(value => !value); }}><span aria-hidden="true">{playing ? 'Ⅱ' : '▶'}</span>{playing ? 'Пауза' : 'Воспроизвести'}</button><div className="playback-speed"><label htmlFor="playback-speed">Скорость воспроизведения</label><select id="playback-speed" value={speed} disabled={!result} onChange={event => setSpeed(Number(event.target.value))}><option value="0.5">0,5×</option><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option></select></div></div>
          <div className="simulation-time"><label htmlFor="simulation-time">Время от начала сценария</label><output htmlFor="simulation-time">{format(shownHours)} ч</output><input id="simulation-time" type="range" min={0} max={result ? result.times_hours.length - 1 : 48} step={0.001} value={time} disabled={!result} onChange={event => { setPlaying(false); setTime(Number(event.target.value)); }} aria-valuetext={`${format(shownHours)} часов`} /><span>0 ч</span><span>{result ? `${format(result.inputs.duration_hours)} ч` : 'Ожидает расчёта'}</span></div>
          <p className="timeline-note">{result ? 'Линейная интерполяция рассчитанных моментов. Карта, профиль и числа синхронизированы.' : 'Сначала запустите расчёт. Воспроизведение начнётся по вашей команде.'}</p>
        </footer>
      </section>
    </div>
  </div>;
}
