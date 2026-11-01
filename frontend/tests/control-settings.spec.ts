import { test, expect } from '@playwright/test';
import { parseThreshold, settingsForGeometry } from '../src/controlPointSettings';
import { multipleComparisonReason, type MultipleResult } from '../src/multipleSources';

test('empty and zero threshold differ and invalid drafts never become zero', () => {
  expect(parseThreshold(' ')).toBeNull();
  expect(parseThreshold('0')).toBe(0);
  expect(parseThreshold('10.2')).toBe(10.2);
  for (const input of ['-', '-1', 'NaN', 'Infinity', '1,2', '0x10']) expect(() => parseThreshold(input)).toThrow();
});

test('A/B refuses different verified continuation snapshots', () => {
  const a = { model_id: 'model', reach_id: 'reach', inputs: { duration_hours: 1, length_m: 1000 },
    geometry: {}, segment_geometries: [], distances_m: [5],
    reach_metadata: { geometry_sha256: 'same', downstream_geometry_sha256: 'original' } } as unknown as MultipleResult;
  const b = { ...a, reach_metadata: { ...a.reach_metadata, downstream_geometry_sha256: 'changed' } };
  expect(multipleComparisonReason(a, b)).not.toBe('');
});
test('analysis settings never move silently to another geometry and exports clone applied values', () => {
  const settings = { points: [{ id: 'k1', name: 'Точка', segment_index: 35 }], threshold_mg_l: 0 };
  expect(() => settingsForGeometry(settings, 'don/hash', 'voronezh/hash')).toThrow('геометр');
  const exported = settingsForGeometry(settings, 'don/hash', 'don/hash');
  exported.points[0].name = 'Изменено';
  expect(settings.points[0].name).toBe('Точка');
  expect(settingsForGeometry({ points: [], threshold_mg_l: null }, null, 'any')).toEqual({ points: [], threshold_mg_l: null });
});
