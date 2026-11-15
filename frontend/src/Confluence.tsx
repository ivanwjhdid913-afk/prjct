import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  branchIds, loadPilot, resultCsv, sameInputs, segments, simulate, toDraft, toInputs,
  type BranchId, type Draft, type DraftInlet, type Geometry, type InletId, type Pilot, type Point, type Result, type Segment,
} from './confluenceData';
import './confluence.css';

const branchLabel: Record<BranchId, string> = { a: 'Приток A', b: 'Приток B', out: 'Ниже узла' };
const branchMark: Record<BranchId, string> = { a: 'A', b: 'B', out: 'Выход' };
const palette = ['#35748c', '#4b9b9c', '#88bd95', '#e9c963', '#db854c', '#a83f36'];
const playbackHoursPerSecond = .2;
const format = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3, useGrouping: false });
const distanceFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1, useGrouping: false });
const fmt = (value: number) => format.format(value);
const mass = (value: number) => value !== 0 && Math.abs(value) < .001 ? value.toExponential(2).replace('.', ',') : fmt(value);
const segmentRange = (segment: Segment) => `${distanceFormat.format(segment.start)}–${distanceFormat.format(segment.end)} м`;
const latLng = ([east, north]: Point): L.LatLngTuple => [north, east];

function colorAt(value: number, [min, max]: Result['scale_mg_l']): string {
  const ratio = max === min ? 0 : (value - min) / (max - min);
  return palette[Math.round(Math.min(1, Math.max(0, ratio)) * (palette.length - 1))];
}

type MapProps = {
  geometry: Geometry; visible: boolean; result: Result | null; frame: number; selected: number | null;
  onNode: () => void; onSegment: (index: number) => void;
};

function ConfluenceMap({ geometry, visible, result, frame, selected, onNode, onSegment }: MapProps) {
  const target = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const nodeButton = useRef<HTMLButtonElement | null>(null);
  const lines = useRef<{ layer: L.Polyline; branch: BranchId; index: number }[]>([]);
  const fitView = useRef<() => void>(() => {});
  const choose = useRef({ onNode, onSegment });
  choose.current = { onNode, onSegment };

  useEffect(() => {
    if (!target.current) return;
    const instance = L.map(target.current, {
      crs: L.CRS.Simple, attributionControl: false, zoomControl: false, zoomSnap: .1, zoomDelta: .5,
      minZoom: -8, maxZoom: 2, scrollWheelZoom: false, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false,
    });
    map.current = instance;
    const bounds = L.latLngBounds(geometry.branches.flatMap(branch => branch.coordinates_m.map(latLng)));
    const fit = () => {
      if (!target.current?.clientWidth || !target.current.clientHeight) return;
      instance.invalidateSize({ animate: false, pan: false });
      instance.fitBounds(bounds, { padding: [28, 36], animate: false });
    };
    fitView.current = fit;
    // A hidden instance still needs an initial view before Leaflet adds layers.
    instance.setView(bounds.getCenter(), -3, { animate: false });
    fit();

    const gridPane = instance.createPane('confluence-grid');
    gridPane.style.zIndex = '210';
    gridPane.style.pointerEvents = 'none';
    const gridBounds = bounds.pad(.55);
    const gridStyle: L.PolylineOptions = { pane: 'confluence-grid', interactive: false, color: '#b2c1b4', weight: 1, opacity: .42 };
    for (let x = Math.ceil(gridBounds.getWest() / 200) * 200; x <= gridBounds.getEast(); x += 200) {
      L.polyline([[gridBounds.getSouth(), x], [gridBounds.getNorth(), x]], gridStyle).addTo(instance);
    }
    for (let y = Math.ceil(gridBounds.getSouth() / 200) * 200; y <= gridBounds.getNorth(); y += 200) {
      L.polyline([[y, gridBounds.getWest()], [y, gridBounds.getEast()]], gridStyle).addTo(instance);
    }
    for (const branch of geometry.branches) {
      const line = L.polyline(branch.coordinates_m.map(latLng), { weight: 14, color: '#356760', opacity: .35, smoothFactor: 0, interactive: false }).addTo(instance);
      line.getElement()?.setAttribute('data-confluence-branch', branch.id);
      const label = document.createElement('span');
      label.textContent = branchMark[branch.id];
      const endpoint = branch.id === 'out' ? branch.coordinates_m[branch.coordinates_m.length - 1] : branch.coordinates_m[0];
      L.marker(latLng(endpoint), {
        icon: L.divIcon({ className: 'confluence-map-label', html: label, iconSize: [44, 24], iconAnchor: [22, 33] }), interactive: false, keyboard: false,
      }).addTo(instance);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'confluence-map-node-button';
    button.setAttribute('aria-label', 'Узел слияния');
    button.title = 'Узел слияния';
    button.addEventListener('click', () => choose.current.onNode());
    L.marker(latLng(geometry.junction_m), {
      icon: L.divIcon({ className: 'confluence-map-node', html: button, iconSize: [44, 44] }), keyboard: false, zIndexOffset: 400,
    }).addTo(instance);
    nodeButton.current = button;
    L.control.scale({ imperial: false, maxWidth: 95, position: 'bottomleft' }).addTo(instance);
    const resize = new ResizeObserver(fit);
    resize.observe(target.current);
    return () => {
      resize.disconnect();
      instance.remove();
      map.current = null;
      nodeButton.current = null;
    };
  }, [geometry]);

  const cells = result?.grid.cells;
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const group = L.layerGroup().addTo(instance);
    lines.current = geometry.branches.flatMap(branch => segments(branch, cells?.[branch.id] ?? 1).map((segment, index) => {
      const interactive = !!cells && branch.id === 'out';
      const layer = L.polyline(segment.path.map(latLng), {
        weight: 10, color: palette[0], smoothFactor: 0, lineCap: 'butt', interactive, bubblingMouseEvents: false,
      }).addTo(group);
      layer.getElement()?.setAttribute('data-confluence-segment', segment.id);
      if (interactive) {
        L.polyline(segment.path.map(latLng), {
          weight: 27, opacity: 0, smoothFactor: 0, lineCap: 'butt', bubblingMouseEvents: false,
        }).on('click', () => choose.current.onSegment(index)).addTo(group);
        layer.on('click', () => choose.current.onSegment(index));
      }
      return { layer, branch: branch.id, index };
    }));
    return () => { group.clearLayers(); group.remove(); lines.current = []; };
  }, [geometry, cells]);

  useEffect(() => {
    nodeButton.current?.setAttribute('aria-pressed', String(selected === null));
    for (const { layer, branch, index } of lines.current) {
      const active = branch === 'out' && selected === index;
      const concentration = result?.concentrations_mg_l[branch][frame][index];
      layer.setStyle({ color: result && concentration !== undefined ? colorAt(concentration, result.scale_mg_l) : '#528697', weight: active ? 19 : 10 });
    }
  }, [geometry, result, frame, selected]);

  useEffect(() => { if (visible) fitView.current(); }, [visible]);

  return <div className="confluence-map-wrap">
    <div className="confluence-map" ref={target} data-testid="confluence-map" role="region" aria-label="Метрическая схема трёх ветвей и узла слияния" />
    <span className="confluence-north" aria-label="Север сверху">С<span aria-hidden="true">↑</span></span>
    <button className="confluence-fit" type="button" onClick={() => fitView.current()}>Вся схема</button>
  </div>;
}

function NumberField({ name, unit, value, positive, onChange }: { name: string; unit: string; value: string; positive?: boolean; onChange: (value: string) => void }) {
  const unitId = useId();
  return <label className="confluence-field"><span>{name}</span><span className="confluence-number"><input type="number" inputMode="decimal" min={0} step="any" required value={value} aria-label={name} aria-describedby={unitId} onChange={event => onChange(event.target.value)} /><span id={unitId}>{unit}{positive && <span className="confluence-visually-hidden"> · больше нуля</span>}</span></span></label>;
}

function Conditions({ draft, setDraft }: { draft: Draft; setDraft: (next: Draft) => void }) {
  function inlet(id: InletId) {
    const item = draft[id];
    const letter = branchMark[id];
    function patch(change: Partial<DraftInlet>) { setDraft({ ...draft, [id]: { ...item, ...change } }); }
    return <fieldset key={id}>
      <legend>{branchLabel[id]}</legend>
      <NumberField name={`Расход ветви ${letter}`} unit="м³/с" positive value={item.flow_m3_s} onChange={flow_m3_s => patch({ flow_m3_s })} />
      <NumberField name={`Скорость ветви ${letter}`} unit="м/с" positive value={item.velocity_m_s} onChange={velocity_m_s => patch({ velocity_m_s })} />
      <NumberField name={`Дисперсия ветви ${letter}`} unit="м²/с" value={item.dispersion_m2_s} onChange={dispersion_m2_s => patch({ dispersion_m2_s })} />
      <NumberField name={`Концентрация на входе ${letter}`} unit="мг/л" value={item.concentration_mg_l} onChange={concentration_mg_l => patch({ concentration_mg_l })} />
      <label className="confluence-field"><span>Режим сброса {letter}</span><select value={item.continuous ? 'continuous' : 'finite'} onChange={event => patch({ continuous: event.target.value === 'continuous' })}><option value="finite">Ограниченный по времени</option><option value="continuous">Непрерывный</option></select></label>
      {!item.continuous && <NumberField name={`Длительность сброса ${letter}`} unit="мин" positive value={item.load_duration_minutes} onChange={load_duration_minutes => patch({ load_duration_minutes })} />}
    </fieldset>;
  }
  return <div className="confluence-fields">
    <fieldset>
      <legend>Общие условия</legend>
      <NumberField name="Фоновая концентрация" unit="мг/л" value={draft.background_mg_l} onChange={background_mg_l => setDraft({ ...draft, background_mg_l })} />
      <NumberField name="Горизонт расчёта" unit="ч" positive value={draft.duration_hours} onChange={duration_hours => setDraft({ ...draft, duration_hours })} />
    </fieldset>
    {(['a', 'b'] as const).map(inlet)}
    <fieldset>
      <legend>Ниже узла</legend>
      <NumberField name="Скорость ниже узла" unit="м/с" positive value={draft.out.velocity_m_s} onChange={velocity_m_s => setDraft({ ...draft, out: { ...draft.out, velocity_m_s } })} />
      <NumberField name="Дисперсия ниже узла" unit="м²/с" value={draft.out.dispersion_m2_s} onChange={dispersion_m2_s => setDraft({ ...draft, out: { ...draft.out, dispersion_m2_s } })} />
      <p>Расход равен сумме расходов притоков.</p>
    </fieldset>
  </div>;
}

function SegmentChart({ result, segment, index, frame }: { result: Result; segment: Segment; index: number; frame: number }) {
  const times = result.times_hours;
  const values = result.concentrations_mg_l.out.map(row => row[index]);
  const [min, max] = result.scale_mg_l;
  const end = times[times.length - 1];
  const x = (time: number) => 36 + time / end * 242;
  const y = (value: number) => 106 - (max === min ? 0 : (value - min) / (max - min)) * 85;
  return <div className="confluence-chart" data-testid="confluence-chart">
    <p><strong>{segmentRange(segment)}</strong><span>{fmt(values[frame])} мг/л</span></p>
    <svg viewBox="0 0 304 139" role="img" aria-label={`Концентрация по времени в сегменте ${segmentRange(segment)} ниже узла`}>
      <path className="confluence-chart-grid" d="M36 21H278 M36 63.5H278 M36 106H278" />
      <path className="confluence-chart-cursor" d={`M${x(times[frame])} 21V106`} />
      <polyline className="confluence-chart-line" points={times.map((time, i) => `${x(time)},${y(values[i])}`).join(' ')} />
      <circle className="confluence-chart-point" cx={x(times[frame])} cy={y(values[frame])} r="4" />
      <text x="2" y="12">мг/л</text><text x="28" y="25" textAnchor="end">{fmt(max)}</text><text x="28" y="110" textAnchor="end">{fmt(min)}</text>
      <text x="36" y="125">0</text><text x="278" y="125" textAnchor="end">{fmt(end)} ч</text>
    </svg>
  </div>;
}

function Inspector({ draft, result, frame, selected, select, outCells }: { draft: Draft; result: Result | null; frame: number; selected: number | null; select: (index: number | null) => void; outCells: Segment[] }) {
  const stagedFlow = (id: BranchId) => {
    const flows = [draft.a.flow_m3_s, draft.b.flow_m3_s];
    if (!flows.every(value => value.trim() && Number.isFinite(Number(value)) && Number(value) > 0)) return '—';
    return fmt(id === 'out' ? Number(flows[0]) + Number(flows[1]) : Number(flows[id === 'a' ? 0 : 1]));
  };
  return <aside className="confluence-inspector" aria-label="Данные по схеме">
    <div className="confluence-inspector-tabs" aria-label="Объект на схеме">
      <button type="button" aria-pressed={selected === null} onClick={() => select(null)}>Узел слияния</button>
      <button type="button" disabled={!result} aria-pressed={selected !== null} onClick={() => select(selected ?? 0)}>Ниже узла</button>
    </div>
    {selected === null || !result ? <div data-testid="confluence-node" className="confluence-node-details">
      <dl>{branchIds.map(id => <div key={id} className={id === 'out' ? 'confluence-mixed' : undefined}>
        <dt><span>{branchLabel[id]}</span><small>{result ? fmt(result.flows_m3_s[id]) : stagedFlow(id)} м³/с</small></dt>
        <dd>{result ? <>{fmt(result.junction_mg_l[id][frame])} <small>мг/л</small></> : '—'}</dd>
      </div>)}</dl>
      <p>В узле концентрации притоков смешиваются пропорционально их расходам.</p>
    </div> : <div className="confluence-segment-details">
      <label className="confluence-field"><span>Расчётный сегмент ниже узла</span><select value={selected} onChange={event => select(Number(event.target.value))}>{outCells.map((item, index) => <option key={item.id} value={index}>{segmentRange(item)}</option>)}</select></label>
      <SegmentChart result={result} index={selected} segment={outCells[selected]} frame={frame} />
    </div>}
    {result && <details className="confluence-balance" data-testid="confluence-balance">
      <summary>Баланс массы, кг <span>Невязка {mass(result.balance_kg.residual[frame])}</span></summary>
      <p>Масса вещества относительно фонового уровня к выбранному моменту.</p>
      <table>
        <thead><tr><th scope="col">Участок</th><th scope="col">Вход</th><th scope="col">Выход</th><th scope="col">В воде</th><th scope="col">Невязка</th></tr></thead>
        <tbody>{([null, ...branchIds] as const).map(id => {
          const values = id ? result.branch_balance_kg[id] : result.balance_kg;
          return <tr key={id ?? 'network'}><th scope="row">{id ? branchLabel[id] : 'Вся сеть'}</th><td>{mass(values.input[frame])}</td><td>{mass(values.output[frame])}</td><td>{mass(values.stored[frame])}</td><td>{mass(values.residual[frame])}</td></tr>;
        })}</tbody>
      </table>
    </details>}
  </aside>;
}

function Playback({ result, frame, setFrame, playing, setPlaying }: { result: Result | null; frame: number; setFrame: (frame: number) => void; playing: boolean; setPlaying: (playing: boolean) => void }) {
  const last = result ? result.times_hours.length - 1 : 0;
  return <div className="confluence-playback">
    <button type="button" className="confluence-play" aria-label={playing ? 'Приостановить расчёт' : 'Воспроизвести расчёт'} disabled={!result} onClick={() => {
      if (!playing && frame === last) setFrame(0);
      setPlaying(!playing);
    }}><span aria-hidden="true">{playing ? 'Ⅱ' : '▶'}</span></button>
    <label className="confluence-time-label"><span><strong>Время расчёта</strong><output>{result ? `${fmt(result.times_hours[frame])} / ${fmt(result.times_hours[last])} ч` : '—'}</output></span>
      <input type="range" aria-label="Время расчёта" aria-valuetext={result ? `${fmt(result.times_hours[frame])} ч` : 'Ожидание расчёта'} data-testid="confluence-time" min={0} max={last} value={frame} disabled={!result} onChange={event => { setPlaying(false); setFrame(Number(event.target.value)); }} />
    </label>
    <div data-testid="confluence-legend" className="confluence-legend" aria-label="Единая шкала концентрации">
      <strong>Концентрация, мг/л</strong>
      <div className="confluence-ramp" aria-hidden="true">{palette.map(color => <span key={color} style={{ backgroundColor: color }} />)}</div>
      <span className="confluence-legend-values"><span>{result ? fmt(result.scale_mg_l[0]) : '—'}</span><span>{result ? fmt(result.scale_mg_l[1]) : '—'}</span></span>
    </div>
  </div>;
}

function download(name: string, content: Blob) {
  const url = URL.createObjectURL(content);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Confluence({ visible = true }: { visible?: boolean }) {
  const [pilot, setPilot] = useState<Pilot | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [runError, setRunError] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [frame, setFrame] = useState(0);
  const [selected, select] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const currentRun = useRef<AbortController | null>(null);
  const selectedTime = useRef(0);
  const setSelectedFrame = useCallback((index: number) => { selectedTime.current = index; setFrame(index); }, []);
  const chooseNode = useCallback(() => select(null), []);
  const geometry = pilot?.geometry;
  const outCells = useMemo(() => result ? segments(result.geometry.branches.find(branch => branch.id === 'out')!, result.grid.cells.out) : [], [result]);
  const stale = !!draft && !!result && !sameInputs(draft, result.inputs);

  function downloadConditions() {
    if (!result) return;
    const { model_id, format_version, geometry, inputs } = result;
    const json = `${JSON.stringify({ model_id, format_version, geometry, inputs }, null, 2)}\n`;
    download('confluence-conditions.json', new Blob([json], { type: 'application/json;charset=utf-8' }));
  }

  useEffect(() => {
    const controller = new AbortController();
    setLoadError('');
    loadPilot(controller.signal).then(document => {
      if (controller.signal.aborted) return;
      setPilot(document);
      setDraft(toDraft(document.defaults));
    }).catch(error => { if (!controller.signal.aborted) setLoadError(error instanceof TypeError ? 'Не удалось подключиться к серверу расчёта.' : error.message); });
    return () => controller.abort();
  }, [attempt]);
  useEffect(() => () => { currentRun.current?.abort(); }, []);
  useEffect(() => { if (!visible) setPlaying(false); }, [visible]);

  useEffect(() => {
    if (!result || !playing || !visible) return;
    const times = result.times_hours;
    const startTime = times[selectedTime.current];
    const startWall = performance.now();
    let animation = 0;
    function update(now: number) {
      const simulated = startTime + (now - startWall) / 1000 * playbackHoursPerSecond;
      let index = selectedTime.current;
      while (index < times.length - 1 && times[index + 1] <= simulated) index++;
      if (index !== selectedTime.current) setSelectedFrame(index);
      if (index < times.length - 1) animation = requestAnimationFrame(update);
      else setPlaying(false);
    }
    animation = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animation);
  }, [result, playing, setSelectedFrame, visible]);

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !geometry) return;
    let inputs;
    try { inputs = toInputs(draft); } catch (error) { setRunError((error as Error).message); return; }
    currentRun.current?.abort();
    const controller = new AbortController();
    currentRun.current = controller;
    setRunning(true);
    setPlaying(false);
    setRunError('');
    try {
      const next = await simulate(inputs, geometry, controller.signal);
      if (currentRun.current !== controller || controller.signal.aborted) return;
      select(null);
      setSelectedFrame(0);
      setResult(next);
    } catch (error) {
      if (currentRun.current === controller && !controller.signal.aborted) setRunError(error instanceof TypeError ? 'Нет связи с сервером. Повторите расчёт.' : (error as Error).message);
    } finally {
      if (currentRun.current === controller && !controller.signal.aborted) setRunning(false);
    }
  }

  return <section className="confluence" aria-labelledby="confluence-title" data-testid="confluence">
    <header className="confluence-header">
      <div><h1 id="confluence-title">Слияние водотоков</h1><p>Синтетический пилот · два притока и один выход</p></div>
      <button className="confluence-run" type="submit" form="confluence-inputs" disabled={!draft}>{running ? 'Пересчитать слияние' : 'Рассчитать слияние'}</button>
    </header>
    {loadError ? <div className="confluence-load" role="alert"><p>{loadError}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>Повторить загрузку</button></div> : !geometry || !draft ? <p className="confluence-load" role="status">Загружаем схему слияния…</p> : <>
      <div className="confluence-status" aria-live="polite">
        {running && <span>Выполняется расчёт…</span>}
        {stale && <span data-testid="confluence-stale">Условия изменились. Показан предыдущий расчёт.</span>}
      </div>
      {runError && <p className="confluence-error" role="alert">{runError}</p>}
      <div className="confluence-main">
        <div className="confluence-plan">
          <ConfluenceMap geometry={geometry} visible={visible} result={result} frame={frame} selected={selected} onNode={chooseNode} onSegment={select} />
          <Playback result={result} frame={frame} setFrame={setSelectedFrame} playing={playing} setPlaying={setPlaying} />
        </div>
        <Inspector draft={draft} result={result} frame={frame} selected={selected} select={select} outCells={outCells} />
      </div>
      <form id="confluence-inputs" className="confluence-inputs" onSubmit={run} noValidate>
        <details>
          <summary>Условия расчёта <span>{draft.duration_hours || '—'} ч</span></summary>
          <Conditions draft={draft} setDraft={setDraft} />
          {result && <p className="confluence-model-id">Модель <code>{result.model_id}</code> · формат {result.format_version}</p>}
        </details>
        {result && <div className="confluence-exports" aria-label="Экспорт результата">
          <button type="button" onClick={downloadConditions}>Скачать JSON</button>
          <button type="button" onClick={() => download('confluence-result.csv', resultCsv(result))}>Скачать CSV</button>
        </div>}
      </form>
    </>}
  </section>;
}
