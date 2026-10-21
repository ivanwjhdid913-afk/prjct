import { valuesAtHour } from './scenarioComparison';

type Series = { times_hours: number[]; concentrations_mg_l: number[][] };
type Props = {
  result: Series; a: Series | null; b: Series | null;
  distances: number[]; selected: number; onSelect: (index: number) => void;
  hour: number; duration: number; scale: [number, number]; background: number; onSeek: (hour: number) => void;
};
const number = (value: number, digits = 4) => value.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export default function TemporalProfile({ result, a, b, distances, selected, onSelect, hour, duration, scale, background, onSeek }: Props) {
  const x = (time: number) => 85 + 645 * time / duration;
  const y = (value: number) => scale[1] === scale[0] ? 110 : 190 - 160 * (value - scale[0]) / (scale[1] - scale[0]);
  const points = (series: Series) => series.times_hours.map((time, index) => `${x(time)},${y(series.concentrations_mg_l[index][selected])}`).join(' ');
  const current = valuesAtHour(result, hour)[selected];
  const series = result.concentrations_mg_l.map(row => row[selected]);
  const minimum = Math.min(...series), maximum = Math.max(...series);
  const flat = maximum === minimum;
  const isMinimum = background - minimum > maximum - background;
  const extremum = isMinimum ? minimum : maximum;
  const extremumHour = result.times_hours[series.indexOf(extremum)];
  return <section className="simulation-profile temporal-profile" aria-labelledby="temporal-title">
    <h3 id="temporal-title">Концентрация во времени C(t)</h3>
    <label htmlFor="temporal-segment">Сегмент для графика времени</label>
    <select id="temporal-segment" value={selected} onChange={event => onSelect(Number(event.target.value))}>
      {distances.map((distance, index) => <option key={index} value={index}>{index + 1} · {number(distance, 0)} м</option>)}
    </select>
    <p className="temporal-reading"><strong data-testid="temporal-current">{number(current)} мг/л</strong><span>{number(hour, 6)} ч · {number(distances[selected], 0)} м</span></p>
    <div className="temporal-extremum" data-testid="temporal-extremum">
      {flat ? <p>{maximum === background ? 'Отклонения от фона нет. Выраженного экстремума нет.' : 'Концентрация постоянна. Выраженного экстремума нет.'}</p> : <>
        <p>Расчётная оценка · {isMinimum ? 'минимум' : 'максимум'}: <strong>{number(extremum, 6)} мг/л</strong> в {number(extremumHour, 9)} ч ({number(extremumHour * 3600, 3)} с). Для выбранного сегмента показанного расчёта.</p>
        <button type="button" onClick={() => onSeek(extremumHour)}>{isMinimum ? 'Перейти к минимуму' : 'Перейти к максимуму'}</button>
      </>}
    </div>
    <svg viewBox="0 0 760 235" role="img" aria-label="Концентрация выбранного сегмента во времени; вертикальная линия показывает текущий момент.">
      <path d="M85 25V195H735" fill="none" stroke="currentColor" />
      {a && b ? <><polyline data-testid="temporal-a" points={points(a)} fill="none" stroke="#2367a1" strokeWidth="3" /><polyline data-testid="temporal-b" points={points(b)} fill="none" stroke="#b54b35" strokeWidth="3" strokeDasharray="8 4" /></> : <polyline data-testid="temporal-curve" points={points(result)} fill="none" stroke="var(--accent)" strokeWidth="3" />}
      <line data-testid="temporal-cursor" data-hour={hour} x1={x(hour)} x2={x(hour)} y1="25" y2="195" stroke="var(--ink)" strokeWidth="2" strokeDasharray="4 4" />
      <circle cx={x(hour)} cy={y(current)} r="5" fill="var(--ink)" />
      <text x="85" y="17">мг/л</text>
      {scale[1] === scale[0] ? <text x="75" y="114" textAnchor="end">{number(scale[0], 1)}</text> : <><text x="75" y="34" textAnchor="end">{number(scale[1], 1)}</text><text x="75" y="194" textAnchor="end">{number(scale[0], 1)}</text></>}
      <text x="85" y="220">0</text><text x="730" y="220" textAnchor="end">{number(duration, 2)} ч</text>
    </svg>
    {a && b && <p className="profile-comparison-key"><span>А — сплошная синяя</span><span>Б — пунктирная терракотовая</span></p>}
    <details><summary>Таблица C(t)</summary><div className="simulation-table"><table aria-label="Концентрация сегмента во времени"><thead><tr><th>Время, ч</th>{a && b ? <><th>А, мг/л</th><th>Б, мг/л</th></> : <th>Концентрация, мг/л</th>}</tr></thead><tbody>{result.times_hours.map((time, index) => <tr key={time}><td>{number(time, 9)}</td>{a && b ? <><td>{number(valuesAtHour(a, time)[selected])}</td><td>{number(valuesAtHour(b, time)[selected])}</td></> : <td>{number(result.concentrations_mg_l[index][selected])}</td>}</tr>)}</tbody></table></div></details>
  </section>;
}
