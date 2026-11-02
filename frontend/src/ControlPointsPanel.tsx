import { useEffect, useId, useMemo, useState } from "react";
import type { AnalysisSettings, ControlPoint } from "./analysisSettings";
import { summarizeControlPoints, valueAtTime } from "./controlPointAnalysis";
import type {
  ControlPointSummary,
  SeriesAnalysis,
} from "./controlPointAnalysis";
import type { MultipleResult } from "./multipleSources";
import "./controlPoints.css";

export type ControlPointsPanelProps = {
  draftPoints: ControlPoint[];
  thresholdDraft: string;
  appliedSettings: AnalysisSettings;
  result: MultipleResult | null;
  a: MultipleResult | null;
  b: MultipleResult | null;
  hour: number;
  selectedSegment: number;
  selectedPointId: string | null;
  analysisAvailable: boolean;
  inactiveReason?: string | null;
  draftError?: string | null;
  lengthM?: number;
  draftDirty?: boolean;
  onAddSelected: () => void;
  onSegmentSelect?: (index: number) => void;
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
  onSelect: (point: ControlPoint) => void;
  onThresholdChange: (value: string) => void;
  onApply: () => void;
  onResetForGeometry: () => void;
  onSeek: (hour: number) => void;
};

const format = (value: number, digits = 4) =>
  value.toLocaleString("ru-RU", { maximumFractionDigits: digits });
const hours = (value: number | null) =>
  value === null ? "—" : `${format(value, 6)} ч`;
const difference = (a: number | null, b: number | null) =>
  a === null || b === null ? null : b - a;
const INTERVAL_PAGE_SIZE = 20;
type PointSeries = {
  summary: ControlPointSummary;
  values: number[];
  result: MultipleResult;
};

function pointSeries(
  result: MultipleResult | null,
  settings: AnalysisSettings,
  available: boolean,
): PointSeries[] {
  if (!result || !available || !settings.points.length) return [];
  return summarizeControlPoints(result, settings).map((summary) => ({
    summary,
    result,
    values: result.concentrations_mg_l.map(
      (row) => row[summary.point.segment_index],
    ),
  }));
}

function MetricsRow({
  item,
  scenario,
  hour,
  index,
  selected,
  onSelect,
  onSeek,
}: {
  item: PointSeries;
  scenario: string;
  hour: number;
  index: number;
  selected: boolean;
  onSelect: (point: ControlPoint) => void;
  onSeek: (hour: number) => void;
}) {
  const { summary, values, result } = item;
  const { point, metrics } = summary;
  const crossing = metrics.first_crossing_hours;
  return (
    <tr data-scenario={scenario} className={selected ? "is-selected" : ""}>
      <th scope="row" data-label="Точка">
        <button
          type="button"
          className="control-point-result-choice"
          aria-pressed={selected}
          onClick={() => onSelect(point)}
        >
          К{index + 1} · {point.name}
        </button>
        <small>
          Сегмент {summary.segment_number} ·{" "}
          {format(summary.segment_start_m, 1)}–
          {format(summary.segment_end_m, 1)} м<br />
          Центр {format(summary.segment_center_m, 1)} м
        </small>
      </th>
      <td data-label="Вариант">{scenario}</td>
      <td data-label="Сейчас, мг/л" data-metric="current">
        {format(valueAtTime(result.times_hours, values, hour))}
      </td>
      <td data-label="Мин., мг/л">{format(metrics.minimum_mg_l)}</td>
      <td data-label="Макс., мг/л">{format(metrics.maximum_mg_l)}</td>
      <td data-label="Первый максимум">
        <button
          type="button"
          className="control-point-event"
          aria-label={`К максимуму ${scenario} — ${point.name}`}
          onClick={() => {
            onSelect(point);
            onSeek(metrics.first_maximum_hours);
          }}
        >
          {hours(metrics.first_maximum_hours)}
        </button>
      </td>
      <td data-label="Первый вход в превышение" data-metric="crossing">
        {hours(crossing)}
        {metrics.initially_exceeding && (
          <small>Уже выше порога в начале расчёта</small>
        )}
      </td>
      <td data-label="Всего выше порога">
        {hours(metrics.exceedance_duration_hours)}
      </td>
    </tr>
  );
}

function DeltaRow({
  a,
  b,
  hour,
}: {
  a: PointSeries;
  b: PointSeries;
  hour: number;
}) {
  const first = a.summary.metrics,
    second = b.summary.metrics;
  return (
    <tr data-scenario="delta" className="control-point-delta">
      <th scope="row">
        Б − А<small>{a.summary.point.name}</small>
      </th>
      <td data-label="Вариант">Разница</td>
      <td data-label="Сейчас, мг/л">
        {format(
          valueAtTime(b.result.times_hours, b.values, hour) -
            valueAtTime(a.result.times_hours, a.values, hour),
        )}
      </td>
      <td data-label="Мин., мг/л">
        {format(second.minimum_mg_l - first.minimum_mg_l)}
      </td>
      <td data-label="Макс., мг/л">
        {format(second.maximum_mg_l - first.maximum_mg_l)}
      </td>
      <td data-label="Первый максимум">
        {hours(second.first_maximum_hours - first.first_maximum_hours)}
      </td>
      <td data-label="Первый вход в превышение" data-metric="crossing">
        {hours(
          difference(first.first_crossing_hours, second.first_crossing_hours),
        )}
      </td>
      <td data-label="Всего выше порога">
        {hours(
          difference(
            first.exceedance_duration_hours,
            second.exceedance_duration_hours,
          ),
        )}
      </td>
    </tr>
  );
}

function ExceedancePeriods({
  metrics,
  scenario,
  onSeek,
}: {
  metrics: SeriesAnalysis;
  scenario: string;
  onSeek: (hour: number) => void;
}) {
  const [page, setPage] = useState(0);
  const intervals = metrics.exceedance_intervals;
  useEffect(() => setPage(0), [intervals]);
  const pages = Math.max(1, Math.ceil(intervals.length / INTERVAL_PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const offset = currentPage * INTERVAL_PAGE_SIZE;
  if (metrics.exceedance_duration_hours === null)
    return <p>Пороговый анализ не задан.</p>;
  if (!intervals.length) return <p>Нет превышения</p>;
  return (
    <div className="control-point-periods">
      {metrics.initially_exceeding && (
        <p>
          Выше порога уже в начале расчёта. Начало периода не определяет время
          первого появления вещества.
        </p>
      )}
      <p>
        Периодов: {intervals.length} · общая длительность{" "}
        {hours(metrics.exceedance_duration_hours)}
      </p>
      <ol start={offset + 1}>
        {intervals
          .slice(offset, offset + INTERVAL_PAGE_SIZE)
          .map((interval, index) => (
            <li key={offset + index}>
              <span>
                {interval.start_inclusive ? "[" : "("}
                {format(interval.start_hours, 6)}–
                {format(interval.end_hours, 6)}
                {interval.end_inclusive ? "]" : ")"} ч
              </span>
              {interval.continues_at_end && (
                <strong>Продолжается к концу расчёта</strong>
              )}
              <button
                type="button"
                onClick={() => onSeek(interval.start_hours)}
                aria-label={`К началу периода ${offset + index + 1} ${scenario}`}
              >
                К началу
              </button>
            </li>
          ))}
      </ol>
      {pages > 1 && (
        <nav
          className="control-point-pagination"
          aria-label={`Страницы периодов ${scenario}`}
        >
          <button
            type="button"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            Назад
          </button>
          <span role="status">
            {currentPage + 1} / {pages}
          </span>
          <button
            type="button"
            disabled={currentPage === pages - 1}
            onClick={() => setPage(currentPage + 1)}
          >
            Далее
          </button>
        </nav>
      )}
      <small>
        Круглая скобка: в самой границе C(t) равно порогу. Квадратная: граница
        входит в период.
      </small>
    </div>
  );
}

export default function ControlPointsPanel({
  draftPoints,
  thresholdDraft,
  appliedSettings,
  result,
  a,
  b,
  hour,
  selectedSegment,
  selectedPointId,
  analysisAvailable,
  inactiveReason,
  draftError,
  lengthM,
  draftDirty,
  onAddSelected,
  onSegmentSelect,
  onRename,
  onRemove,
  onSelect,
  onThresholdChange,
  onApply,
  onResetForGeometry,
  onSeek,
}: ControlPointsPanelProps) {
  const id = useId();
  const comparing = !!a && !!b;
  const primary = comparing ? a : result;
  const first = useMemo(
    () => pointSeries(primary, appliedSettings, analysisAvailable),
    [primary, appliedSettings, analysisAvailable],
  );
  const second = useMemo(
    () => pointSeries(comparing ? b : null, appliedSettings, analysisAvailable),
    [b, comparing, appliedSettings, analysisAvailable],
  );
  const selectedFirst = first.find(
    (item) => item.summary.point.id === selectedPointId,
  );
  const selectedSecond = second.find(
    (item) => item.summary.point.id === selectedPointId,
  );
  const duplicate = draftPoints.some(
    (point) => point.segment_index === selectedSegment,
  );
  const dirty =
    draftDirty ??
    (JSON.stringify(draftPoints) !== JSON.stringify(appliedSettings.points) ||
      thresholdDraft.trim() !==
        (appliedSettings.threshold_mg_l === null
          ? ""
          : String(appliedSettings.threshold_mg_l)));
  const length = lengthM ?? result?.inputs.length_m;
  const validSelection =
    Number.isInteger(selectedSegment) &&
    selectedSegment >= 0 &&
    selectedSegment < 100;

  return (
    <section className="control-points-panel" aria-labelledby={`${id}-title`}>
      <div className="control-points-heading">
        <h3 id={`${id}-title`}>Контрольные точки</h3>
        <span>{draftPoints.length} / 5</span>
      </div>
      <p className="control-points-note">
        Средняя расчётная концентрация одного сегмента, а не измерение в
        произвольной координате.
      </p>
      <div className="control-point-add">
        {onSegmentSelect && (
          <>
            <label htmlFor={`${id}-segment`}>
              Сегмент для контрольной точки
            </label>
            <select
              id={`${id}-segment`}
              value={selectedSegment}
              onChange={(event) => onSegmentSelect(Number(event.target.value))}
            >
              {Array.from({ length: 100 }, (_, index) => (
                <option key={index} value={index}>
                  {index + 1}
                  {length
                    ? ` · центр ${format((length * (index + 0.5)) / 100, 1)} м`
                    : ""}
                </option>
              ))}
            </select>
          </>
        )}
        <p>
          Выбран сегмент {validSelection ? selectedSegment + 1 : "—"}
          {length && validSelection ? (
            <small>
              {format((length * selectedSegment) / 100, 1)}–
              {format((length * (selectedSegment + 1)) / 100, 1)} м · центр{" "}
              {format((length * (selectedSegment + 0.5)) / 100, 1)} м
            </small>
          ) : null}
        </p>
        <button
          type="button"
          onClick={onAddSelected}
          disabled={!validSelection || draftPoints.length >= 5 || duplicate}
        >
          {duplicate ? "Сегмент уже закреплён" : "Закрепить выбранный сегмент"}
        </button>
      </div>
      <ul
        className="control-point-drafts"
        aria-label="Настройки контрольных точек"
      >
        {draftPoints.map((point, index) => (
          <li key={point.id}>
            <button
              type="button"
              className="control-point-select"
              onClick={() => onSelect(point)}
              aria-pressed={point.id === selectedPointId}
              aria-label={`Выбрать контрольную точку К${index + 1}: ${point.name}`}
            >
              <span>К{index + 1}</span>
              <small>Сегмент {point.segment_index + 1}</small>
            </button>
            <label>
              <span className="control-point-visually-hidden">
                Название контрольной точки К{index + 1}
              </span>
              <input
                value={point.name}
                maxLength={80}
                onChange={(event) => onRename(point.id, event.target.value)}
              />
            </label>
            <button
              type="button"
              className="control-point-remove"
              onClick={() => onRemove(point.id)}
              aria-label={`Удалить контрольную точку К${index + 1}`}
            >
              Удалить
            </button>
          </li>
        ))}
      </ul>
      <label className="control-point-threshold" htmlFor={`${id}-threshold`}>
        Пользовательский порог, мг/л
      </label>
      <input
        id={`${id}-threshold`}
        type="text"
        inputMode="decimal"
        value={thresholdDraft}
        aria-invalid={!!draftError}
        aria-describedby={`${id}-threshold-help${draftError ? ` ${id}-error` : ""}`}
        onChange={(event) => onThresholdChange(event.target.value)}
      />
      <p className="control-points-note" id={`${id}-threshold-help`}>
        Пусто — без порогового анализа; 0 допустим. Превышение: C(t) &gt;
        порога.
      </p>
      {draftError && (
        <p id={`${id}-error`} className="control-point-error" role="alert">
          {draftError}
        </p>
      )}
      <div className="control-point-apply">
        <button
          type="button"
          onClick={onApply}
          disabled={!!draftError || !dirty}
        >
          Применить настройки анализа
        </button>
        <span role="status">
          {dirty ? "Есть неприменённый черновик" : "Настройки применены"}
        </span>
      </div>
      {inactiveReason && (
        <div className="control-point-inactive">
          <p>{inactiveReason}</p>
          <button type="button" onClick={onResetForGeometry}>
            Сбросить точки и порог для текущего участка
          </button>
        </div>
      )}
      {!result && (
        <p className="control-points-note">
          Точки можно задать до расчёта. Итоги появятся после его завершения.
        </p>
      )}
      {first.length > 0 && (
        <>
          <h4>Итоги применённых настроек</h4>
          <p className="control-points-note">Переход от C ≤ порога к C &gt; порога. Если концентрация выше порога уже в начале, завершение начального периода — пересечение вниз; первый последующий вход может наступить позже.</p>
          <p className="control-points-note">
            {format(hour, 6)} ч ·{" "}
            {appliedSettings.threshold_mg_l === null
              ? "Пороговый анализ не задан."
              : `Пользовательский порог ${format(appliedSettings.threshold_mg_l)} мг/л; C(t) > порога.`}
            {dirty && " Таблица и экспорт используют применённые настройки."}
          </p>
          <div className="control-point-results">
            <table aria-label="Итоги контрольных точек">
              <thead>
                <tr>
                  <th scope="col">Точка · сегмент</th>
                  <th scope="col">Вариант</th>
                  <th scope="col">Сейчас, мг/л</th>
                  <th scope="col">Мин., мг/л</th>
                  <th scope="col">Макс., мг/л</th>
                  <th scope="col">Первый максимум</th>
                  <th scope="col">Первый вход в превышение</th>
                  <th scope="col">Всего выше порога</th>
                </tr>
              </thead>
              <tbody>
                {first.map((item, index) => (
                  <PointRows
                    key={item.summary.point.id}
                    item={item}
                    second={second[index]}
                    scenario={comparing ? "А" : "Расчёт"}
                    hour={hour}
                    index={index}
                    selected={item.summary.point.id === selectedPointId}
                    onSelect={onSelect}
                    onSeek={onSeek}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {comparing && (
            <p className="control-points-note">
              Б − А: «—», если пересечение не определено хотя бы в одном
              варианте.
            </p>
          )}
          {selectedFirst ? (
            <div className="control-point-selected-periods">
              <h4>Периоды превышения · {selectedFirst.summary.point.name}</h4>
              {comparing && <h5>Вариант А</h5>}
              <ExceedancePeriods
                key={`${selectedPointId}-a`}
                metrics={selectedFirst.summary.metrics}
                scenario={comparing ? "А" : "Расчёт"}
                onSeek={onSeek}
              />
              {selectedSecond && (
                <>
                  <h5>Вариант Б</h5>
                  <ExceedancePeriods
                    key={`${selectedPointId}-b`}
                    metrics={selectedSecond.summary.metrics}
                    scenario="Б"
                    onSeek={onSeek}
                  />
                </>
              )}
              <p className="control-points-note">
                Линейная интерполяция сохранённых состояний. Время пересечения —
                расчётная оценка; за пределы горизонта не продолжается.
              </p>
              <p className="control-points-note">
                Допуск сохранения концентраций не задаёт точность времени
                пересечения; на пологой кривой ошибка времени может быть
                заметной.
              </p>
            </div>
          ) : (
            <p className="control-points-note">
              Выберите точку, чтобы открыть все её периоды превышения и график
              C(t).
            </p>
          )}
        </>
      )}
    </section>
  );
}

function PointRows({
  item,
  second,
  ...props
}: {
  item: PointSeries;
  second?: PointSeries;
  scenario: string;
  hour: number;
  index: number;
  selected: boolean;
  onSelect: (point: ControlPoint) => void;
  onSeek: (hour: number) => void;
}) {
  return (
    <>
      <MetricsRow item={item} {...props} />
      {second && (
        <>
          <MetricsRow item={second} {...props} scenario="Б" />
          <DeltaRow a={item} b={second} hour={props.hour} />
        </>
      )}
    </>
  );
}
