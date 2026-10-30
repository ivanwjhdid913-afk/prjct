import type { LoadInterval } from './loadProfile';

export type IntervalDraft = { id: string; start_hours: string; end_hours: string; effluent_mg_l: string };

let nextDraftId = 0;
export function intervalDrafts(intervals: LoadInterval[]): IntervalDraft[] {
  return intervals.map(interval => ({
    id: `load-period-${++nextDraftId}`,
    start_hours: String(interval.start_hours),
    end_hours: String(interval.end_hours),
    effluent_mg_l: String(interval.effluent_mg_l),
  }));
}

function decimal(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function validateIntervalDraft(rows: IntervalDraft[], duration: number): {
  intervals: LoadInterval[] | null; errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    errors._list = 'Задайте конечную положительную длительность расчёта.';
  } else if (rows.length > 12) {
    errors._list = 'Можно задать не более 12 периодов.';
  }
  const intervals: LoadInterval[] = [];
  let previousEnd = 0;
  for (const row of rows) {
    const start = decimal(row.start_hours), end = decimal(row.end_hours), concentration = decimal(row.effluent_mg_l);
    if (start === null || end === null || concentration === null) {
      errors[row.id] = 'Заполните начало, конец и концентрацию конечными числами.';
    } else if (start < 0 || end > duration) {
      errors[row.id] = 'Период должен находиться в пределах времени расчёта.';
    } else if (end <= start) {
      errors[row.id] = 'Конец периода должен быть позже начала.';
    } else if (concentration < 0 || concentration > 10000) {
      errors[row.id] = 'Концентрация должна быть от 0 до 10 000 мг/л.';
    } else if (start < previousEnd) {
      errors[row.id] = 'Периоды должны идти по времени без перекрытий.';
    }
    if (end !== null) previousEnd = end;
    if (start !== null && end !== null && concentration !== null) {
      intervals.push({ start_hours: start, end_hours: end, effluent_mg_l: concentration });
    }
  }
  return { intervals: Object.keys(errors).length ? null : intervals, errors };
}
