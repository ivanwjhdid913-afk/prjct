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
type Result = {
  inputs: Inputs;
  derived: { total_flow_m3_s: number; area_m2: number; load_kg_s: number; excess_load_kg_s: number; steady_mg_l: number; travel_hours: number };
  distances_m: number[]; times_hours: number[]; concentrations_mg_l: number[][];
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  scale_mg_l: [number, number];
};
const initialDraft = Object.fromEntries(fields.map(field => [field.key, String(field.initial)])) as Draft;
const format = (value: number, digits = 2) => value.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function validResult(value: unknown): value is Result {
  if (!value || typeof value !== 'object') return false;
  const row = value as Result;
  return !!row.inputs && fields.every(field => finite(row.inputs[field.key]))
    && !!row.derived && ['total_flow_m3_s', 'area_m2', 'load_kg_s', 'excess_load_kg_s', 'steady_mg_l', 'travel_hours'].every(key => finite(row.derived[key as keyof Result['derived']]))
    && Array.isArray(row.distances_m) && row.distances_m.length > 0 && row.distances_m.length <= 200 && row.distances_m.every(finite)
    && Array.isArray(row.times_hours) && row.times_hours.length > 0 && row.times_hours.length <= 100 && row.times_hours.every(finite)
    && Array.isArray(row.concentrations_mg_l) && row.concentrations_mg_l.length === row.times_hours.length
    && row.concentrations_mg_l.every(values => Array.isArray(values) && values.length === row.distances_m.length && values.every(finite))
    && row.geometry?.type === 'LineString' && Array.isArray(row.geometry.coordinates) && row.geometry.coordinates.length === row.distances_m.length + 1
    && row.geometry.coordinates.every(point => Array.isArray(point) && point.length === 2 && point.every(finite) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90)
    && Array.isArray(row.scale_mg_l) && row.scale_mg_l.length === 2 && row.scale_mg_l.every(finite) && row.scale_mg_l[0] <= row.scale_mg_l[1];
}

function color(value: number, scale: [number, number]) {
  const share = scale[1] === scale[0] ? .5 : Math.max(0, Math.min(1, (value - scale[0]) / (scale[1] - scale[0])));
  return `hsl(205 75% ${85 - 60 * share}%)`;
}

function CalculationMap({ result, values, selected, onSelect }: { result: Result; values: number[]; selected: number; onSelect: (index: number) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const segments = useRef<L.Polyline[]>([]);
  const [tileError, setTileError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!host.current) return;
    setTileError(false);
    const map = L.map(host.current, { scrollWheelZoom: false, zoomAnimation: false, fadeAnimation: false, zoomControl: false });
    map.attributionControl.setPrefix(false);
    L.control.zoom({ zoomInTitle: 'Увеличить масштаб', zoomOutTitle: 'Уменьшить масштаб' }).addTo(map);
    const points: L.LatLngTuple[] = result.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    map.fitBounds(points, { padding: [35, 45], animate: false });
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
    let timer = window.setTimeout(() => setTileError(true), 10_000);
    tiles.on('loading', () => { window.clearTimeout(timer); timer = window.setTimeout(() => setTileError(true), 10_000); });
    tiles.on('load', () => window.clearTimeout(timer));
    tiles.on('tileerror', () => setTileError(true));
    segments.current = result.distances_m.map((_, index) => L.polyline([points[index], points[index + 1]], { color: color(result.concentrations_mg_l[0][index], result.scale_mg_l), weight: 9, dashArray: '7 5', className: 'simulation-segment' }).addTo(map).on('click', () => onSelect(index)));
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
      segment.setStyle({ color: color(values[index], result.scale_mg_l), weight: selected === index ? 15 : 9 });
      const element = segment.getElement();
      element?.setAttribute('data-concentration', String(values[index]));
      element?.setAttribute('data-selected', String(selected === index));
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${format(result.distances_m[index], 0)} м: ${format(values[index], 4)} мг/л`;
      element?.replaceChildren(title);
    });
  }, [values, selected, result, revision]);
  return <section className="map-panel" aria-label="Карта расчётного участка">
    <p className="simulation-map-label">Условный расчётный участок — не реальное русло</p>
    <div ref={host} className="point-map simulation-map" aria-label="Расчётные сегменты на карте. Выбор с клавиатуры доступен ниже." />
    {tileError && <div className="map-warning" role="status"><strong>Подложка карты недоступна</strong><p>Расчётная линия и численные результаты доступны.</p><button onClick={() => setRevision(value => value + 1)}>Повторить загрузку подложки</button></div>}
    <p className="map-caption">Пунктир — синтетическая геометрия. Стрелки показывают направление потока. Выберите сегмент на линии или в списке ниже.</p>
  </section>;
}

export default function Simulation() {
  const [draft, setDraft] = useState<Draft>(initialDraft);
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
  useEffect(() => { title.current?.focus(); return () => { request.current++; controller.current?.abort(); }; }, []);
  const stale = result !== null && fields.some(field => draft[field.key].trim() === '' || Number(draft[field.key]) !== result.inputs[field.key]);

  async function calculate() {
    if (!form.current?.reportValidity()) return;
    const inputs = Object.fromEntries(fields.map(field => [field.key, Number(draft[field.key])])) as Inputs;
    const id = ++request.current;
    controller.current?.abort();
    const currentController = new AbortController(); controller.current = currentController;
    setStatus('loading'); setMessage(''); setFieldErrors({});
    const timeout = window.setTimeout(() => currentController.abort(), 60_000);
    try {
      const response = await fetch('/api/v1/simulations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(inputs), signal: currentController.signal });
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
      setResult(data); setTime(0); setSelected(0); setStatus('ready');
    } catch (error) {
      if (id !== request.current) return;
      setMessage(currentController.signal.aborted ? 'Превышено время ожидания. Повторите расчёт.' : error instanceof Error ? error.message : 'Проверьте соединение с сервером.');
      setStatus('error');
    } finally { window.clearTimeout(timeout); }
  }

  const values = result?.concentrations_mg_l[time];
  const span = result ? result.scale_mg_l[1] - result.scale_mg_l[0] : 0;
  const profile = result && values ? values.map((value, index) => `${85 + 645 * result.distances_m[index] / result.inputs.length_m},${span === 0 ? 110 : 190 - 160 * (value - result.scale_mg_l[0]) / span}`).join(' ') : '';
  return <div className="simulation">
    <section className="introduction"><p className="eyebrow">Сценарий / Постоянный сброс</p><h1 ref={title} tabIndex={-1}>Моделирование</h1><p className="lead">Как меняется концентрация хлоридов вдоль участка после начала постоянного сброса.</p></section>
    <aside className="point-notice"><strong>Синтетический сценарий</strong><p>Геометрия, нагрузка и параметры потока заданы для демонстрации. Участок не связан с реальным предприятием, выпуском или рекой. Концентрации рассчитаны, а не измерены.</p></aside>
    <section className="simulation-parameters" aria-labelledby="parameters-title"><h2 id="parameters-title">Условия расчёта</h2>
      <form ref={form} onSubmit={event => { event.preventDefault(); void calculate(); }}>
        <div className="simulation-fields">{fields.map(field => <div className="simulation-field" key={field.key}>
          <label htmlFor={field.key}>{field.label}</label>
          <input id={field.key} type="number" required step="any" min={field.min} max={field.max} value={draft[field.key]} aria-describedby={`${field.key}-help${fieldErrors[field.key] ? ` ${field.key}-error` : ''}`} aria-invalid={!!fieldErrors[field.key]} onChange={event => setDraft(current => ({ ...current, [field.key]: event.target.value }))} />
          <p id={`${field.key}-help`}>{field.help} От {format(field.min, field.min < 1 ? 2 : 0)} до {format(field.max, 0)}.</p>
          {fieldErrors[field.key] && <p className="simulation-field-error" id={`${field.key}-error`}>{fieldErrors[field.key]}</p>}
        </div>)}</div>
        <div className="simulation-actions"><button className="primary" type="submit">{status === 'loading' ? 'Запустить новый расчёт' : 'Рассчитать'}</button>{status === 'loading' && <button type="button" onClick={() => { request.current++; controller.current?.abort(); setStatus('cancelled'); }}>Отменить ожидание</button>}</div>
      </form>
      {status === 'idle' && <p className="simulation-hint">Заданы демонстрационные параметры. Нажмите «Рассчитать», чтобы получить профиль.</p>}
      {status === 'loading' && <p role="status">Выполняется расчёт…</p>}
      {status === 'cancelled' && <p role="status">Ожидание отменено. Сервер может ещё завершать вычисление.</p>}
      {status === 'error' && <div className="simulation-error" role="alert"><strong>Не удалось выполнить расчёт</strong><p>{message}</p><button onClick={() => { void calculate(); }}>Повторить расчёт</button></div>}
    </section>
    {result && values && <section className="simulation-result" aria-labelledby="result-title">
      <div className="simulation-result-heading"><p className="eyebrow">Рассчитанные значения / Хлориды</p><h2 id="result-title">Результат расчёта</h2></div>
      {stale && <p className="simulation-stale" role="status">Параметры изменены. Результат относится к предыдущим условиям.</p>}
      {status === 'loading' && <p className="simulation-hint">До завершения нового запроса показан предыдущий расчёт.</p>}
      <dl className="simulation-summary"><div><dt>Площадь сечения</dt><dd>{format(result.derived.area_m2)} м²</dd></div><div><dt>Нагрузка выпуска</dt><dd>{format(result.derived.load_kg_s, 4)} кг/с</dd></div><div><dt>Нагрузка сверх фона</dt><dd>{format(result.derived.excess_load_kg_s, 4)} кг/с</dd></div><div><dt>Установившаяся концентрация</dt><dd>{format(result.derived.steady_mg_l, 4)} мг/л</dd></div></dl>
      <p className="simulation-hint">L/u = {format(result.derived.travel_hours, 3)} ч — характерное время переноса, не точное время первого появления вещества. Установившийся профиль постоянен вдоль участка; изменение по расстоянию относится к переходному процессу.</p>
      <div className="simulation-time"><label htmlFor="simulation-time">Время от начала сценария</label><output htmlFor="simulation-time">{format(result.times_hours[time])} ч</output><input id="simulation-time" type="range" min={0} max={result.times_hours.length - 1} step={1} value={time} onChange={event => setTime(Number(event.target.value))} aria-valuetext={`${format(result.times_hours[time])} часов`} /><span>0 ч</span><span>{format(result.inputs.duration_hours)} ч</span></div>
      <div className="simulation-legend" data-testid="concentration-scale"><strong>Расчётная концентрация, мг/л</strong><div aria-hidden="true" className="simulation-gradient" style={span === 0 ? { background: color(result.scale_mg_l[0], result.scale_mg_l) } : undefined} /><span>{format(result.scale_mg_l[0], 4)}</span>{span !== 0 && <span>{format(result.scale_mg_l[1], 4)}</span>}<small>{span === 0 ? 'Концентрация одинакова на всём участке и во все моменты расчёта. ' : 'Одна шкала для всех моментов этого расчёта. '}Цвет не означает нормативную оценку.</small></div>
      <CalculationMap result={result} values={values} selected={selected} onSelect={setSelected} />
      <div className="simulation-selection"><div><label htmlFor="simulation-segment">Расчётный сегмент</label><select id="simulation-segment" value={selected} onChange={event => setSelected(Number(event.target.value))}>{result.distances_m.map((distance, index) => <option key={index} value={index}>{index + 1} · {format(distance, 0)} м</option>)}</select></div><p aria-live="polite">Расстояние от начала: <strong>{format(result.distances_m[selected], 0)} м</strong><br />Концентрация: <strong data-testid="selected-concentration">{format(values[selected], 4)} мг/л</strong></p></div>
      <section className="simulation-profile" aria-labelledby="profile-title"><h3 id="profile-title">Профиль концентрации по расстоянию</h3><p>Значения в центрах расчётных сегментов · {format(result.times_hours[time])} ч</p>
        <svg viewBox="0 0 760 235" role="img" aria-label="Расчётный профиль концентрации. Все значения доступны в таблице ниже."><path d="M85 25V195H735" fill="none" stroke="currentColor" /><polyline points={profile} fill="none" stroke="var(--accent)" strokeWidth="3" /><text x="85" y="17">мг/л</text>{span === 0 ? <text x="75" y="114" textAnchor="end">{format(result.scale_mg_l[0], 1)}</text> : <><text x="75" y="34" textAnchor="end">{format(result.scale_mg_l[1], 1)}</text><text x="75" y="194" textAnchor="end">{format(result.scale_mg_l[0], 1)}</text></>}<text x="85" y="220">0</text><text x="730" y="220" textAnchor="end">{format(result.inputs.length_m, 0)} м</text></svg>
        <details><summary>Таблица профиля</summary><div className="simulation-table"><table aria-label="Рассчитанный профиль"><thead><tr><th>Сегмент</th><th>Расстояние, м</th><th>Концентрация, мг/л</th></tr></thead><tbody>{result.distances_m.map((distance, index) => <tr key={index}><td>{index + 1}</td><td>{format(distance, 0)}</td><td>{format(values[index], 4)}</td></tr>)}</tbody></table></div></details>
      </section>
      <details className="simulation-used-inputs"><summary>Параметры показанного расчёта</summary><dl>{fields.map(field => <div key={field.key}><dt>{field.label}</dt><dd>{format(result.inputs[field.key], 3)}</dd></div>)}</dl></details>
    </section>}
    <aside className="simulation-assumptions"><h2>Границы модели</h2><p>Один полностью перемешанный участок и одно консервативное растворённое вещество. Учитываются течение и продольная дисперсия. Гидравлика установившаяся с начала сценария; притоков, водозаборов, распада, сорбции и подпора нет.</p><p>Это сценарная симуляция, а не подтверждённый прогноз для водных объектов области. Модель не описывает зону неполного смешения возле выпуска, озёра и водохранилища.</p></aside>
  </div>;
}
