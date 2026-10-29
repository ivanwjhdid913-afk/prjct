import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './simulation.css';
import { comparisonReason, sharedScale, valuesAtHour } from './scenarioComparison';
import TemporalProfile from './TemporalProfile';
import { riverCoordinate } from './riverCoordinate';
import { validTimes, validTemporalResolution, type TemporalResolution } from './temporalResolution';
import SavedScenarios from './SavedScenarios';
import ResultExports from './ResultExports';
import { MODEL_ID, SCENARIO_FORMAT, RIVER_VERSION, SYNTHETIC_VERSION, validConditions, type Conditions, type SavePayload, type SavedScenario } from './scenarioStorage';

const fields = [
  { key: 'river_flow_m3_s', label: 'Расход реки Qr, м³/с', initial: 10, min: .1, max: 1000, help: 'Поток воды выше условного источника.' },
  { key: 'effluent_flow_m3_s', label: 'Расход стоков q, м³/с', initial: .1, min: 0, max: 100, help: 'Постоянный расход после начала сценария; 0 — без источника.' },
  { key: 'background_mg_l', label: 'Фоновая концентрация cb, мг/л', initial: 10, min: 0, max: 10000, help: 'Изначально одинакова на всём участке.' },
  { key: 'effluent_mg_l', label: 'Концентрация стоков ce, мг/л', initial: 100, min: 0, max: 10000, help: 'Хлориды в условном выпуске. Это не измерение предприятия.' },
  { key: 'velocity_m_s', label: 'Скорость течения u, м/с', initial: .25, min: .02, max: 2, help: 'Постоянная средняя скорость вдоль линии.' },
  { key: 'dispersion_m2_s', label: 'Продольная дисперсия D, м²/с', initial: 5, min: .1, max: 100, help: 'Перемешивание вдоль потока; поперечное смешение уже завершено.' },
  { key: 'length_m', label: 'Длина участка L, м', initial: 10000, min: 100, max: 20000, help: 'Длина отображаемой линии, без выходного буфера.' },
  { key: 'duration_hours', label: 'Длительность, ч', initial: 24, min: .1, max: 48, help: 'Общее модельное время, включая перенос после окончания нагрузки.' },
] as const;
type Key = typeof fields[number]['key'];
type LoadMode = 'continuous' | 'finite';
type Inputs = Record<Key, number> & { load_mode?: LoadMode; load_duration_hours?: number | null };
type Draft = Record<Key, string>;
type Line = { type: 'LineString'; coordinates: [number, number][] };
type Reach = { id: string; name: string; length_m: number; geometry: Line; distances_m: number[]; metadata: Record<string, unknown> };
type Result = {
  model_id?: string; format_version?: number;
  inputs: Inputs;
  reach_id?: string | null; source_distance_m?: number; source_coordinate?: [number, number] | null;
  reach_metadata?: Record<string, unknown> | null; segment_geometries?: Line[] | null;
  derived: { total_flow_m3_s: number; area_m2: number; load_kg_s: number; excess_load_kg_s: number; steady_mg_l: number; travel_hours: number };
  distances_m: number[]; times_hours: number[]; concentrations_mg_l: number[][];
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  scale_mg_l: [number, number];
  temporal_resolution?: TemporalResolution;
};
const initialDraft = Object.fromEntries(fields.map(field => [field.key, String(field.initial)])) as Draft;
const DEMO_REACH_ID = 'don-olkhovets';
const format = (value: number, digits = 2) => value.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const formatTime = (hour: number) => hour > 0 && hour < 1 / 60 ? `${format(hour * 3600, 3)} с` : `${format(hour, 4)} ч`;
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
    && (row.inputs.load_mode == null || row.inputs.load_mode === 'continuous' || row.inputs.load_mode === 'finite')
    && (row.inputs.load_mode === 'finite' ? finite(row.inputs.load_duration_hours) && row.inputs.load_duration_hours > 0 && row.inputs.load_duration_hours <= row.inputs.duration_hours : row.inputs.load_duration_hours == null)
    && !!row.derived && ['total_flow_m3_s', 'area_m2', 'load_kg_s', 'excess_load_kg_s', 'steady_mg_l', 'travel_hours'].every(key => finite(row.derived[key as keyof Result['derived']]))
    && Array.isArray(row.distances_m) && row.distances_m.length > 0 && row.distances_m.length <= 200 && row.distances_m.every(finite)
    && validTimes(row.times_hours, row.inputs.duration_hours)
    && (row.temporal_resolution === undefined || validTemporalResolution(row.temporal_resolution, row.times_hours.length))
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

function mapPadding(comparisonLayout = false): L.FitBoundsOptions {
  if (comparisonLayout && window.matchMedia('(max-width: 760px)').matches)
    return window.matchMedia('(max-height: 740px)').matches
      ? { paddingTopLeft: [45, 15], paddingBottomRight: [45, 180], animate: false }
      : { paddingTopLeft: [45, 45], paddingBottomRight: [45, 205], animate: false };
  if (window.matchMedia('(max-width: 760px) and (max-height: 740px)').matches)
    return { paddingTopLeft: [45, 70], paddingBottomRight: [45, 160], animate: false };
  return window.matchMedia('(max-width: 760px)').matches
    ? { paddingTopLeft: [45, 90], paddingBottomRight: [45, 210], animate: false }
    : { paddingTopLeft: [65, 105], paddingBottomRight: [265, 65], animate: false };
}

function CalculationMap({ result, values, scale, selected, onSelect, suspended, comparisonLayout, profileOpen }: { result: Result; scale: [number, number]; values: number[]; selected: number; onSelect: (index: number) => void; suspended: boolean; comparisonLayout: boolean; profileOpen: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const segments = useRef<L.Polyline[]>([]);
  const [tileError, setTileError] = useState(false);
  const [revision, setRevision] = useState(0);
  const geometryKey = JSON.stringify([result.reach_id, result.source_distance_m, result.geometry, result.segment_geometries, result.distances_m]);
  useEffect(() => {
    if (!host.current) return;
    setTileError(false);
    const map = L.map(host.current, { scrollWheelZoom: false, zoomAnimation: false, fadeAnimation: false, zoomControl: false, zoomSnap: .25 });
    mapRef.current = map;
    map.attributionControl.setPrefix(false);
    L.control.zoom({ zoomInTitle: 'Увеличить масштаб', zoomOutTitle: 'Уменьшить масштаб' }).addTo(map);
    const points: L.LatLngTuple[] = result.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    map.attributionControl.setPosition('bottomleft');
    map.fitBounds(points, mapPadding(comparisonLayout));
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
    for (const index of new Set([0, Math.floor(points.length / 2), points.length - 2].filter(index => index >= 0 && index + 1 < points.length))) {
      const a = map.project(points[index]); const b = map.project(points[index + 1]);
      const angle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
      L.marker(points[index], { interactive: false, keyboard: false, icon: L.divIcon({ className: 'simulation-arrow', html: `<span style="transform:rotate(${angle}deg)">➜</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(map);
    }
    const resize = new ResizeObserver(() => map.invalidateSize()); resize.observe(host.current);
    return () => { window.clearTimeout(timer); resize.disconnect(); segments.current = []; mapRef.current = null; map.remove(); };
  }, [geometryKey, onSelect, revision, comparisonLayout]);
  useEffect(() => {
    if (!profileOpen) return;
    const frame = requestAnimationFrame(() => {
      const map = mapRef.current, segment = segments.current[selected];
      if (!map || !segment) return;
      // Only an explicit panel/segment change fits the map; time updates preserve
      // the user's zoom and pan, and keep the same Leaflet map instance.
      map.invalidateSize({ pan: false });
      const bounds = segment.getBounds().extend([result.geometry.coordinates[0][1], result.geometry.coordinates[0][0]]);
      map.fitBounds(bounds, { paddingTopLeft: [65, 50], paddingBottomRight: [35, 35], maxZoom: 18, animate: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [profileOpen, selected, geometryKey, revision, comparisonLayout]);
  useEffect(() => {
    segments.current.forEach((segment, index) => {
      segment.setStyle({ color: color(values[index], scale), weight: selected === index ? 11 : 9 });
      const element = segment.getElement();
      element?.setAttribute('data-concentration', String(values[index]));
      element?.setAttribute('data-selected', String(selected === index));
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${format(result.distances_m[index], 0)} м: ${format(values[index], 4)} мг/л`;
      element?.replaceChildren(title);
    });
  }, [values, selected, result, scale, revision, comparisonLayout]);
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
  const [longitude, latitude] = riverCoordinate(reach.geometry.coordinates, reach.distances_m, distance);
  return [latitude, longitude];
}

function ReachPreview({ reach, distance, point, suspended, picking, onPick }: { reach: Reach; distance: number; point: [number, number] | null; suspended: boolean; picking: boolean; onPick: (longitude: number, latitude: number) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const marker = useRef<L.Marker | null>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
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
    L.polyline(points, { color: '#397b86', weight: 5, smoothFactor: 0, className: 'reach-preview-line' }).addTo(map);
    for (const index of [0, Math.floor((points.length - 1) / 2), points.length - 2]) {
      const a = map.project(points[index]), b = map.project(points[index + 1]);
      const angle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
      L.marker(points[index], { interactive: false, keyboard: false, icon: L.divIcon({ className: 'simulation-arrow', html: `<span style="transform:rotate(${angle}deg)">➜</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(map);
    }
    map.on('click', event => pick.current(event.latlng.lng, event.latlng.lat));
    L.circleMarker(points[points.length - 1], { radius: 5, color: '#163b38', fillOpacity: 1 }).bindTooltip('Конец участка · ниже по течению').addTo(map);
    marker.current = sourceMarker(points[0]).addTo(map);
    L.control.scale({ imperial: false }).addTo(map);
    const resize = new ResizeObserver(() => map.invalidateSize()); resize.observe(host.current);
    return () => { resize.disconnect(); marker.current = null; map.remove(); };
  }, [reach]);
  useEffect(() => { marker.current?.setLatLng(point ? [point[1], point[0]] : sourcePoint(reach, distance)); }, [reach, distance, point]);
  useEffect(() => {
    if (!picking) return;
    const frame = requestAnimationFrame(() => host.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [picking]);
  const shownPoint = point ?? (() => { const [lat, lon] = sourcePoint(reach, distance); return [lon, lat]; })();
  return <div className={`reach-preview${picking ? ' is-picking' : ''}`} data-reach-id={reach.id} data-source-coordinate={JSON.stringify(shownPoint)} inert={suspended}><div ref={host} tabIndex={-1} className="point-map" aria-label="Выбранный участок и сценарный источник" />{tileError && <p className="map-caption">Подложка недоступна. Геометрия участка и источник показаны независимо от неё.</p>}</div>;
}

export default function Simulation() {
  const [mode, setMode] = useState('river');
  const [parametersOpen, setParametersOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileView, setProfileView] = useState<'space' | 'time'>('space');
  const [mobileLayout, setMobileLayout] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const [loadMode, setLoadMode] = useState<LoadMode>('continuous');
  const [loadDuration, setLoadDuration] = useState('0.5');
  const profileWasOpen = useRef(false);
  const parametersWereOpen = useRef(false);
  useEffect(() => {
    if (parametersOpen) document.querySelector<HTMLButtonElement>('.close-parameters')?.focus({ preventScroll: true });
    else if (parametersWereOpen.current) document.querySelector<HTMLButtonElement>('.mobile-parameters-toggle')?.focus({ preventScroll: true });
    parametersWereOpen.current = parametersOpen;
  }, [parametersOpen]);
  useEffect(() => {
    const mobile = window.matchMedia('(max-width: 760px)');
    const closeOnDesktop = () => { setMobileLayout(mobile.matches); if (!mobile.matches) setParametersOpen(false); };
    mobile.addEventListener('change', closeOnDesktop);
    return () => mobile.removeEventListener('change', closeOnDesktop);
  }, []);
  useEffect(() => {
    if (profileOpen) document.querySelector<HTMLButtonElement>('.profile-close')?.focus({ preventScroll: true });
    else if (profileWasOpen.current) document.querySelector<HTMLButtonElement>('.profile-toggle')?.focus({ preventScroll: true });
    profileWasOpen.current = profileOpen;
  }, [profileOpen]);
  const [reaches, setReaches] = useState<Reach[]>([]);
  const [reachId, setReachId] = useState(DEMO_REACH_ID);
  const [source, setSource] = useState('0');
  const [sourceCoordinate, setSourceCoordinate] = useState<[number, number] | null>(null);
  const [pickingSource, setPickingSource] = useState(false);
  const [pickMessage, setPickMessage] = useState('');
  const [pickPending, setPickPending] = useState(false);
  const [draftPreview, setDraftPreview] = useState(false);
  // Completion may publish its own result, but cannot replace a newer draft view.
  const geometryEditRevision = useRef(0);
  const snapRequest = useRef(0);
  const snapController = useRef<AbortController | null>(null);
  const previewBeforePick = useRef(false);
  const sourcePickButton = useRef<HTMLButtonElement>(null);
  const pickingRef = useRef(false);
  const [reachError, setReachError] = useState('');
  const [reachRevision, setReachRevision] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [draft, setDraft] = useState<Draft>({ ...initialDraft, duration_hours: '4' });
  const [latestResult, setResult] = useState<Result | null>(null);
  const [baseline, setBaseline] = useState<Result | null>(null);
  const [variant, setVariant] = useState(false);
  const [comparisonExitReason, setComparisonExitReason] = useState('');
  const [hasB, setHasB] = useState(false);
  const [activeScenario, setActiveScenario] = useState<'А' | 'Б'>('Б');
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error' | 'cancelled'>('idle');
  const [interactionKey, setInteractionKey] = useState(0);
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
  const demoReach = reaches.find(item => item.id === DEMO_REACH_ID);
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
      setReaches(items); setReachId(current => items.some(item => item.id === current) ? current : items.some(item => item.id === DEMO_REACH_ID) ? DEMO_REACH_ID : items[0].id);
    }).catch(() => { if (!abort.signal.aborted) setReachError('Не удалось загрузить подготовленный участок. Повторите запрос.'); });
    return () => abort.abort();
  }, [reachRevision]);
  function invalidateSnap() { snapRequest.current++; snapController.current?.abort(); setPickPending(false); }
  function finishPicking(restorePreview = false) {
    invalidateSnap(); pickingRef.current = false; setPickingSource(false); setPickMessage('');
    if (restorePreview) setDraftPreview(previewBeforePick.current);
    requestAnimationFrame(() => (mobileLayout ? document.querySelector<HTMLButtonElement>('.mobile-parameters-toggle') : sourcePickButton.current)?.focus({ preventScroll: true }));
  }
  function editSource(value: string) {
    geometryEditRevision.current++;
    invalidateSnap(); setSource(value); setSourceCoordinate(null); setDraftPreview(true); setPickMessage(''); setPlaying(false);
  }
  function selectReach(id: string) {
    geometryEditRevision.current++;
    finishPicking(); setReachId(id); setSource('0'); setSourceCoordinate(null); setDraftPreview(true); setPlaying(false);
  }
  function startPicking() {
    if (!reach || mode !== 'river') return;
    geometryEditRevision.current++;
    invalidateSnap(); previewBeforePick.current = draftPreview; pickingRef.current = true;
    setPickingSource(true); setDraftPreview(true); setPickMessage(''); setParametersOpen(false); setProfileOpen(false); setPlaying(false);
  }
  useEffect(() => {
    if (!pickingSource) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); finishPicking(true); } };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [pickingSource, mobileLayout]);
  useEffect(() => () => { snapRequest.current++; snapController.current?.abort(); }, []);
  async function pickSource(longitude: number, latitude: number) {
    if (!pickingRef.current || !reach || mode !== 'river') return;
    invalidateSnap(); const id = snapRequest.current; const selectedReach = reach;
    const abort = new AbortController(); snapController.current = abort;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; abort.abort(); }, 10_000);
    setPickPending(true); setPickMessage('Привязываем точку к выбранному руслу…');
    try {
      const response = await fetch(`/api/v1/river-reaches/${encodeURIComponent(selectedReach.id)}/source-snap?${new URLSearchParams({ longitude: String(longitude), latitude: String(latitude) })}`, { signal: abort.signal });
      const data: unknown = await response.json();
      if (id !== snapRequest.current || !pickingRef.current || abort.signal.aborted) return;
      if (!response.ok) throw new Error(response.status === 422 ? 'Точка слишком далеко от выбранного русла или ниже неё осталось менее 100 м. Выберите другую точку.' : 'Не удалось привязать источник. Повторите выбор точки.');
      if (!record(data) || data.reach_id !== selectedReach.id || !finite(data.source_distance_m) || !coordinate(data.coordinate) || !finite(data.distance_to_river_m) || data.distance_to_river_m < 0 || data.max_distance_m !== 75) throw new Error('Некорректный ответ сервера. Повторите выбор точки.');
      if (data.distance_to_river_m > 75) throw new Error('Точка слишком далеко: нажмите не дальше 75 м от выбранного русла.');
      if (data.source_distance_m < 0 || data.source_distance_m > selectedReach.length_m - 100) throw new Error('Ниже сценарного источника должно оставаться не менее 100 м. Выберите точку выше по течению.');
      setSource(String(data.source_distance_m)); setSourceCoordinate(data.coordinate); setPlaying(false); finishPicking();
      setPickMessage(`Сценарный источник выбран: ${selectedReach.name} · ${format(data.source_distance_m, 1)} м. Примените условия кнопкой «Рассчитать».`);
    } catch (error) {
      if (id === snapRequest.current && pickingRef.current && (timedOut || !abort.signal.aborted)) setPickMessage(timedOut ? 'Превышено время ожидания привязки. Источник не перемещён. Повторите выбор точки.' : error instanceof Error ? error.message : 'Не удалось привязать источник. Повторите выбор точки.');
    } finally { window.clearTimeout(timeout); if (id === snapRequest.current) setPickPending(false); }
  }
  const incompatibleDraft = baseline && variant ? (
    (mode === 'river' ? reachId !== baseline.reach_id : !!baseline.reach_id) ? 'Нужны одинаковые участок и геометрия.'
    : mode === 'river' && (Number(source) !== baseline.source_distance_m || !sourceValid) ? 'Сценарный источник должен находиться в том же положении, что и в А.'
    : Number(draft.duration_hours) !== baseline.inputs.duration_hours ? 'Для сравнения длительность должна совпадать с А.'
    : mode === 'synthetic' && Number(draft.length_m) !== baseline.inputs.length_m ? 'Длина и геометрия должны совпадать с А.' : '') : '';
  const completedReason = baseline && hasB && latestResult ? comparisonReason(baseline, latestResult) : '';
  const comparison = !!(baseline && variant && hasB && latestResult && !incompatibleDraft && !completedReason);
  const result = comparison && activeScenario === 'А' ? baseline : latestResult;
  const clockResult = comparison ? baseline : latestResult;
  const scale = useMemo<[number, number]>(() => comparison && baseline && latestResult ? sharedScale(baseline, latestResult) : latestResult?.scale_mg_l ?? [0, 0], [comparison, baseline, latestResult]);
  function stopRequest() { request.current++; controller.current?.abort(); setStatus('idle'); setMessage(''); setFieldErrors({}); setComparisonExitReason(''); }
  function pinBaseline() {
    if (!result) return;
    stopRequest(); setPlaying(false); setBaseline(result); setResult(result); setVariant(false); setHasB(false); setActiveScenario('А');
  }
  function createVariant() {
    if (!baseline) return;
    stopRequest(); setPlaying(false); setMode(baseline.reach_id ? 'river' : 'synthetic');
    if (baseline.reach_id) setReachId(baseline.reach_id);
    finishPicking(); setDraftPreview(false); setSourceCoordinate(baseline.source_coordinate ?? null); setSource(String(baseline.source_distance_m ?? 0));
    setLoadMode(baseline.inputs.load_mode ?? 'continuous'); setLoadDuration(String(baseline.inputs.load_duration_hours ?? .5));
    setDraft(Object.fromEntries(fields.map(field => [field.key, String(baseline.inputs[field.key])])) as Draft);
    setResult(baseline); setVariant(true); setHasB(false); setActiveScenario('Б'); setTime(0); setSelected(0);
  }
  useEffect(() => {
    if (!playing || !clockResult) return;
    let frame = 0, previous: number | null = null;
    const duration = clockResult.inputs.duration_hours;
    const tick = (now: number) => {
      const elapsed = previous === null ? 0 : now - previous;
      previous = now;
      const increment = elapsed / 24000 * duration * speed;
      setTime(current => { const next = Math.min(duration, current + increment); if (next === duration) setPlaying(false); return next; });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, clockResult]);
  const stale = latestResult !== null && (loadMode !== (latestResult.inputs.load_mode ?? 'continuous') || (loadMode === 'finite' && Number(loadDuration) !== latestResult.inputs.load_duration_hours) || (mode === 'river' ? reachId !== latestResult.reach_id || Number(source) !== latestResult.source_distance_m || !sourceValid : !!latestResult.reach_id) || fields.some(field => (mode !== 'river' || field.key !== 'length_m') && (draft[field.key].trim() === '' || Number(draft[field.key]) !== latestResult.inputs[field.key])));

  function conditionsToSave(): SavePayload {
    if (!form.current?.reportValidity() || pickPending || pickingSource || (mode === 'river' && (!reach || !sourceValid)))
      throw new Error('Завершите выбор источника и заполните корректные условия расчёта.');
    const conditions = {
      ...Object.fromEntries(fields.filter(field => mode !== 'river' || field.key !== 'length_m').map(field => [field.key, Number(draft[field.key])])),
      load_mode: loadMode, load_duration_hours: loadMode === 'finite' ? Number(loadDuration) : null,
      ...(mode === 'river' ? { reach_id: reach!.id, source_distance_m: Number(source) } : {}),
    };
    if (!validConditions(conditions)) throw new Error('Проверьте условия: числа, диапазоны и длительность периода загрязнения.');
    const checksum = mode === 'river' ? reach?.metadata.geometry_sha256 : null;
    if (mode === 'river' && (typeof checksum !== 'string' || !/^[0-9a-f]{64}$/.test(checksum)))
      throw new Error('Версия геометрии ещё не загружена. Обновите участок перед сохранением условий.');
    return { format_version: SCENARIO_FORMAT, model_id: MODEL_ID,
      geometry_version: mode === 'river' ? RIVER_VERSION : SYNTHETIC_VERSION,
      geometry_sha256: checksum as string | null, conditions };
  }
  function openSavedConditions(saved: Pick<SavedScenario, 'conditions' | 'geometry_sha256'> & { downstream_geometry_sha256?: string | null }) {
    const conditions: Conditions = saved.conditions;
    if (conditions.reach_id != null) {
      const savedReach = reaches.find(item => item.id === conditions.reach_id);
      if (!savedReach || savedReach.metadata.geometry_sha256 !== saved.geometry_sha256)
        throw new Error('Участок отсутствует или геометрия страницы изменилась. Обновите страницу; исходная запись сохранена.');
      if (saved.downstream_geometry_sha256 != null && savedReach.metadata.downstream_geometry_sha256 !== saved.downstream_geometry_sha256)
        throw new Error('Проверенное продолжение участка изменилось. Обновите страницу; источник не перенесён.');
      if (savedReach.length_m - (conditions.source_distance_m ?? 0) < 100)
        throw new Error('Для сохранённого источника осталось менее 100 м русла. Исходная запись сохранена.');
    }
    setInteractionKey(value => value + 1);
    stopRequest(); finishPicking(); geometryEditRevision.current++;
    setMode(conditions.reach_id ? 'river' : 'synthetic');
    if (conditions.reach_id) setReachId(conditions.reach_id);
    setSource(String(conditions.source_distance_m ?? 0)); setSourceCoordinate(null);
    setDraft(Object.fromEntries(fields.map(field => [field.key, String(conditions[field.key] ?? initialDraft[field.key])])) as Draft);
    setLoadMode(conditions.load_mode); setLoadDuration(String(conditions.load_duration_hours ?? .5));
    const geometryChanged = !latestResult || (conditions.reach_id ?? null) !== (latestResult.reach_id ?? null)
      || (conditions.source_distance_m ?? 0) !== (latestResult.source_distance_m ?? 0);
    setDraftPreview(!!conditions.reach_id && geometryChanged); setPlaying(false);
    setVariant(!!baseline);
  }
  const savedDraftKey = JSON.stringify([mode, reachId, source, draft, loadMode, loadDuration, pickingSource, pickPending]);
  function conditionsDocument(name: string) {
    const payload = conditionsToSave();
    const metadata = mode === 'river' ? reach!.metadata : {};
    return { ...payload, name, geometry_mode: mode === 'river' ? 'river' as const : 'synthetic' as const,
      reach_id: payload.conditions.reach_id ?? null, reach_name: mode === 'river' ? reach!.name : 'Синтетический участок',
      downstream_geometry_sha256: mode === 'river' ? String(metadata.downstream_geometry_sha256 ?? '') : null,
      geometry_source: Object.fromEntries(['source','source_url','attribution','license','crs','snapshot_date','osm_way_id','osm_way_version','osm_way_timestamp','raw_sha256'].filter(key => key in metadata).map(key => [key, metadata[key]])),
      conditions: { ...payload.conditions, reach_id: payload.conditions.reach_id ?? null, source_distance_m: payload.conditions.source_distance_m ?? 0, length_m: payload.conditions.length_m ?? null },
    };
  }

  async function calculate(demonstration: false | true | 'finite' = false) {
    const chosenReach = demonstration ? demoReach : reach;
    if (demonstration ? !chosenReach : !form.current?.reportValidity() || (mode === 'river' && !sourceValid)) return;
    setInteractionKey(value => value + 1);
    const nextDraft = demonstration ? { ...initialDraft, duration_hours: demonstration === 'finite' ? '6' : '4' } : draft;
    const nextLoadMode = demonstration ? (demonstration === 'finite' ? 'finite' : 'continuous') : loadMode;
    const nextLoadDuration = nextLoadMode === 'finite' ? (demonstration ? .5 : Number(loadDuration)) : null;
    const nextMode = demonstration ? 'river' : mode;
    finishPicking();
    if (demonstration) { setSourceCoordinate(null); setComparisonExitReason(''); setVariant(false); setHasB(false); setMode('river'); setReachId(chosenReach!.id); setSource('0'); setDraft(nextDraft); setLoadMode(nextLoadMode); setLoadDuration('.5'); }
    setParametersOpen(false);
    setPlaying(false);
    const inputs = { ...Object.fromEntries(fields.filter(field => nextMode !== 'river' || field.key !== 'length_m').map(field => [field.key, Number(nextDraft[field.key])])), load_mode: nextLoadMode, load_duration_hours: nextLoadDuration };
    const payload = nextMode === 'river' ? { ...inputs, reach_id: chosenReach!.id, source_distance_m: demonstration ? 0 : Number(source) } : inputs;
    const id = ++request.current;
    const requestedGeometryRevision = geometryEditRevision.current;
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
      const compatibleB = !demonstration && variant && baseline && !comparisonReason(baseline, data);
      setComparisonExitReason(!demonstration && variant && baseline ? comparisonReason(baseline, data) : '');
      setVariant(!!compatibleB); setHasB(!!compatibleB); setActiveScenario('Б');
      setPlaying(false); if (geometryEditRevision.current === requestedGeometryRevision) setDraftPreview(false);
      setResult(data); setTime(0); setSelected(0); setStatus('ready');
    } catch (error) {
      if (id !== request.current) return;
      setMessage(currentController.signal.aborted ? 'Превышено время ожидания. Повторите расчёт.' : error instanceof Error ? error.message : 'Проверьте соединение с сервером.');
      setStatus('error');
    } finally { window.clearTimeout(timeout); }
  }

  const shownHours = clockResult ? Math.max(0, Math.min(time, clockResult.inputs.duration_hours)) : 0;
  const values = result ? valuesAtHour(result, shownHours) : null;
  const valuesA = comparison && baseline ? valuesAtHour(baseline, shownHours) : null;
  const valuesB = comparison && latestResult ? valuesAtHour(latestResult, shownHours) : null;
  const span = scale[1] - scale[0];
  const profilePoints = (points: number[]) => result ? points.map((value, index) => `${85 + 645 * result.distances_m[index] / result.inputs.length_m},${span === 0 ? 110 : 190 - 160 * (value - scale[0]) / span}`).join(' ') : '';
  const profile = values ? profilePoints(values) : '';
  const loadEnd = (item: Result) => item.inputs.load_mode === 'finite' ? item.inputs.load_duration_hours! : null;
  const sourceState = (item: Result) => loadEnd(item) !== null && shownHours >= loadEnd(item)! ? 'Повышенная нагрузка завершена' : 'Повышенная нагрузка действует';
  const sourceDescription = (item: Result) => item.derived.excess_load_kg_s === 0 ? 'Добавочной нагрузки нет' : item.derived.excess_load_kg_s < 0 ? (loadEnd(item) !== null && shownHours >= loadEnd(item)! ? 'Период пониженной концентрации завершён' : 'Поступает вода ниже фоновой концентрации') : sourceState(item);
  const loadMarkers = (comparison && baseline && latestResult ? [{ item: baseline, label: 'А' }, { item: latestResult, label: 'Б' }] : result ? [{ item: result, label: '' }] : []).filter(({ item }) => loadEnd(item) !== null);
  const showingPreview = mode === 'river' && !!reach && (draftPreview || !result);
  const showingResult = !!result && !showingPreview;
  const concentrationLegend = <div className="simulation-legend" data-testid="concentration-scale"><strong>Концентрация · мг/л</strong><div aria-hidden="true" className="simulation-gradient" style={span === 0 ? { background: color(scale[0], scale) } : undefined} /><span>{format(scale[0], 4)}</span>{span !== 0 && <span>{format(scale[1], 4)}</span>}<small>{span === 0 ? 'Концентрация одинакова на всём участке и во все моменты расчёта.' : comparison ? 'Общая постоянная шкала А и Б.' : 'Постоянная шкала этого расчёта.'} Цвет не означает нормативную оценку.</small></div>;
  return <div className={`simulation${comparison ? " is-comparing" : ""}`}>
    <header className="model-heading"><div><h1 ref={title} tabIndex={-1}>Моделирование</h1><span className="scenario-badge">Сценарная симуляция · хлориды</span></div><div className="workspace-tools"><button className="mobile-parameters-toggle" aria-expanded={parametersOpen} aria-controls="model-parameters" onClick={() => setParametersOpen(value => !value)}>Параметры</button><button className="demo-button" disabled={!demoReach || status === 'loading'} onClick={() => { void calculate(true); }}>Запустить демонстрацию</button></div></header>
    <div className="map-status-stack">
      {(incompatibleDraft || completedReason || comparisonExitReason) && <p className="comparison-notice" role="status">Сравнение отключено. {incompatibleDraft || completedReason || comparisonExitReason} Можно выполнить одиночный расчёт; закреплённый А сохранён.</p>}
            {stale && <p className="simulation-stale" role="status">{variant && !incompatibleDraft ? hasB ? 'Параметры Б изменены. Прежний результат Б относится к предыдущим условиям.' : 'Условия Б изменены. Показан базовый расчёт А; вариант Б ещё не рассчитан.' : 'Параметры изменены. Результат относится к предыдущим условиям.'}</p>}
            {status === 'loading' && <p className="calculation-status" role="status">Выполняется расчёт… {result && <span>Показан предыдущий расчёт.</span>}</p>}
            {status === 'cancelled' && <p className="calculation-status" role="status">Ожидание отменено. Сервер может ещё завершать вычисление.</p>}
            {status === 'error' && <div className="simulation-error" role="alert"><strong>Не удалось выполнить расчёт</strong><p>{message}</p><button onClick={() => { void calculate(); }}>Повторить расчёт</button></div>}
          </div>
    <div className="model-workspace">
      <aside id="model-parameters" className={`simulation-parameters${parametersOpen ? ' is-open' : ''}`} aria-labelledby="parameters-title">
        <div className="parameters-heading"><div><p className="eyebrow">Сценарий</p><h2 id="parameters-title">Условия расчёта</h2></div><button className="close-parameters" aria-label="Закрыть параметры" onClick={() => setParametersOpen(false)}>×</button></div>
        <form ref={form} onSubmit={event => { event.preventDefault(); void calculate(); }}>
          <div className="parameter-scroll">
            <SavedScenarios draftKey={savedDraftKey} interactionKey={interactionKey} getConditions={conditionsToSave} getDocument={conditionsDocument} onApplyConditions={openSavedConditions} onOpen={openSavedConditions} />
            <section className="scenario-comparison-controls" aria-label="Сценарии текущего сеанса">
              <p className="comparison-step">{baseline ? variant ? 'Б · редактируемый вариант' : 'А · закреплённый расчёт' : 'Начните с базового расчёта'}</p>
              {!baseline ? <button type="button" disabled={!result || status === 'loading'} onClick={pinBaseline}>Закрепить как А</button> : <><button type="button" onClick={createVariant}>Создать вариант Б</button><button type="button" className="replace-baseline" disabled={!result || status === 'loading'} onClick={pinBaseline}>Заменить А показанным расчётом</button></>}
              <small>После перезагрузки страницы сценарии сбрасываются: результаты А/Б хранятся только в сеансе. Сохранённые условия остаются в библиотеке.</small>
            </section>
            <div className="scenario-geometry"><label htmlFor="scenario-mode">Геометрия сценария</label><select id="scenario-mode" value={mode} onChange={event => { geometryEditRevision.current++; finishPicking(); setMode(event.target.value); setDraftPreview(false); setPlaying(false); }}><option value="river">Реальное речное русло</option><option value="synthetic">Синтетический участок</option></select></div>
            {mode === 'river' && <section className="river-setup" aria-label="Выбор речного участка">
              {!demoReach && reaches.length > 0 && <p className="simulation-field-error" role="status">Участок Дона для демонстраций недоступен. Для расчёта выбран другой подготовленный участок.</p>}{reachError ? <div role="alert"><p>{reachError}</p><button type="button" onClick={() => setReachRevision(value => value + 1)}>Повторить загрузку участка</button></div> : !reach ? <><label htmlFor="reach-id">Подготовленный участок</label><select id="reach-id" value="" onChange={event => selectReach(event.target.value)}><option value="" disabled>Выберите участок</option>{reaches.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select><p role="status">{reaches.length ? 'Выберите подготовленное русло.' : 'Загрузка участка…'}</p></> : <>
                <label htmlFor="reach-id">Подготовленный участок</label><select id="reach-id" value={reachId} onChange={event => { selectReach(event.target.value); }}>{reaches.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select>
                <p className="simulation-hint">{format(reach.length_m / 1000, 3)} км · направление вниз по течению</p>
                {result && !draftPreview && !pickingSource && !pickMessage && <button type="button" className="source-pick-toggle" onClick={() => { geometryEditRevision.current++; setDraftPreview(true); setProfileOpen(false); }}>Показать условия следующего расчёта</button>}<button ref={sourcePickButton} type="button" className="source-pick-toggle" aria-pressed={pickingSource} onClick={() => pickingSource ? finishPicking(true) : startPicking()}>Указать источник на карте</button><label htmlFor="source-distance">Положение сценарного источника, м</label><input id="source-distance" required type="number" min={0} max={reach.length_m - 100} step="any" value={source} onChange={event => { editSource(event.target.value); }} aria-describedby="source-help" /><input className="source-slider" type="range" min={0} max={Math.floor(reach.length_m - 100)} step={1} value={sourceValid ? Number(source) : 0} aria-label="Переместить сценарный источник вдоль русла" onChange={event => { editSource(event.target.value); }} /><p className="simulation-hint" id="source-help">От начала вниз по течению; ниже источника — не менее 100 м. {sourceValid ? `Для расчёта: ${format(displayLength, 1)} м.` : 'Укажите допустимое положение.'}</p>
              </>}
            </section>}
            <div className="parameter-section-title">Нагрузка и поток <span>Заданы пользователем</span></div>
            <section className="load-settings" aria-label="Временной режим нагрузки">
              <label htmlFor="load-mode">Режим нагрузки</label><select id="load-mode" value={loadMode} onChange={event => { setLoadMode(event.target.value as LoadMode); setPlaying(false); }}><option value="continuous">Постоянная нагрузка</option><option value="finite">Ограниченный период загрязнения</option></select>
              {loadMode === 'finite' && <><label htmlFor="load-duration">Период загрязнения, ч</label><input id="load-duration" type="number" required min={0.000001} max={Number(draft.duration_hours)} step="any" value={loadDuration} onChange={event => { setLoadDuration(event.target.value); setPlaying(false); }} aria-describedby="load-help" /></>}
              <p id="load-help">{loadMode === 'finite' ? 'От начала до заданного времени действует ce, затем поступающая вода имеет концентрацию cb. Расход воды сохраняется: это не закрытие водовыпуска и не гидравлическая волна.' : 'При постоянной нагрузке и гидравлике после прохождения фронта возможно плато. Оно не означает ошибку модели.'}</p>
              <button type="button" disabled={!demoReach || status === 'loading'} onClick={() => { void calculate('finite'); }}>Демонстрация периода</button><small>Синтетические параметры на Дону: нагрузка 0,5 ч, расчёт 6 ч. Заменяет условия формы.</small>
            </section>
            <div className="simulation-fields">{fields.map(field => <div className="simulation-field" key={field.key}>
              <label htmlFor={field.key}>{field.label}</label><input id={field.key} type="number" required step="any" min={field.min} max={field.max} value={mode === 'river' && field.key === 'length_m' ? (reach ? String(Number(displayLength.toFixed(3))) : '') : draft[field.key]} readOnly={mode === 'river' && field.key === 'length_m'} aria-describedby={`${field.key}-help${fieldErrors[field.key] ? ` ${field.key}-error` : ''}`} aria-invalid={!!fieldErrors[field.key]} onChange={event => { setDraft(current => ({ ...current, [field.key]: event.target.value })); setPlaying(false); }} />
              <p id={`${field.key}-help`} className="field-help">{mode === 'river' && field.key === 'length_m' ? 'Определяется руслом ниже источника.' : field.help} От {format(field.min, field.min < 1 ? 2 : 0)} до {format(field.max, 0)}.</p>{fieldErrors[field.key] && <p className="simulation-field-error" id={`${field.key}-error`}>{fieldErrors[field.key]}</p>}
            </div>)}</div>
            <details className="simulation-assumptions"><summary>Методика и происхождение данных</summary><p><strong>{mode === 'river' ? 'Реальное русло · условный сброс' : 'Синтетический сценарий'}</strong></p><p>Источник — условная граница после полного смешения. Это не подтверждённый выпуск предприятия. Нагрузка и гидрология заданы пользователем; концентрации рассчитаны. Проверка по реальным наблюдениям не выполнена.</p>{mode === 'river' && reach && <p className="geometry-credit">Геометрия: {String(reach.metadata.attribution ?? reach.name)}. {typeof reach.metadata.source_url === 'string' && /^https?:\/\//.test(reach.metadata.source_url) && <a href={reach.metadata.source_url} target="_blank" rel="noreferrer">Источник данных ↗</a>}</p>}<p>Один полностью перемешанный участок, течение и продольная дисперсия; без притоков, реакций, подпора и поперечного смешения. Озёра и водохранилища не моделируются. Толщина линии не означает ширину загрязнения.</p><p>Демонстрация задаёт синтетические параметры: Qr = 10 м³/с, q = 0,1 м³/с, cb = 10 мг/л, ce = 100 мг/л, u = 0,25 м/с, D = 5 м²/с, источник в начале Дона, длительность 4 ч. Кнопка демонстрации заменяет текущие условия этими значениями.</p></details>
          </div>
          <div className="simulation-actions"><button className="primary" type="submit" disabled={mode === 'river' && (!reach || !sourceValid)}>{status === 'loading' ? 'Запустить новый расчёт' : variant && !incompatibleDraft ? 'Рассчитать Б' : 'Рассчитать'}</button>{status === 'loading' && <button type="button" onClick={() => { setInteractionKey(value => value + 1); request.current++; controller.current?.abort(); setStatus('cancelled'); }}>Отменить ожидание</button>}<span>Изменённые условия применяются по кнопке</span></div>
        </form>
      </aside>
      <section className="model-canvas" aria-label="Рабочая область модели">
          {comparison && !showingPreview && <div className="scenario-switch" role="group" aria-label="Показанный сценарий" inert={parametersOpen}><button aria-pressed={activeScenario === 'А'} onClick={() => setActiveScenario('А')}>Показать А</button><button aria-pressed={activeScenario === 'Б'} onClick={() => setActiveScenario('Б')}>Показать Б</button><span>На карте: {activeScenario} · общее время</span></div>}
        {(pickingSource || pickMessage || (result && mode === 'river' && reach && draftPreview)) && <div className="source-map-tools">
          {(pickingSource || pickMessage) && <p role="status" data-testid="source-pick-status">{pickingSource && <strong>{reach?.name}: нажмите рядом с руслом, не дальше 75 м. Ниже источника — минимум 100 м. Escape — отмена. </strong>}{pickMessage}</p>}
          {pickingSource ? <button type="button" onClick={() => finishPicking(true)}>Отменить выбор источника</button> : result && mode === 'river' && reach && <button type="button" onClick={() => { geometryEditRevision.current++; setDraftPreview(value => !value); setProfileOpen(false); }}>{showingPreview ? 'Показать рассчитанный результат' : 'Показать условия следующего расчёта'}</button>}
          {pickPending && <span aria-hidden="true" className="source-pick-pending">…</span>}
        </div>}
        <div className={`model-map-stage${profileOpen && showingResult ? ' has-profile' : ''}`}>
          {showingResult && result && values ? <CalculationMap comparisonLayout={comparison} result={result} scale={scale} values={values} selected={selected} onSelect={setSelected} suspended={parametersOpen} profileOpen={profileOpen} /> : mode === 'river' && reach ? <ReachPreview reach={reach} distance={sourceValid ? Number(source) : 0} point={sourceValid ? sourceCoordinate : null} picking={pickingSource} onPick={(lon, lat) => { void pickSource(lon, lat); }} suspended={parametersOpen} /> : <div className="map-waiting"><div className="map-waiting-symbol" aria-hidden="true">∿</div><strong>{mode === 'river' ? 'Подготовленный участок Дона' : 'Синтетическая геометрия'}</strong><p>{mode === 'river' ? reachError || 'Загружаем речное русло…' : 'Условная линия появится после расчёта. Она не описывает реальную реку.'}</p></div>}

          <div className="map-topline"><div><span className="map-kicker">{showingResult ? 'Рассчитанные концентрации' : result ? 'Условия следующего расчёта · прежний результат сохранён' : 'Подготовленный участок'}</span>{showingResult && result ? <h2 id="result-title">Результат расчёта{comparison ? ` · ${activeScenario}` : variant && !hasB && !incompatibleDraft ? ' · А (Б ещё не рассчитан)' : ''}</h2> : <h2>{mode === 'river' ? reach?.name ?? 'Загрузка участка…' : 'Условный участок'}</h2>}<p>{showingResult && result?.reach_id ? String(result.reach_metadata?.name ?? 'Реальное русло') : showingResult ? 'Синтетическая геометрия' : mode === 'river' ? 'Реальная геометрия · сценарный источник' : 'Геометрия и параметры — синтетические'}</p></div></div>
          {showingResult && result && values ? <aside className="map-inspector" inert={profileOpen || parametersOpen} aria-label="Концентрация и выбранный сегмент">
            {!profileOpen && concentrationLegend}
            <div className="simulation-selection"><label htmlFor="simulation-segment">Расчётный сегмент</label><select id="simulation-segment" value={selected} onChange={event => setSelected(Number(event.target.value))}>{result.distances_m.map((distance, index) => <option key={index} value={index}>{index + 1} · {format(distance, 0)} м</option>)}</select><p aria-live={playing ? 'off' : 'polite'}><strong data-testid="selected-concentration">{format(values[selected], 4)} мг/л</strong><span>{format(result.distances_m[selected], 0)} м от источника · {formatTime(shownHours)}</span></p></div>
            {valuesA && valuesB && <dl className="comparison-values" aria-label="Сравнение выбранного сегмента"><div><dt>А</dt><dd data-testid="comparison-a">{format(valuesA[selected], 4)} мг/л</dd></div><div><dt>Б</dt><dd data-testid="comparison-b">{format(valuesB[selected], 4)} мг/л</dd></div><div><dt>Б − А</dt><dd data-testid="comparison-delta">{format(valuesB[selected] - valuesA[selected], 4)} мг/л</dd></div></dl>}
            <button className="profile-toggle" aria-controls="model-profile" aria-expanded={profileOpen} onClick={() => setProfileOpen(value => !value)}>{profileOpen ? 'Свернуть профиль' : 'Профиль и показатели'}<span aria-hidden="true">{profileOpen ? '−' : '↗'}</span></button>
          </aside> : !pickingSource && !result ? <div className="map-start-hint"><strong>Увидеть распространение по руслу</strong><p>Запустите демонстрацию: 4 модельных часа, синтетическая нагрузка и параметры потока.</p><p>Выгрузка CSV доступна после завершения расчёта.</p><button type="button" disabled>Скачать C(x) CSV</button><button type="button" disabled>Скачать C(t) CSV</button></div> : null}
          {showingResult && result && values && <aside id="model-profile" className={`profile-drawer${profileOpen ? ' is-open' : ''}`} aria-label="Профиль и показатели" hidden={!profileOpen} inert={parametersOpen}>
            <div className="profile-drawer-heading"><h2>Профиль и показатели</h2>{profileOpen && concentrationLegend}<button className="profile-close" aria-label="Закрыть профиль" onClick={() => setProfileOpen(false)}>×</button></div>
            <div className="profile-tabs" role="group" aria-label="Вид графика"><button aria-pressed={profileView === 'space'} onClick={() => setProfileView('space')}>По расстоянию C(x)</button><button aria-pressed={profileView === 'time'} onClick={() => setProfileView('time')}>Во времени C(t)</button></div>
            {profileView === 'time' ? <TemporalProfile result={result} a={comparison ? baseline : null} b={comparison ? latestResult : null} distances={result.distances_m} selected={selected} onSelect={setSelected} onSeek={hour => { setPlaying(false); setTime(hour); }} background={result.inputs.background_mg_l} hour={shownHours} duration={result.inputs.duration_hours} scale={scale} /> : <section className="simulation-profile" aria-labelledby="profile-title"><h3 id="profile-title">Профиль концентрации по расстоянию</h3><p>Центры расчётных сегментов · {formatTime(shownHours)}</p><svg viewBox="0 0 760 235" role="img" aria-label="Расчётный профиль концентрации. Все значения доступны в таблице ниже."><path d="M85 25V195H735" fill="none" stroke="currentColor" />{valuesA && valuesB ? <><polyline data-testid="profile-a" points={profilePoints(valuesA)} fill="none" stroke="#2367a1" strokeWidth="3" /><polyline data-testid="profile-b" points={profilePoints(valuesB)} fill="none" stroke="#b54b35" strokeWidth="3" strokeDasharray="8 4" /></> : <polyline points={profile} fill="none" stroke="var(--accent)" strokeWidth="3" />}<text x="85" y="17">мг/л</text>{span === 0 ? <text x="75" y="114" textAnchor="end">{format(scale[0], 1)}</text> : <><text x="75" y="34" textAnchor="end">{format(scale[1], 1)}</text><text x="75" y="194" textAnchor="end">{format(scale[0], 1)}</text></>}<text x="85" y="220">0</text><text x="730" y="220" textAnchor="end">{format(result.inputs.length_m, 0)} м</text></svg>
              {comparison && <p className="profile-comparison-key"><span>А — сплошная синяя</span><span>Б — пунктирная терракотовая</span></p>}
              <details><summary>Таблица профиля</summary><div className="simulation-table"><table aria-label="Рассчитанный профиль"><thead><tr><th>Сегмент</th><th>Расстояние, м</th>{comparison ? <><th>А, мг/л</th><th>Б, мг/л</th><th>Б − А, мг/л</th></> : <th>Концентрация, мг/л</th>}</tr></thead><tbody>{result.distances_m.map((distance, index) => <tr key={index}><td>{index + 1}</td><td>{format(distance, 0)}</td>{valuesA && valuesB ? <><td>{format(valuesA[index], 4)}</td><td>{format(valuesB[index], 4)}</td><td>{format(valuesB[index] - valuesA[index], 4)}</td></> : <td>{format(values[index], 4)}</td>}</tr>)}</tbody></table></div></details>
            </section>}
            <ResultExports result={result} a={comparison ? baseline : null} b={comparison ? latestResult : null} hour={shownHours} selected={selected} />
            <p className="simulation-hint" data-testid="numerical-accuracy">{result.inputs.load_mode === 'finite' ? 'Короткие импульсы пригодны для качественной иллюстрации переноса. Количественную точность пика необходимо отдельно проверять уточнением пространственного и временного шагов. ' : 'Численная точность требует отдельной проверки уточнением пространственного и временного шагов. '}Допуск сохранения траектории не ограничивает погрешность численной схемы и неопределённость физических исходных данных.</p>
            <details className="model-explanation"><summary>Почему меняется окраска?</summary><p>При постоянном поступлении консервативного вещества за фронтом возникает плато: вещество не распадается, поток постоянно приносит его новую массу.</p><p>После окончания нагрузки область повышенной концентрации продолжает двигаться и растягиваться вдоль реки. Максимум может находиться ниже по течению, а ближние сегменты уже возвращаться к фону.</p><p>Меняется только концентрация поступающей воды; расход, скорость и геометрия постоянны. Закрытие водовыпуска и гидравлическая волна не рассчитываются. Толщина линии — условный знак, не рассчитанная ширина пятна.</p></details>
            <p className="simulation-hint">{comparison ? `Показатели сценария ${activeScenario}` : "Показатели расчёта"}</p><dl className="simulation-summary"><div><dt>Площадь сечения</dt><dd>{format(result.derived.area_m2)} м²</dd></div><div><dt>Нагрузка выпуска в активный период</dt><dd>{format(result.derived.load_kg_s, 4)} кг/с</dd></div><div><dt>Нагрузка сверх фона в активный период</dt><dd>{format(result.derived.excess_load_kg_s, 4)} кг/с</dd></div><div><dt>{result.inputs.load_mode === 'finite' ? 'Плато при неограниченном поступлении' : 'Установившаяся концентрация'}</dt><dd>{format(result.derived.steady_mg_l, 4)} мг/л</dd></div></dl>
            <p className="simulation-hint">L/u = {format(result.derived.travel_hours, 3)} ч — характерное время переноса, не точное время первого появления вещества. {result.inputs.load_mode === 'finite' ? 'Конечный период создаёт проходящий импульс; после его ухода концентрация возвращается к фону.' : 'Установившийся профиль постоянен вдоль участка.'}</p>
            <details className="simulation-used-inputs"><summary>Параметры показанного расчёта</summary><dl><div><dt>Режим нагрузки</dt><dd>{result.inputs.load_mode === 'finite' ? `Ограниченный период · ${format(result.inputs.load_duration_hours!, 6)} ч` : 'Постоянная нагрузка'}</dd></div>{fields.map(field => <div key={field.key}><dt>{field.label}</dt><dd>{format(result.inputs[field.key], 3)}</dd></div>)}</dl></details>
            <p className="simulation-hint" data-testid="temporal-resolution">{result.temporal_resolution ? <>Сохранено {result.temporal_resolution.saved_states} моментов из {result.temporal_resolution.reference_states} внутренних состояний. Погрешность временной интерполяции относительно внутренних состояний: до {format(100 * result.temporal_resolution.interpolation_relative_tolerance)}% амплитуды отклонения от фона в каждом сегменте, абсолютный порог {result.temporal_resolution.interpolation_absolute_tolerance_mg_l.toExponential()} мг/л. Максимальный внутренний шаг — {format(result.temporal_resolution.reference_max_step_seconds, 3)} с; промежуток сохранённых моментов — до {format(result.temporal_resolution.max_gap_seconds, 3)} с. Это оценка сохранения расчётной траектории, а не точности физической модели.</> : 'Точность временного разрешения для этого результата не указана. Между сохранёнными моментами используется линейная интерполяция.'}</p>
            <p className="simulation-result-origin">{result.reach_id ? `${String(result.reach_metadata?.name ?? 'Реальное русло')} · источник на ${format(result.source_distance_m ?? 0, 1)} м. Геометрия из документированного источника.` : 'Синтетическая геометрия.'} Нагрузка и гидрология заданы пользователем. Концентрации рассчитаны; проверка по наблюдениям не выполнена.</p>
          </aside>}
        </div>
        <footer className="model-timeline" aria-label="Управление модельным временем">
          <div className="timeline-buttons"><button disabled={!result} type="button" className="playback-button" onClick={() => { if (result && !playing && time >= clockResult!.inputs.duration_hours) setTime(0); setPlaying(value => !value); }}><span aria-hidden="true">{playing ? 'Ⅱ' : '▶'}</span>{playing ? 'Пауза' : 'Воспроизвести'}</button><div className="playback-speed"><label htmlFor="playback-speed">Скорость воспроизведения</label><select id="playback-speed" value={speed} disabled={!result} onChange={event => setSpeed(Number(event.target.value))}><option value="0.5">0,5×</option><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option></select></div></div>
          <div className="simulation-time"><label htmlFor="simulation-time">Время от начала сценария</label><output htmlFor="simulation-time">{formatTime(shownHours)}</output><div className="timeline-track"><input id="simulation-time" type="range" min={0} max={clockResult?.inputs.duration_hours ?? Number(draft.duration_hours)} step="any" value={time} disabled={!result} onChange={event => { setPlaying(false); setTime(Number(event.target.value)); }} aria-valuetext={formatTime(shownHours)} />{loadMarkers.map(({ item, label }) => <span key={label} className="load-end-marker" data-testid="load-end-marker" data-hour={loadEnd(item)} style={{ left: `${100 * loadEnd(item)! / item.inputs.duration_hours}%` }} title={`${label ? label + ' · ' : ''}Окончание нагрузки: ${format(loadEnd(item)!, 6)} ч`} aria-label={`${label ? label + ' · ' : ''}Окончание нагрузки: ${format(loadEnd(item)!, 6)} ч`} />)}</div><span>0 ч</span><span>{result ? `${format(result.inputs.duration_hours)} ч` : 'Ожидает расчёта'}</span></div>
          <p className="source-status" data-testid="source-status">{comparison && baseline && latestResult ? `А: ${sourceDescription(baseline)} · Б: ${sourceDescription(latestResult)}` : result ? sourceDescription(result) : ''}{loadMarkers.length > 0 && <span className="load-end-caption">{loadMarkers.map(({ item, label }) => `${label ? label + ' · ' : ''}конец ${format(loadEnd(item)!, 6).replace(/0+$/, '').replace(/,$/, '')} ч`).join(' / ')}</span>}</p>
          <p className="timeline-note">{result ? 'Линейная интерполяция рассчитанных моментов. Карта, профиль и числа синхронизированы.' : 'Сначала запустите расчёт. Воспроизведение начнётся по вашей команде.'}</p>
        </footer>
      </section>
    </div>
  </div>;
}
