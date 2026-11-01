import { test, expect } from '@playwright/test';
import { validSaved } from '../src/scenarioStorage';
import { documentFromSaved, validDocument } from '../src/scenarioExchange';
import { emptyAnalysisSettings, validAnalysisSettings } from '../src/analysisSettings';

const settings = { points: [
  { id: 'above', name: 'Выше второго источника', segment_index: 35 },
  { id: 'below', name: 'Ниже второго источника', segment_index: 49 },
  { id: 'end', name: 'Конец участка', segment_index: 99 },
], threshold_mg_l: 10.2 };
const saved = {
  id: '11111111-1111-1111-1111-111111111111', name: 'Анализ', created_at: '2026-10-31T00:00:00Z',
  reach_name: 'Дон', geometry_mode: 'river', geometry_version: 'river-wgs84-v1',
  geometry_sha256: 'a'.repeat(64), downstream_geometry_sha256: 'b'.repeat(64),
  geometry_source: {}, reach_id: 'don-olkhovets', format_version: 4,
  model_id: 'conservative-1d-lateral-inflow-v2', load_mode: 'multiple',
  conditions: { river_flow_m3_s: 10, background_mg_l: 10, velocity_m_s: .25,
    dispersion_m2_s: 5, duration_hours: 6, reach_id: 'don-olkhovets', sources: [
      { id: 's1', name: 'Первый', source_distance_m: 0, effluent_flow_m3_s: .1,
        effluent_mg_l: 100, load_mode: 'continuous', load_duration_hours: null, load_intervals: null },
    ] },
  analysis_settings: settings, compatibility: { compatible: true, reasons: [] },
};

test('format4 stores analysis separately and portable copies preserve it independently', () => {
  expect(validSaved(saved)).toBe(true);
  const doc = documentFromSaved(saved);
  expect(validDocument(doc)).toBe(true);
  expect(doc).toHaveProperty('analysis_settings', settings);
  expect(doc.conditions).not.toHaveProperty('analysis_settings');
  doc.analysis_settings!.points[0].name = 'Изменено';
  expect(saved.analysis_settings.points[0].name).toBe('Выше второго источника');
});

test('analysis settings validate bounds, identity, raw names and finite optional thresholds', () => {
  expect(validAnalysisSettings(settings)).toBe(true);
  for (const threshold_mg_l of [null, 0, 10.2, 1e300]) {
    expect(validAnalysisSettings({ ...settings, threshold_mg_l })).toBe(true);
  }
  const first = emptyAnalysisSettings();
  first.points.push({ id: 'x', name: 'Точка', segment_index: 0 });
  expect(emptyAnalysisSettings()).toEqual({ points: [], threshold_mg_l: null });
  expect(validAnalysisSettings({ points: [], threshold_mg_l: null })).toBe(true);
  expect(validAnalysisSettings({ points: Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: 'Точка', segment_index: i })), threshold_mg_l: 0 })).toBe(true);
  for (const invalid of [undefined, null, [], {},
    ...[-1, true, '0', NaN, Infinity].map(threshold_mg_l => ({ ...settings, threshold_mg_l })),
    { ...settings, hidden: 1 },
    { ...settings, points: Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: 'Точка', segment_index: i })) },
    { ...settings, points: settings.points.map(p => ({ ...p, id: 'duplicate' })) },
    { ...settings, points: settings.points.map(p => ({ ...p, segment_index: 0 })) },
    ...[-1, 100, 35.5, true, '35', null].map(segment_index => ({ ...settings, points: [{ ...settings.points[0], segment_index }] })),
    ...['', ' ', ' padded ', 'a'.repeat(81), 'a\x00', 'a\x85'].map(name => ({ ...settings, points: [{ ...settings.points[0], name }] })),
    ...['', 'я', 'a b', 'a'.repeat(65)].map(id => ({ ...settings, points: [{ ...settings.points[0], id }] })),
    { ...settings, points: [{ ...settings.points[0], hidden: true }] },
  ]) expect(validAnalysisSettings(invalid), JSON.stringify(invalid)).toBe(false);
});

test('format4 cannot be attached to legacy physics or silently added to format3', () => {
  const doc = documentFromSaved(saved);
  expect(validSaved({ ...saved, format_version: 3 })).toBe(false);
  expect(validDocument({ ...doc, format_version: 3 })).toBe(false);
  const conditions = { river_flow_m3_s: 10, effluent_flow_m3_s: .1, background_mg_l: 10,
    effluent_mg_l: 100, velocity_m_s: .25, dispersion_m2_s: 5, duration_hours: 6,
    load_mode: 'continuous', load_duration_hours: null, load_intervals: null,
    reach_id: 'don-olkhovets', length_m: null, source_distance_m: 0 };
  expect(validDocument({ ...doc, conditions, model_id: 'conservative-1d-advection-dispersion-v1' })).toBe(false);
});

test('format4 requires explicit valid settings; old snapshots omit absent analysis', () => {
  const { analysis_settings: omitted, ...old } = saved;
  expect(validSaved(old)).toBe(false);
  expect(validDocument({ ...documentFromSaved({ ...old, format_version: 3 }), format_version: 4 })).toBe(false);
  expect(documentFromSaved({ ...old, format_version: 3 })).not.toHaveProperty('analysis_settings');
  expect(validSaved({ ...saved, analysis_settings: { ...settings, threshold_mg_l: 0 } })).toBe(true);
  expect(validSaved({ ...saved, analysis_settings: { ...settings, threshold_mg_l: null } })).toBe(true);
  expect(validSaved({ ...saved, analysis_settings: { ...settings, threshold_mg_l: -1 } })).toBe(false);
});
