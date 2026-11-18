import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { riverCoordinate } from './riverCoordinate';
import {
  calculateNetwork, draftFromInputs, equalInputs, inputsFromDraft, listNetworkSaved,
  loadNetworkPilot, loadNetworkSaved, sampleSeries, saveNetworkConditions, timeBracket,
  type Coordinate, type NetworkDraft, type NetworkInputs, type NetworkPilot, type NetworkResult,
  type NetworkSavedSummary, type RiverNetwork,
} from './riverNetworkData';
import './riverNetwork.css';

const fmt = (value: number, digits = 3) => value.toLocaleString('ru-RU', { maximumFractionDigits: digits, useGrouping: false });
const point = ([lon, lat]: Coordinate): L.LatLngTuple => [lat, lon];
const nameOf = (network: RiverNetwork, id: string) => network.reaches.find(reach => reach.id === id)?.name ?? id;
const colors = [[53, 116, 140], [75, 155, 156], [136, 189, 149], [233, 201, 99], [219, 133, 76], [168, 63, 54]];
function color(value: number, scale: [number, number]) {
  const index = Math.max(0, Math.min(1, scale[0] === scale[1] ? 0 : (value - scale[0]) / (scale[1] - scale[0]))) * (colors.length - 1);
  const left = Math.floor(index), right = Math.min(colors.length - 1, left + 1), weight = index - left;
  return `rgb(${colors[left].map((channel, i) => Math.round(channel + (colors[right][i] - channel) * weight)).join(',')})`;
}
type Selection = { reachId: string; cell: number };
type Checkpoint = { id: string; name: string; label: string; coordinate: Coordinate; values: number[]; selection?: Selection };

function checkpointData(result: NetworkResult): Checkpoint[] {
  const source = result.inputs.source;
  const junction = result.network.nodes.find(node => result.network.reaches.filter(reach => reach.to_node === node.id).length > 1)!;
  const beforeReach = result.network.reaches.find(reach => reach.id === source.reach_id && reach.to_node === junction.id)
    ?? result.network.reaches.find(reach => reach.to_node === junction.id)!;
  const before = result.reaches.find(reach => reach.id === beforeReach.id)!;
  const beforeCell = before.distances_m.length - 1;
  const afterReach = result.network.reaches.find(reach => reach.from_node === junction.id)!;
  const after = result.reaches.find(reach => reach.id === afterReach.id)!;
  let lastReach = afterReach;
  for (let i = 0; i < result.network.reaches.length; i++) {
    const next = result.network.reaches.find(item => item.from_node === lastReach.to_node);
    if (!next) break;
    lastReach = next;
  }
  const last = result.reaches.find(item => item.id === lastReach.id)!;
  const lastCell = last.distances_m.length - 1;
  return [
    { id: 'upstream', name: 'Выше слияния', label: `${nameOf(result.network, before.id)} · ${fmt(before.distances_m[beforeCell], 1)} м`, coordinate: riverCoordinate(beforeReach.geometry.coordinates, beforeReach.distances_m, before.distances_m[beforeCell]), values: before.concentrations_mg_l.map(row => row[beforeCell]), selection: { reachId: before.id, cell: beforeCell } },
    { id: 'below', name: 'Ниже слияния', label: `${nameOf(result.network, after.id)} · ${fmt(after.distances_m[0], 1)} м`, coordinate: riverCoordinate(afterReach.geometry.coordinates, afterReach.distances_m, after.distances_m[0]), values: after.concentrations_mg_l.map(row => row[0]), selection: { reachId: after.id, cell: 0 } },
    { id: 'further', name: 'Ниже по течению', label: `${nameOf(result.network, last.id)} · ${fmt(last.distances_m[lastCell], 1)} м`, coordinate: riverCoordinate(lastReach.geometry.coordinates, lastReach.distances_m, last.distances_m[lastCell]), values: last.concentrations_mg_l.map(row => row[lastCell]), selection: { reachId: last.id, cell: lastCell } },
  ];
}

function NetworkMap({ network, visible, result, time, source, selection, checkpoints, onSelect, onTileError }: {
  network: RiverNetwork; visible: boolean; result: NetworkResult | null; time: number; source: Coordinate | null;
  selection: Selection | null; checkpoints: Checkpoint[]; onSelect: (selection: Selection) => void; onTileError: () => void;
}) {
  const element = useRef<HTMLDivElement>(null), map = useRef<L.Map | null>(null);
  const cellLines = useRef<{ layer: L.Polyline; reach: string; cell: number }[]>([]);
  const callback = useRef({ onSelect, onTileError });
  callback.current = { onSelect, onTileError };
  const fit = useRef(() => {});
  useEffect(() => {
    if (!element.current) return;
    const instance = L.map(element.current, { zoomControl: false, zoomSnap: .25, scrollWheelZoom: false, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false });
    map.current = instance;
    L.control.zoom({ zoomInTitle: 'Увеличить масштаб', zoomOutTitle: 'Уменьшить масштаб' }).addTo(instance);
    instance.attributionControl.setPrefix(false);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).on('tileerror', () => callback.current.onTileError()).addTo(instance);
    const bounds = L.latLngBounds(network.reaches.flatMap(reach => reach.geometry.coordinates.map(point)));
    instance.setView(bounds.getCenter(), 15);
    fit.current = () => {
      if (!element.current?.clientWidth || !element.current.clientHeight) return;
      instance.invalidateSize({ animate: false, pan: false });
      instance.fitBounds(bounds, { padding: [34, 34], animate: false });
    };
    let fitted = false;
    const resize = new ResizeObserver(() => {
      if (!element.current?.clientWidth || !element.current.clientHeight) return;
      instance.invalidateSize({ animate: false, pan: false });
      if (!fitted) { fit.current(); fitted = true; }
    });
    resize.observe(element.current);
    for (const reach of network.reaches) {
      const layer = L.polyline(reach.geometry.coordinates.map(point), { color: '#3f6967', opacity: .4, weight: 14, smoothFactor: 0 }).addTo(instance);
      const tooltip = document.createElement('span'); tooltip.textContent = reach.name ?? reach.id;
      layer.bindTooltip(tooltip);
      layer.getElement()?.setAttribute('data-network-reach', reach.id);
      const position = reach.length_m * .55;
      const a = riverCoordinate(reach.geometry.coordinates, reach.distances_m, Math.max(0, position - 10));
      const b = riverCoordinate(reach.geometry.coordinates, reach.distances_m, Math.min(reach.length_m, position + 10));
      const angle = Math.atan2((b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), b[1] - a[1]) * 180 / Math.PI;
      const arrow = document.createElement('span'); arrow.textContent = '↑'; arrow.style.transform = `rotate(${angle}deg)`;
      L.marker(point(riverCoordinate(reach.geometry.coordinates, reach.distances_m, position)), { icon: L.divIcon({ className: 'network-direction', html: arrow, iconSize: [24, 24], iconAnchor: [12, 12] }), interactive: false, keyboard: false }).addTo(instance);
    }
    for (const node of network.nodes) {
      const marker = L.circleMarker(point(node.coordinate), { radius: node.kind === 'junction' ? 7 : 4, fillColor: '#fff', fillOpacity: 1, color: '#34594d', weight: 2 }).addTo(instance);
      const label = document.createElement('span'); label.textContent = node.kind === 'junction' ? 'Слияние' : node.kind === 'outlet' ? 'Выход сети' : node.kind === 'headwater' ? 'Вход сети' : 'Соединение участков';
      marker.bindTooltip(label);
      marker.getElement()?.setAttribute('data-network-node', node.id);
    }
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(instance);
    return () => { resize.disconnect(); instance.remove(); map.current = null; };
  }, [network]);
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const group = L.layerGroup().addTo(instance);
    cellLines.current = [];
    if (result) for (const reach of result.reaches) reach.segment_geometries.forEach((geometry, cell) => {
      const layer = L.polyline(geometry.coordinates.map(point), { color: '#35748c', weight: 9, smoothFactor: 0, lineCap: 'round' }).addTo(group);
      layer.getElement()?.setAttribute('data-network-cell', `${reach.id}:${cell}`);
      layer.on('click', () => callback.current.onSelect({ reachId: reach.id, cell }));
      cellLines.current.push({ layer, reach: reach.id, cell });
    });
    return () => { group.remove(); cellLines.current = []; };
  }, [network, result]);
  useEffect(() => {
    if (!result) return;
    const bracket = timeBracket(result.times_hours, time);
    for (const item of cellLines.current) {
      const data = result.reaches.find(reach => reach.id === item.reach)!;
      const a = data.concentrations_mg_l[bracket.left][item.cell], b = data.concentrations_mg_l[bracket.right][item.cell];
      const value = a + (b - a) * bracket.weight;
      item.layer.setStyle({ color: color(value, result.scale_mg_l), weight: item.reach === selection?.reachId && item.cell === selection.cell ? 16 : 9 });
      item.layer.getElement()?.setAttribute('data-concentration-mg-l', String(value));
    }
  }, [result, time, selection]);
  useEffect(() => {
    if (!map.current || !source) return;
    const marker = L.marker(point(source), { icon: L.divIcon({ className: 'network-source-pin', html: '<span>С</span>', iconSize: [30, 38], iconAnchor: [15, 33] }), keyboard: false }).addTo(map.current);
    marker.getElement()?.setAttribute('data-testid', 'river-network-source-pin');
    return () => { marker.remove(); };
  }, [network, source]);
  useEffect(() => {
    if (!map.current) return;
    const group = L.layerGroup().addTo(map.current);
    checkpoints.forEach((checkpoint, index) => {
      L.marker(point(checkpoint.coordinate), { icon: L.divIcon({ className: 'network-checkpoint-marker', html: String(index + 1), iconSize: [22, 22], iconAnchor: index === 0 ? [30, 25] : index === 1 ? [-8, -5] : [11, -5] }), interactive: false, keyboard: false }).addTo(group);
    });
    return () => { group.remove(); };
  }, [network, checkpoints]);
  useEffect(() => { if (visible) map.current?.invalidateSize({ animate: false, pan: false }); }, [visible]);
  return <div className="network-map-wrap"><div ref={element} className="network-map" data-testid="river-network-map" role="region" aria-label="Направленная сеть Воронежа и Кузьминки" /><button type="button" className="network-fit" onClick={() => fit.current()}>Вся сеть</button></div>;
}

function Numeric({ label, unit, value, onChange }: { label: string; unit: string; value: string; onChange: (value: string) => void }) {
  return <label className="network-field"><span>{label}</span><span className="network-number"><input type="number" step="any" inputMode="decimal" aria-label={label} value={value} onChange={event => onChange(event.target.value)} /><span>{unit}</span></span></label>;
}

function HistoryChart({ result, values, time, title }: { result: NetworkResult; values: number[]; time: number; title: string }) {
  const bracket = timeBracket(result.times_hours, time);
  const [min, max] = result.scale_mg_l;
  const x = (hour: number) => 40 + hour / result.inputs.duration_hours * 266;
  const y = (value: number) => 114 - (max === min ? 0 : (value - min) / (max - min)) * 94;
  const current = sampleSeries(values, bracket);
    return <div className="network-history" data-testid="river-network-chart" data-time-hours={time} data-concentration-mg-l={current}>
    <p><strong>{title}</strong><output>{fmt(current)} мг/л</output></p>
    <svg viewBox="0 0 326 147" role="img" aria-label={`Концентрация по времени · ${title}`}>
      <path d="M40 20H306M40 67H306M40 114H306" className="network-chart-grid" />
      <path d={`M${x(time)} 20V114`} className="network-chart-cursor" />
      <polyline points={result.times_hours.map((hour, i) => `${x(hour)},${y(values[i])}`).join(' ')} className="network-chart-line" />
      <circle cx={x(time)} cy={y(current)} r="4" className="network-chart-dot" />
      <text x="1" y="12">мг/л</text><text x="34" y="24" textAnchor="end">{fmt(max)}</text><text x="34" y="118" textAnchor="end">{fmt(min)}</text>
      <text x="40" y="136">0</text><text x="306" y="136" textAnchor="end">{fmt(result.inputs.duration_hours)} ч</text>
    </svg>
  </div>;
}

export default function RiverNetwork({ visible = true }: { visible?: boolean }) {
  const [pilot, setPilot] = useState<NetworkPilot | null>(null), [draft, setDraft] = useState<NetworkDraft | null>(null);
  const [attempt, setAttempt] = useState(0), [loadError, setLoadError] = useState(''), [error, setError] = useState('');
  const [running, setRunning] = useState(false), [result, setResult] = useState<NetworkResult | null>(null);
  const [time, setTime] = useState(0), [playing, setPlaying] = useState(false), [speed, setSpeed] = useState(1);
  const [selection, setSelection] = useState<Selection | null>(null), [checkpointId, setCheckpointId] = useState('below');
  const [tilesFailed, setTilesFailed] = useState(false);
  const [name, setName] = useState('Условия сброса в речной сети'), [saved, setSaved] = useState<NetworkSavedSummary[]>([]), [savedId, setSavedId] = useState('');
  const [savedTotal, setSavedTotal] = useState(0);
  const [saving, setSaving] = useState(false), [saveMessage, setSaveMessage] = useState('');
  const runController = useRef<AbortController | null>(null), storageController = useRef<AbortController | null>(null);
  const timeRef = useRef(time);
  timeRef.current = time;
  const selectCell = useCallback((value: Selection) => { setSelection(value); setCheckpointId(''); }, []);
  const tileError = useCallback(() => setTilesFailed(true), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoadError('');
    loadNetworkPilot(controller.signal).then(next => { if (!controller.signal.aborted) { setPilot(next); setDraft(draftFromInputs(next.defaults)); } }).catch(reason => { if (!controller.signal.aborted) setLoadError(reason instanceof TypeError ? 'Нет связи с сервером. Повторите загрузку.' : reason.message); });
    return () => controller.abort();
  }, [attempt]);
  useEffect(() => {
    const controller = new AbortController();
    storageController.current = controller;
    setSaveMessage('Загружаем список условий…');
    listNetworkSaved(controller.signal).then(page => {
      if (!controller.signal.aborted && storageController.current === controller) { setSaved(page.items); setSavedTotal(page.total); setSaveMessage(''); }
    }).catch(reason => {
      if (!controller.signal.aborted) setSaveMessage(reason instanceof TypeError ? 'Не удалось загрузить список. Проверьте соединение.' : reason.message);
    });
    return () => controller.abort();
  }, []);
  useEffect(() => () => { runController.current?.abort(); storageController.current?.abort(); }, []);
  useEffect(() => { if (!visible) setPlaying(false); }, [visible]);
  useEffect(() => {
    if (!result || !playing || !visible) return;
    const started = performance.now(), initial = timeRef.current;
    let animation = 0;
    const advance = (now: number) => {
      const next = Math.min(result.inputs.duration_hours, initial + (now - started) / 1000 * .1 * speed);
      setTime(next);
      if (next === result.inputs.duration_hours) setPlaying(false); else animation = requestAnimationFrame(advance);
    };
    animation = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(animation);
  }, [playing, result, speed, visible]);
  const checkpoints = useMemo(() => result ? checkpointData(result) : [], [result]);
  let draftInputs: NetworkInputs | null = null;
  try { if (pilot && draft) draftInputs = inputsFromDraft(draft, pilot.network); } catch { /* Inline validation appears when the user runs or saves. */ }
  const stale = !!result && (!draftInputs || !equalInputs(draftInputs, result.inputs));
  const currentCheckpoint = checkpoints.find(item => item.id === checkpointId);
  const selectedReach = result?.reaches.find(reach => reach.id === selection?.reachId);
  const chartValues = currentCheckpoint?.values ?? (selectedReach && selection ? selectedReach.concentrations_mg_l.map(row => row[selection.cell]) : null);
  const chartTitle = currentCheckpoint?.name ?? (selectedReach && selection ? `${nameOf(result!.network, selectedReach.id)} · ${fmt(selectedReach.distances_m[selection.cell], 1)} м` : '');
  const sourceCoordinate = useMemo(() => {
    if (result) return result.source_coordinate;
    if (!pilot || !draft) return null;
    const reach = pilot.network.reaches.find(item => item.id === draft.sourceReach);
    const distance = Number(draft.distance);
    return reach && draft.distance.trim() && Number.isFinite(distance) && distance >= 0 && distance <= reach.length_m ? riverCoordinate(reach.geometry.coordinates, reach.distances_m, distance) : null;
  }, [pilot, draft, result]);
  function edit(change: Partial<NetworkDraft>) {
    storageController.current?.abort();
    setSaving(false); setDraft(current => current ? { ...current, ...change } : null); setPlaying(false); setSaveMessage('');
  }
  function cancelStorage() {
    storageController.current?.abort();
    setSaving(false);
    setSaveMessage('');
  }
  async function refreshSaved(append = false) {
    const controller = new AbortController();
    storageController.current?.abort(); storageController.current = controller;
    setSaving(true); setSaveMessage('');
    try {
      const page = await listNetworkSaved(controller.signal, append ? saved.length : 0);
      if (!controller.signal.aborted) {
        setSaved(append ? [...saved, ...page.items] : page.items);
        setSavedTotal(page.total);
      }
    } catch (reason) { if (!controller.signal.aborted) setSaveMessage((reason as Error).message); }
    finally { if (storageController.current === controller) setSaving(false); }
  }
  async function run(event: FormEvent) {
    event.preventDefault();
    if (!pilot || !draft) return;
    let inputs: NetworkInputs;
    try { inputs = inputsFromDraft(draft, pilot.network); } catch (reason) { setError((reason as Error).message); return; }
    runController.current?.abort();
    const controller = new AbortController(); runController.current = controller;
    setRunning(true); setPlaying(false); setError('');
    try {
      const next = await calculateNetwork(pilot.network, inputs, controller.signal);
      if (runController.current !== controller || controller.signal.aborted) return;
      setResult(next); setTime(0); setSelection(null); setCheckpointId('below');
    } catch (reason) { if (!controller.signal.aborted && runController.current === controller) setError(reason instanceof TypeError ? 'Нет связи с сервером. Повторите расчёт.' : (reason as Error).message); }
    finally { if (runController.current === controller) setRunning(false); }
  }
  async function saveConditions() {
    if (!draft || !pilot) return;
    const controller = new AbortController(); storageController.current?.abort(); storageController.current = controller;
    setSaving(true); setSaveMessage('');
    try {
      await saveNetworkConditions(pilot.network, inputsFromDraft(draft, pilot.network), name, controller.signal);
      if (controller.signal.aborted) return;
      const page = await listNetworkSaved(controller.signal);
      if (controller.signal.aborted) return;
      setSaved(page.items); setSavedTotal(page.total); setSaveMessage('Условия сохранены.');
    } catch (reason) { if (!controller.signal.aborted) setSaveMessage((reason as Error).message); }
    finally { if (storageController.current === controller) setSaving(false); }
  }
  async function applySaved() {
    if (!pilot || !savedId) return;
    const controller = new AbortController(); storageController.current?.abort(); storageController.current = controller;
    setSaving(true); setSaveMessage('');
    try {
      const next = await loadNetworkSaved(pilot.network, savedId, controller.signal);
      if (controller.signal.aborted) return;
      runController.current?.abort(); setRunning(false); setPlaying(false); setDraft(draftFromInputs(next.conditions)); setName(next.name);
      setSaveMessage('Условия открыты. Нажмите «Рассчитать сеть» для нового результата.');
    } catch (reason) { if (!controller.signal.aborted) setSaveMessage((reason as Error).message); }
    finally { if (storageController.current === controller) setSaving(false); }
  }
  if (!pilot || !draft) return <section className="river-network"><h1>Речная сеть</h1><p role={loadError ? 'alert' : 'status'}>{loadError || 'Загружаем направленную речную сеть…'}</p>{loadError && <button onClick={() => setAttempt(value => value + 1)}>Повторить загрузку</button>}</section>;
  const bracket = result ? timeBracket(result.times_hours, time) : null;
  return <section className="river-network" data-testid="river-network">
    <header className="network-header"><div><h1>Речная сеть</h1><p>{pilot.network.name ?? 'Воронеж и Кузьминка'}</p></div><button className="network-primary" type="submit" form="network-conditions">{running ? 'Пересчитать сеть' : 'Рассчитать сеть'}</button></header>
    <p className="network-origin">Геометрия OpenStreetMap · гидравлика и нагрузка учебные · концентрации рассчитаны · калибровка по наблюдениям отсутствует</p>
    <div className="network-status" aria-live="polite">{running && <span>Выполняется расчёт… <button type="button" onClick={() => { runController.current?.abort(); setRunning(false); }}>Отменить расчёт</button></span>}{stale && <span data-testid="river-network-stale">Условия изменены. Карта и графики показывают предыдущий расчёт.</span>}</div>
    {error && <p className="network-error" role="alert">{error}</p>}
    <div className="network-workspace">
      <div className="network-plan">
        <NetworkMap network={pilot.network} visible={visible} result={result} time={time} source={sourceCoordinate} selection={selection} checkpoints={checkpoints} onSelect={selectCell} onTileError={tileError} />
        {tilesFailed && <p className="network-tile-notice">Подложка недоступна. Расчётная сеть и геометрия выпуска доступны.</p>}
        <div className="network-timeline">
          <button type="button" aria-label={playing ? 'Приостановить воспроизведение сети' : 'Воспроизвести сеть'} disabled={!result} onClick={() => { if (!playing && result && time >= result.inputs.duration_hours) setTime(0); setPlaying(!playing); }}>{playing ? 'Ⅱ' : '▶'}</button>
          <label><span>Время <output>{fmt(time)} / {result ? fmt(result.inputs.duration_hours) : '—'} ч</output></span><input data-testid="river-network-time" aria-label="Время речной сети" aria-valuetext={`${fmt(time)} ч`} type="range" min="0" max={result?.inputs.duration_hours ?? 1} step="any" disabled={!result} value={time} onChange={event => { setPlaying(false); setTime(Number(event.target.value)); }} /></label>
          <label className="network-speed"><span>Скорость</span><select aria-label="Скорость воспроизведения сети" value={speed} onChange={event => setSpeed(Number(event.target.value))}><option value={.25}>0,25×</option><option value={1}>1×</option><option value={4}>4×</option></select></label>
        </div>
        <div className="network-scale" data-testid="river-network-scale"><strong>Концентрация, мг/л</strong><span>{result ? fmt(result.scale_mg_l[0]) : '—'}</span><div style={{ background: `linear-gradient(90deg,${colors.map(rgb => `rgb(${rgb.join(',')})`).join(',')})` }} /><span>{result ? fmt(result.scale_mg_l[1]) : '—'}</span></div>
        <p className="network-condition-note" style={{ padding: '0 12px 8px', margin: 0 }}>Полное смешение в узле; толщина линии условная и не описывает ширину загрязнения.</p>
      </div>
      <aside className="network-observer" aria-label="Контроль концентрации">
        <h2>Контрольные створы</h2>
        {result && bracket ? <>
          <div className="network-checkpoints">{checkpoints.map((checkpoint, index) => <button type="button" key={checkpoint.id} data-testid={`network-checkpoint-${checkpoint.id}`} data-concentration-mg-l={sampleSeries(checkpoint.values, bracket)} aria-pressed={checkpointId === checkpoint.id} onClick={() => { setCheckpointId(checkpoint.id); setSelection(checkpoint.selection ?? null); }}><span>{index + 1} · {checkpoint.name}<small>{checkpoint.label}</small></span><strong>{fmt(sampleSeries(checkpoint.values, bracket))}<small>мг/л</small></strong></button>)}</div>
          {chartValues && <HistoryChart result={result} values={chartValues} time={time} title={chartTitle} />}
          <label className="network-field"><span>Сегмент на карте</span><select aria-label="Сегмент речной сети" value={selection ? `${selection.reachId}:${selection.cell}` : ''} onChange={event => { const [reachId, cell] = event.target.value.split(':'); selectCell({ reachId, cell: Number(cell) }); }}><option value="" disabled>Выберите сегмент</option>{result.reaches.flatMap(reach => reach.distances_m.map((distance, cell) => <option key={`${reach.id}:${cell}`} value={`${reach.id}:${cell}`}>{nameOf(pilot.network, reach.id)} · {fmt(distance, 1)} м</option>))}</select></label>
          <details className="network-balance"><summary>Баланс массы</summary><p>Изменение массы относительно фона, кг</p><dl>{(['input', 'output', 'stored', 'residual'] as const).map((key, i) => <div key={key}><dt>{['Поступило', 'Вышло', 'В сети', 'Невязка'][i]}</dt><dd>{fmt(sampleSeries(result.balance_kg[key], bracket), 6)}</dd></div>)}</dl></details>
        </> : <p className="network-empty">Задайте сброс и выполните расчёт. Карта и створы покажут концентрацию в один и тот же момент времени.</p>}
      </aside>
    </div>
    <form id="network-conditions" onSubmit={run} noValidate className="network-conditions">
      <div className="network-source-heading"><h2>Источник сброса</h2><label><span>Учебный режим</span><select aria-label="Учебный режим сброса" value={draft.continuous ? 'continuous' : 'pulse'} onChange={event => edit({ continuous: event.target.value === 'continuous' })}><option value="pulse">Кратковременный сброс</option><option value="continuous">Непрерывный сброс</option></select></label></div>
      <div className="network-source-fields">
        <label className="network-field"><span>Участок источника</span><select aria-label="Участок источника" value={draft.sourceReach} onChange={event => edit({ sourceReach: event.target.value })}>{pilot.network.reaches.map(reach => <option key={reach.id} value={reach.id}>{reach.name ?? reach.id}</option>)}</select></label>
        <Numeric label="Положение источника" unit="м" value={draft.distance} onChange={distance => edit({ distance })} />
        <Numeric label="Расход сброса" unit="м³/с" value={draft.flow} onChange={flow => edit({ flow })} />
        <Numeric label="Концентрация сброса" unit="мг/л" value={draft.concentration} onChange={concentration => edit({ concentration })} />
        {!draft.continuous && <Numeric label="Длительность сброса" unit="ч" value={draft.loadDuration} onChange={loadDuration => edit({ loadDuration })} />}
      </div>
      <p className="network-condition-note">Сценарный источник: расстояние по течению от начала участка, 0–{fmt(pilot.network.reaches.find(reach => reach.id === draft.sourceReach)!.length_m, 1)} м. После окончания повышенной нагрузки расход сохраняется, поступающая вода возвращается к фону. После изменения условий запустите расчёт.</p>
      <details className="network-hydraulics"><summary>Фон, горизонт и гидравлические параметры</summary><div className="network-hydraulic-fields">
        <fieldset><legend>Общие условия</legend><Numeric label="Фоновая концентрация сети" unit="мг/л" value={draft.background} onChange={background => edit({ background })} /><Numeric label="Горизонт расчёта сети" unit="ч" value={draft.duration} onChange={duration => edit({ duration })} /></fieldset>
        {draft.headwaters.map((head, i) => <fieldset key={head.node_id}><legend>{nameOf(pilot.network, pilot.network.reaches.find(reach => reach.from_node === head.node_id)!.id)}</legend><Numeric label={`Расход на входе ${i + 1}`} unit="м³/с" value={head.flow} onChange={flow => edit({ headwaters: draft.headwaters.map((item, j) => i === j ? { ...item, flow } : item) })} /><Numeric label={`Концентрация на входе ${i + 1}`} unit="мг/л" value={head.concentration} onChange={concentration => edit({ headwaters: draft.headwaters.map((item, j) => i === j ? { ...item, concentration } : item) })} /></fieldset>)}
        {draft.hydraulics.map((hydraulic, i) => <fieldset key={hydraulic.reach_id}><legend>{nameOf(pilot.network, hydraulic.reach_id)}</legend><Numeric label={`Скорость · ${nameOf(pilot.network, hydraulic.reach_id)}`} unit="м/с" value={hydraulic.velocity} onChange={velocity => edit({ hydraulics: draft.hydraulics.map((item, j) => i === j ? { ...item, velocity } : item) })} /><Numeric label={`Дисперсия · ${nameOf(pilot.network, hydraulic.reach_id)}`} unit="м²/с" value={hydraulic.dispersion} onChange={dispersion => edit({ hydraulics: draft.hydraulics.map((item, j) => i === j ? { ...item, dispersion } : item) })} /></fieldset>)}
      </div></details>
    </form>
    <details className="network-saved">
      <summary>Сохранённые условия сети</summary>
      <div className="network-storage">
        <label className="network-field"><span>Название условий сети</span><input value={name} maxLength={120} onChange={event => { cancelStorage(); setName(event.target.value); }} /></label>
        <button type="button" disabled={saving} onClick={() => void saveConditions()}>Сохранить условия сети</button>
        <label className="network-field"><span>Сохранённый сценарий сети</span><select aria-label="Сохранённый сценарий сети" value={savedId} onChange={event => { cancelStorage(); setSavedId(event.target.value); }}><option value="">Выберите запись</option>{saved.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
        <button type="button" disabled={saving || !savedId} onClick={() => void applySaved()}>Открыть условия сети</button>
      </div>
      <button type="button" className="network-refresh-saved" disabled={saving} onClick={() => void refreshSaved()}>Обновить список условий</button>
      {saved.length < savedTotal && <button type="button" className="network-refresh-saved" disabled={saving} onClick={() => void refreshSaved(true)}>Ещё сохранённые</button>}
      {savedTotal > 0 && <p>Показано {saved.length} из {savedTotal}</p>}
      <p role="status">{saveMessage}</p>
    </details>
  </section>;
}
