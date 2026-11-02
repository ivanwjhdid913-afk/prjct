import { test, expect } from '@playwright/test';
import { buildControlPointCsv } from '../src/controlPointExport';

test('analysis CSV preserves all strict intervals, completed metadata and A/B null crossings', () => {
  const result = {
    inputs: { length_m: 1000, duration_hours: 5 },
    distances_m: Array.from({ length: 100 }, (_, i) => (i + .5) * 10),
    times_hours: [0, 1, 2, 3, 4, 5],
    concentrations_mg_l: [10, 12, 10, 10, 12, 10].map(c => Array(100).fill(c)),
    model_id: 'physical-model-unchanged', reach_id: 'test-reach',
    reach_metadata: { geometry_sha256: 'geometry-of-completed-result' },
  };
  const settings = { points: [{ id: 'k1', name: '=FORMULA()', segment_index: 35 }], threshold_mg_l: 11 };
  const b = { ...result, concentrations_mg_l: result.times_hours.map(() => Array(100).fill(10)) };
  const csv = buildControlPointCsv({ result, a: result, b, settings, hour: .5 });
  expect(csv).toContain('physical-model-unchanged');
  expect(csv).toContain('geometry-of-completed-result');
  expect(csv).toContain("'=FORMULA()");
  expect(csv).toContain('0.5,1.5');
  expect(csv).toContain('3.5,4.5');
  expect(csv).toContain('C(t) > threshold_mg_l');
  expect(csv).toContain('from_C_le_threshold_to_C_gt_threshold');
  expect(csv).toContain('initial_exceedance_end_is_a_downcrossing');
  expect(csv).toContain('B');
  expect(csv).toContain('not_observation');
  expect(settings.points[0].name).toBe('=FORMULA()');
});

test('analysis CSV rejects changed continuation or segment domains in a comparison', () => {
  const result = { inputs: { length_m: 1000, duration_hours: 1 },
    distances_m: Array.from({ length: 100 }, (_, i) => (i + .5) * 10),
    times_hours: [0, 1], concentrations_mg_l: [Array(100).fill(10), Array(100).fill(11)],
    model_id: 'model', reach_id: 'reach', reach_metadata: { geometry_sha256: 'same', downstream_geometry_sha256: 'original' } };
  const settings = { points: [], threshold_mg_l: null };
  for (const b of [
    { ...result, reach_metadata: { ...result.reach_metadata, downstream_geometry_sha256: 'changed' } },
    { ...result, distances_m: result.distances_m.map(value => value + 1) },
  ]) expect(() => buildControlPointCsv({ result, a: result, b, settings, hour: 0 })).toThrow();
});
