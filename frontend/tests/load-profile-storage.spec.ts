import { expect, test } from '@playwright/test';
import { validLoadProfile, sourceConcentrationAt, sourceEvents } from '../src/loadProfile';
import { SCENARIO_FORMAT, validSaved } from '../src/scenarioStorage';
import { documentFromSaved, validDocument } from '../src/scenarioExchange';
import { buildResultCsv } from '../src/resultExport';

const legacy = { river_flow_m3_s: 10, effluent_flow_m3_s: .1, background_mg_l: 10, effluent_mg_l: 100,
  velocity_m_s: .25, dispersion_m2_s: 5, duration_hours: 4, length_m: 500, reach_id: null,
  source_distance_m: 0, load_mode: 'continuous' as const, load_duration_hours: null };
const intervals = [{ start_hours: .25, end_hours: 1, effluent_mg_l: 110.123456789 },
  { start_hours: 1, end_hours: 2, effluent_mg_l: 2 }, { start_hours: 3, end_hours: 4, effluent_mg_l: 60 }];
const profile = { ...legacy, load_mode: 'profile' as const, load_intervals: intervals };
const saved = { id: '11111111-1111-1111-1111-111111111111', name: 'Два периода', created_at: '2026-10-29T00:00:00Z',
  reach_name: 'Синтетический участок', geometry_mode: 'synthetic', geometry_version: 'synthetic-wgs84-meridian-v1',
  geometry_sha256: null, downstream_geometry_sha256: null, geometry_source: {}, reach_id: null,
  format_version: 1, model_id: 'conservative-1d-advection-dispersion-v1', load_mode: 'continuous',
  conditions: legacy, compatibility: { compatible: true, reasons: [] } };

test('legacy v1 stays readable/exportable and new profile snapshots require v2 explicit intervals', () => {
  expect(SCENARIO_FORMAT).toBe(2);
  expect(validSaved(saved)).toBe(true);
  expect(documentFromSaved(saved).conditions).not.toHaveProperty('load_intervals');
  const v2 = { ...saved, format_version: 2, load_mode: 'profile', conditions: profile };
  expect(validSaved(v2)).toBe(true);
  expect(documentFromSaved(v2).conditions.load_intervals).toEqual(intervals);
  expect(validSaved({ ...v2, format_version: 1 })).toBe(false);
  expect(validDocument({ ...documentFromSaved(saved), format_version: 2 })).toBe(false);
  expect(validSaved({ ...saved, format_version: 2 })).toBe(false);
});

test('profile guards reject missing, overlapping, unsorted, out of horizon and nonfinite rows', () => {
  expect(validLoadProfile(legacy)).toBe(true);
  expect(validLoadProfile(profile)).toBe(true);
  expect(validLoadProfile({ ...profile, load_intervals: [] })).toBe(true);
  for (const load_intervals of [null, undefined, [...intervals].reverse(),
    [{ start_hours: 0, end_hours: 5, effluent_mg_l: 10 }],
    [{ start_hours: 0, end_hours: 1, effluent_mg_l: Infinity }],
    [{ start_hours: 0, end_hours: 1, effluent_mg_l: 10001 }],
    Array.from({ length: 13 }, (_, i) => ({ start_hours: i / 10, end_hours: (i + 1) / 10, effluent_mg_l: 1 }))])
    expect(validLoadProfile({ ...profile, load_intervals })).toBe(false);
  expect(validLoadProfile({ ...profile, load_intervals: [{ start_hours: 0, end_hours: 2, effluent_mg_l: 1 }, ...intervals] })).toBe(false);
});

test('profile null scalar remains honest and legacy scalar validation stays strict', () => {
  const nullable = { ...profile, effluent_mg_l: null };
  expect(validLoadProfile(nullable)).toBe(true);
  expect(sourceConcentrationAt(nullable, 0)).toBe(10);
  expect(sourceConcentrationAt(nullable, .5)).toBe(intervals[0].effluent_mg_l);
  const v2 = { ...saved, format_version: 2, load_mode: 'profile', conditions: nullable };
  expect(validSaved(v2)).toBe(true);
  expect(documentFromSaved(v2).conditions.effluent_mg_l).toBeNull();
  const result = { inputs: nullable, distances_m: [5], times_hours: [0,4], concentrations_mg_l: [[10],[12]], format_version: 2 };
  const csv = buildResultCsv({ result, hour: 0, selected: 0, kind: 'time' });
  const metadata = JSON.parse(/,"(\{.*\})"$/.exec(csv.split('\r\n')[1])![1].replaceAll('""', '"'));
  expect(metadata.scenarios[0].inputs.effluent_mg_l).toBeNull();
  expect(metadata.scenarios[0].source_events).toEqual(sourceEvents(nullable));
  for (const effluent_mg_l of [-1, Infinity, NaN, '', undefined, 10001])
    expect(validLoadProfile({ ...nullable, effluent_mg_l })).toBe(false);
  expect(validLoadProfile({ ...legacy, effluent_mg_l: null })).toBe(false);
  expect(validLoadProfile({ ...legacy, load_mode: 'finite', load_duration_hours: 1, effluent_mg_l: null })).toBe(false);
});

test('half open source schedule exposes unique touching boundaries with right hand values', () => {
  expect([0, .25, 1, 2, 3, 4].map(t => sourceConcentrationAt(profile, t))).toEqual([10, 110.123456789, 2, 10, 60, 10]);
  expect(sourceEvents(profile)).toEqual([
    { hour: .25, kind: 'start', concentration_mg_l: 110.123456789 },
    { hour: 1, kind: 'start', concentration_mg_l: 2 },
    { hour: 2, kind: 'end', concentration_mg_l: 10 },
    { hour: 3, kind: 'start', concentration_mg_l: 60 },
    { hour: 4, kind: 'end', concentration_mg_l: 10 },
  ]);
  expect(sourceEvents({ ...legacy, load_mode: 'finite', load_duration_hours: 1.25 })).toEqual([{ hour: 1.25, kind: 'end', concentration_mg_l: 10 }]);
});

test('CSV preserves independent full profile snapshots, precision, events and units', () => {
  const a = { inputs: profile, distances_m: [5], times_hours: [0, 4], concentrations_mg_l: [[10], [12]], format_version: 2 };
  const b = structuredClone(a); b.inputs.load_intervals[0].effluent_mg_l = 73.987654321;
  const before = structuredClone([a, b]);
  const csv = buildResultCsv({ result: b, a, b, hour: 1, selected: 0, kind: 'space' });
  expect(csv).toContain('110.123456789'); expect(csv).toContain('73.987654321');
  expect(csv).toContain('source_events'); expect(csv).toContain('concentration_mg_l');
  expect(csv).toContain('hours'); expect([a, b]).toEqual(before);
  const metadata = JSON.parse(/,"(\{.*\})"$/.exec(csv.split('\r\n')[1])![1].replaceAll('""', '"'));
  expect(metadata.scenarios.map((scenario: { inputs: unknown }) => scenario.inputs)).toEqual([a.inputs, b.inputs]);
  expect(metadata.scenarios[0].source_events).toEqual(sourceEvents(a.inputs));
  expect(metadata.scenarios[1].source_events).toEqual(sourceEvents(b.inputs));
  expect(metadata.units).toMatchObject({ start_hours: 'hours', end_hours: 'hours', effluent_mg_l: 'mg/l' });
  expect(buildResultCsv({ result: a, a, b, hour: 1, selected: 0, kind: 'space' })).toBe(csv);
});

test('all twelve intervals survive portable conversion and complete CSV metadata', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => ({ start_hours: i / 4, end_hours: (i + 1) / 4,
    effluent_mg_l: 100 + i + .123456789 }));
  const inputs = { ...profile, load_intervals: twelve };
  const source = { ...saved, format_version: 2, load_mode: 'profile', conditions: inputs };
  expect(validSaved(source)).toBe(true);
  expect(documentFromSaved(source).conditions.load_intervals).toEqual(twelve);
  const result = { inputs, distances_m: [5], times_hours: [0, 4], concentrations_mg_l: [[10], [12]], format_version: 2 };
  const csv = buildResultCsv({ result, hour: 0, selected: 0, kind: 'time' });
  const metadata = JSON.parse(/,"(\{.*\})"$/.exec(csv.split('\r\n')[1])![1].replaceAll('""', '"'));
  expect(metadata.scenarios[0].inputs.load_intervals).toEqual(twelve);
  expect(metadata.scenarios[0].source_events).toEqual(sourceEvents(inputs));
});

test('portable documents and events cannot mutate their saved source snapshot', () => {
  const source = structuredClone({ ...saved, format_version: 2, load_mode: 'profile', conditions: profile,
    geometry_source: { source: 'original' } });
  const before = structuredClone(source);
  const document = documentFromSaved(source);
  document.conditions.load_intervals![0].effluent_mg_l = 777;
  document.conditions.load_intervals!.push({ start_hours: 4, end_hours: 5, effluent_mg_l: 1 });
  document.geometry_source.source = 'changed';
  const events = sourceEvents(source.conditions);
  events[0].concentration_mg_l = 999;
  expect(source).toEqual(before);
});

test('unknown formats keep a legacy preview and remain independent of v2 completeness', () => {
  expect(validDocument({ ...documentFromSaved(saved), format_version: 3 })).toBe(true);
});
