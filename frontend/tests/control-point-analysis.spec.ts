import { expect, test } from '@playwright/test';
import { analyzeSeries, summarizeControlPoints, valueAtTime } from '../src/controlPointAnalysis';

test('strict linear exceedance finds both periods and earliest equal maximum', () => {
  const actual = analyzeSeries([0, 1, 2, 3, 4, 5], [10, 12, 10, 10, 12, 10], 11);
  expect(actual).toEqual({
    maximum_mg_l: 12, minimum_mg_l: 10, first_maximum_hours: 1,
    first_exceedance_hours: .5, first_crossing_hours: .5, initially_exceeding: false,
    exceedance_duration_hours: 2,
    exceedance_intervals: [
      { start_hours: .5, end_hours: 1.5, start_inclusive: false, end_inclusive: false, continues_at_end: false },
      { start_hours: 3.5, end_hours: 4.5, start_inclusive: false, end_inclusive: false, continues_at_end: false },
    ],
  });
});

test('null threshold omits threshold analysis while zero is a valid threshold', () => {
  const absent = analyzeSeries([0, 1], [0, 0], null);
  expect(absent.exceedance_duration_hours).toBeNull();
  expect(absent.initially_exceeding).toBeNull();
  expect(absent.first_crossing_hours).toBeNull();
  expect(absent.exceedance_intervals).toEqual([]);
  const zero = analyzeSeries([0, .25, 1], [0, 2, 0], 0);
  expect(zero.first_crossing_hours).toBe(0);
  expect(zero.exceedance_duration_hours).toBe(1);
  expect(zero.exceedance_intervals[0].start_inclusive).toBe(false);
});

test('initial exceedance differs from a later actual upcrossing and remains open at horizon', () => {
  const actual = analyzeSeries([0, .5, 2, 3], [2, 0, 0, 2], 1);
  expect(actual.first_exceedance_hours).toBe(0);
  expect(actual.first_crossing_hours).toBe(2.5);
  expect(actual.exceedance_intervals[0].end_hours).toBe(.25);
  expect(actual.initially_exceeding).toBe(true);
  expect(actual.exceedance_intervals[0].start_inclusive).toBe(true);
  expect(actual.exceedance_intervals[1]).toEqual({ start_hours: 2.5, end_hours: 3, start_inclusive: false, end_inclusive: true, continues_at_end: true });
  expect(analyzeSeries([.2, .9], [2, 2], 1).first_crossing_hours).toBeNull();
});

test('touching threshold from above splits the strict set and a threshold plateau is excluded', () => {
  const touch = analyzeSeries([0, 1, 2], [2, 1, 2], 1);
  expect(touch.exceedance_intervals).toHaveLength(2);
  expect(touch.exceedance_intervals[0].end_inclusive).toBe(false);
  expect(touch.exceedance_intervals[1].start_inclusive).toBe(false);
  expect(touch.exceedance_duration_hours).toBe(2);
  const plateau = analyzeSeries([0, .2, .7, .9], [0, 1, 1, 0], 1);
  expect(plateau.exceedance_intervals).toEqual([]);
  expect(plateau.exceedance_duration_hours).toBe(0);
  expect(plateau.first_maximum_hours).toBe(.2);
});

test('irregular fractional times preserve concentrations, plateaus and tiny real excursions', () => {
  const times = Object.freeze([.125, .375, 1.125, 2.125]);
  const values = Object.freeze([.25, .75, .75, .25]);
  const actual = analyzeSeries(times, values, .5);
  expect(actual.first_exceedance_hours).toBe(.25);
  expect(actual.exceedance_intervals[0].end_hours).toBe(1.625);
  expect(actual.exceedance_duration_hours).toBe(1.375);
  expect(actual.first_maximum_hours).toBe(.375);
  expect(analyzeSeries([0, 1, 2], [1, 1 + Number.EPSILON, 1], 1).maximum_mg_l).toBe(1 + Number.EPSILON);
  expect(analyzeSeries([0, 1, 2], [1, 1 + Number.EPSILON, 1], 1).exceedance_duration_hours).toBe(2);
});

test('constant below, at and above threshold and decreasing concentration are handled', () => {
  for (const value of [0, 1]) {
    const actual = analyzeSeries([0, 2], [value, value], 1);
    expect(actual.exceedance_intervals).toEqual([]);
    expect(actual.first_maximum_hours).toBe(0);
    expect(actual.minimum_mg_l).toBe(value);
  }
  expect(analyzeSeries([0, 2], [2, 2], 1).exceedance_duration_hours).toBe(2);
  expect(analyzeSeries([0, 2], [2, 0], 1).first_crossing_hours).toBeNull();
});

test('playback interpolation uses real times and clamps to calculated endpoints', () => {
  expect(valueAtTime([0, .25, 2], [10, 12, 5], .75)).toBe(10);
  expect(valueAtTime([0, .25, 2], [10, 12, 5], .25)).toBe(12);
  expect(valueAtTime([0, 2], [10, 5], -1)).toBe(10);
  expect(valueAtTime([0, 2], [10, 5], 3)).toBe(5);
});

test('invalid series and thresholds fail clearly without coercion', () => {
  for (const [t, c, h] of [
    [[], [], 1], [[0], [1], 1], [[0, 0], [1, 1], 1], [[-1, 0], [1, 1], 1],
    [[0, NaN], [1, 1], 1], [[0, 1], [1], 1], [[0, 1], [1, Infinity], 1],
    [[0, 1], [1, -1], 1], [[0, 1], [1, 1], -1], [[0, 1], [1, 1], NaN],
    [Array.from({ length: 15002 }, (_, i) => i), Array(15002).fill(1), 1],
  ] as [number[], number[], number][]) expect(() => analyzeSeries(t, c, h)).toThrow();
});

test('control segment numbers 36, 50, 100 map exactly to indices 35, 49, 99', () => {
  const points = [35, 49, 99].map(segment_index => ({ id: `k${segment_index}`, name: `K ${segment_index + 1}`, segment_index }));
  const result = { inputs: { length_m: 1000, duration_hours: 1 }, distances_m: Array.from({ length: 100 }, (_, i) => (i + .5) * 10), times_hours: [0, 1], concentrations_mg_l: [Array.from({ length: 100 }, (_, i) => i), Array.from({ length: 100 }, (_, i) => i + 1)] };
  const summaries = summarizeControlPoints(result, { points, threshold_mg_l: null });
  expect(summaries.map(s => [s.segment_number, s.segment_start_m, s.segment_center_m, s.segment_end_m, s.metrics.maximum_mg_l])).toEqual([[36, 350, 355, 360, 36], [50, 490, 495, 500, 50], [100, 990, 995, 1000, 100]]);
});
