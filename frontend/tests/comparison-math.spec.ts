import { expect, test } from '@playwright/test';
import { comparisonReason, sharedScale, valuesAtHour } from '../src/scenarioComparison';

const sample = {
  inputs: { length_m: 100, duration_hours: 4 }, reach_id: 'don', source_distance_m: 0,
  geometry: { type: 'LineString', coordinates: [[39, 52], [39.1, 52.1]] },
  segment_geometries: [{ type: 'LineString', coordinates: [[39, 52], [39.1, 52.1]] }],
  distances_m: [50], times_hours: [0, 2, 4], concentrations_mg_l: [[10], [12], [14]], scale_mg_l: [10, 14],
};

test('identical results are compatible and have zero difference at fractional time', () => {
  expect(comparisonReason(sample, structuredClone(sample))).toBe('');
  expect(valuesAtHour(sample, 1.25)).toEqual([11.25]);
  expect(valuesAtHour(sample, 1.25).map((value, i) => value - valuesAtHour(sample, 1.25)[i])).toEqual([0]);
});

test('shared scale covers both complete histories and does not mutate either result', () => {
  const a = structuredClone(sample), before = structuredClone(a);
  const b = { ...sample, scale_mg_l: [5, 30], concentrations_mg_l: [[5], [30], [15]] };
  expect(sharedScale(a, b)).toEqual([5, 30]);
  expect(a).toEqual(before);
  expect(sharedScale(sample, { ...sample, scale_mg_l: [10, 10], concentrations_mg_l: [[10], [10], [10]] })).toEqual([10, 14]);
});

test('interpolation uses physical hours even for different sample times and clamps endpoints', () => {
  const b = { ...sample, times_hours: [0, 1, 4], concentrations_mg_l: [[10], [11], [14]] };
  expect(valuesAtHour(b, 2)).toEqual([12]);
  expect(valuesAtHour(b, -1)).toEqual([10]);
  expect(valuesAtHour(b, 5)).toEqual([14]);
});

test('rejects incompatible source, duration, geometry and sample positions', () => {
  for (const changed of [
    { ...sample, reach_id: 'other' },
    { ...sample, reach_id: null },
    { ...sample, source_distance_m: 1 },
    { ...sample, inputs: { ...sample.inputs, duration_hours: 3 } },
    { ...sample, inputs: { ...sample.inputs, length_m: 101 } },
    { ...sample, geometry: { ...sample.geometry, coordinates: [[39, 52], [39.2, 52.1]] } },
    { ...sample, distances_m: [51] },
  ]) expect(comparisonReason(sample, changed)).not.toBe('');
});
