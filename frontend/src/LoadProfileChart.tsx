import { useId } from 'react';
import { sourceConcentrationAt, sourceEvents, type LoadConditions } from './loadProfile';
import './loadProfileEditor.css';

type Props = { conditions: LoadConditions; hour?: number; label?: string };
const format = (value: number) => value.toLocaleString('ru-RU', { maximumFractionDigits: 4 });

export default function LoadProfileChart({ conditions, hour, label = 'Концентрация поступающей воды ce(t)' }: Props) {
  const id = useId();
  const duration = conditions.duration_hours;
  const events = sourceEvents(conditions).filter(event => event.hour >= 0 && event.hour <= duration);
  const maximum = Math.max(conditions.background_mg_l, ...(conditions.load_mode === 'profile'
    ? (conditions.load_intervals ?? []).map(row => row.effluent_mg_l) : [conditions.effluent_mg_l!]));
  const top = maximum > 0 ? maximum * 1.12 : 1;
  const x = (time: number) => 48 + time / duration * 198;
  const y = (value: number) => 128 - value / top * 98;
  let path = `M${x(0)} ${y(sourceConcentrationAt(conditions, 0))}`;
  for (const event of events) {
    if (event.hour === 0) continue;
    path += `H${x(event.hour)}V${y(event.concentration_mg_l)}`;
  }
  path += `H${x(duration)}`;
  const cursorHour = hour !== undefined && Number.isFinite(hour) ? Math.min(duration, Math.max(0, hour)) : null;
  const cursorValue = cursorHour === null ? null : sourceConcentrationAt(conditions, cursorHour);
  return <figure className="source-load-chart" data-testid="source-load-chart" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>{label}</h3>
    <svg viewBox="0 0 260 170" role="img" aria-labelledby={`${id}-title ${id}-description`}>
      <desc id={`${id}-description`}>Ступенчатая концентрация поступающей воды во времени. Пунктир — фон {format(conditions.background_mg_l)} мг/л. В пропусках между периодами действует фон.</desc>
      <path d="M48 24V128H246" fill="none" stroke="#95a89e" />
      <line x1="48" x2="246" y1={y(conditions.background_mg_l)} y2={y(conditions.background_mg_l)} stroke="#7a8779" strokeDasharray="5 4" />
      <path data-testid="source-load-curve" d={path} fill="none" stroke="#174c45" strokeWidth="2.5" strokeLinejoin="miter" />
      {cursorHour !== null && <line data-testid="source-load-cursor" data-hour={cursorHour} data-concentration={cursorValue}
        x1={x(cursorHour)} x2={x(cursorHour)} y1="24" y2="128" stroke="#9a5f2e" strokeWidth="1.5" strokeDasharray="3 3" />}
      <text x="48" y="15">мг/л</text>
      <text x="40" y="34" textAnchor="end">{format(top)}</text>
      <text x="40" y="132" textAnchor="end">0</text>
      <text x="48" y="150">0</text>
      <text x={x(duration / 2)} y="150" textAnchor="middle">{format(duration / 2)}</text>
      <text x="246" y="150" textAnchor="end">{format(duration)} ч</text>
    </svg>
    <p className="source-load-key"><span>ce(t) — сплошная</span><span>Фон cb = {format(conditions.background_mg_l)} мг/л — пунктир</span></p>
    {cursorHour !== null && <p className="source-load-current">{format(cursorHour)} ч · ce = {format(cursorValue!)} мг/л</p>}
    <figcaption>График источника; это не концентрация в реке. Расход воды сохраняется.</figcaption>
  </figure>;
}
