import type { AnalysisSettings, ControlPoint } from "./analysisSettings";

export type ExceedanceInterval = {
  start_hours: number;
  end_hours: number;
  start_inclusive: boolean;
  end_inclusive: boolean;
  continues_at_end: boolean;
};
export type SeriesAnalysis = {
  maximum_mg_l: number;
  minimum_mg_l: number;
  first_maximum_hours: number;
  first_exceedance_hours: number | null;
  first_crossing_hours: number | null;
  initially_exceeding: boolean | null;
  exceedance_intervals: ExceedanceInterval[];
  exceedance_duration_hours: number | null;
};
export type AnalysisResultView = {
  inputs: { length_m: number; duration_hours: number };
  distances_m: readonly number[];
  times_hours: readonly number[];
  concentrations_mg_l: readonly (readonly number[])[];
};
export type ControlPointSummary = {
  point: ControlPoint;
  segment_number: number;
  segment_start_m: number;
  segment_end_m: number;
  segment_center_m: number;
  metrics: SeriesAnalysis;
};

function validateSeries(times: readonly number[], values: readonly number[]) {
  if (
    times.length < 2 ||
    times.length > 15001 ||
    times.length !== values.length ||
    times.some(
      (time, index) =>
        !Number.isFinite(time) ||
        time < 0 ||
        (index > 0 && time <= times[index - 1]),
    ) ||
    values.some((value) => !Number.isFinite(value) || value < 0)
  ) {
    throw new Error(
      "Нужны конечные концентрации и строго возрастающие времена завершённого расчёта.",
    );
  }
}

/** Same binary physical-time interpolation as playback, without frame rounding. */
export function valueAtTime(
  times: readonly number[],
  values: readonly number[],
  hour: number,
): number {
  if (
    !Number.isFinite(hour) ||
    times.length < 2 ||
    values.length !== times.length
  ) {
    throw new Error("Некорректное время или временной ряд.");
  }
  if (hour <= times[0]) return values[0];
  if (hour >= times.at(-1)!) return values.at(-1)!;
  let left = 0,
    right = times.length - 1;
  while (right - left > 1) {
    const middle = (left + right) >>> 1;
    if (times[middle] <= hour) left = middle;
    else right = middle;
  }
  const weight = (hour - times[left]) / (times[right] - times[left]);
  return values[left] + weight * (values[right] - values[left]);
}

/** Strict C(t)>H on the saved piecewise-linear trajectory; no extrapolation. */
export function analyzeSeries(
  times: readonly number[],
  values: readonly number[],
  threshold: number | null,
): SeriesAnalysis {
  validateSeries(times, values);
  if (threshold !== null && (!Number.isFinite(threshold) || threshold < 0)) {
    throw new Error(
      "Пользовательский порог должен быть конечным неотрицательным числом.",
    );
  }
  let maximum = values[0],
    minimum = values[0],
    firstMaximum = times[0];
  values.forEach((value, index) => {
    minimum = Math.min(minimum, value);
    if (value > maximum) {
      maximum = value;
      firstMaximum = times[index];
    }
  });
  const intervals: ExceedanceInterval[] = [];
  let firstCrossing: number | null = null;
  if (threshold !== null) {
    for (let index = 0; index < times.length - 1; index++) {
      const t0 = times[index],
        t1 = times[index + 1];
      const c0 = values[index],
        c1 = values[index + 1];
      if (c0 <= threshold && c1 <= threshold) continue;
      const crossing =
        c0 === c1 ? t0 : t0 + ((threshold - c0) / (c1 - c0)) * (t1 - t0);
      const start = c0 > threshold ? t0 : crossing;
      const end = c1 > threshold ? t1 : crossing;
      if (c0 <= threshold && c1 > threshold && firstCrossing === null)
        firstCrossing = start;
      const piece: ExceedanceInterval = {
        start_hours: start,
        end_hours: end,
        start_inclusive: c0 > threshold,
        end_inclusive: c1 > threshold,
        continues_at_end: index === times.length - 2 && c1 > threshold,
      };
      const previous = intervals.at(-1);
      // A threshold touch splits the strict set even with a zero-duration excluded gap.
      if (
        previous &&
        previous.end_hours === start &&
        previous.end_inclusive &&
        piece.start_inclusive
      ) {
        previous.end_hours = end;
        previous.end_inclusive = piece.end_inclusive;
        previous.continues_at_end = piece.continues_at_end;
      } else intervals.push(piece);
    }
  }
  return {
    maximum_mg_l: maximum,
    minimum_mg_l: minimum,
    first_maximum_hours: firstMaximum,
    first_exceedance_hours: intervals[0]?.start_hours ?? null,
    first_crossing_hours: firstCrossing,
    initially_exceeding: threshold === null ? null : values[0] > threshold,
    exceedance_intervals: intervals,
    exceedance_duration_hours:
      threshold === null
        ? null
        : intervals.reduce(
            (sum, interval) => sum + interval.end_hours - interval.start_hours,
            0,
          ),
  };
}

export function summarizeControlPoints(
  result: AnalysisResultView,
  settings: AnalysisSettings,
): ControlPointSummary[] {
  const length = result.inputs.length_m;
  if (
    !Number.isFinite(length) ||
    length <= 0 ||
    result.distances_m.length !== 100 ||
    result.concentrations_mg_l.length !== result.times_hours.length ||
    result.concentrations_mg_l.some((row) => row.length !== 100)
  ) {
    throw new Error(
      "Анализ требует завершённую геометрию из 100 расчётных сегментов.",
    );
  }
  return settings.points.map((point) => {
    const index = point.segment_index;
    if (!Number.isInteger(index) || index < 0 || index > 99)
      throw new Error("Некорректный контрольный сегмент.");
    return {
      point,
      segment_number: index + 1,
      segment_start_m: (index * length) / 100,
      segment_end_m: ((index + 1) * length) / 100,
      segment_center_m: ((index + 0.5) * length) / 100,
      metrics: analyzeSeries(
        result.times_hours,
        result.concentrations_mg_l.map((row) => row[index]),
        settings.threshold_mg_l,
      ),
    };
  });
}
