import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { matrixLabels, safeSourceUrl, validDischargeCatalog } from '../src/dischargeCatalog';
import type { Coordinate, DischargeCatalog } from '../src/dischargeCatalog';

const checkedIn: DischargeCatalog = JSON.parse(readFileSync('../backend/data/discharges/catalog.v1.json', 'utf8'));

function fixture(): DischargeCatalog {
  const source = { ...checkedIn.sources[0], id: 'source' };
  const item = structuredClone(checkedIn.items[0]);
  Object.assign(item, { id: 'object', coordinates: null, receiver: null,
    evidence: [{ source_id: source.id, locator: 'p. 1', statement: 'Documentary evidence.',
      period: '2022', quantity: null, conversion: null }],
    missing: ['Outfall and hydraulic data'], readiness: 'insufficient',
    prepared_reach: { status: 'not_established', reach_id: null, explanation: 'No documented match.' },
    matrix: Object.fromEntries(Object.keys(matrixLabels).map(key => [key,
      { status: 'missing', note: 'Not stated in the document.', source_ids: [] }])) });
  return { format_version: 1, checked_on: '2026-10-30', sources: [source], items: [item] };
}

function coordinate(kind: Coordinate['kind'] = 'outfall'): Coordinate {
  return { longitude: 39.6, latitude: 52.6, crs: 'EPSG:4326', kind,
    description: 'Documented coordinate meaning.', source_id: 'source', locator: 'p. 1' };
}

function readyFixture(): DischargeCatalog {
  const result = fixture();
  const item = result.items[0];
  Object.assign(item, { coordinates: coordinate(), missing: [], readiness: 'ready',
    prepared_reach: { status: 'matched', reach_id: 'voronezh-zheltye-peski', explanation: 'Documented outfall match.' } });
  for (const cell of Object.values(item.matrix)) Object.assign(cell, { status: 'available', source_ids: ['source'] });
  return result;
}

test('accepts checked-in evidence without assigning coordinates or a calculation', () => {
  expect(validDischargeCatalog(checkedIn)).toBe(true);
  expect(checkedIn.items.every(item => item.coordinates === null && item.readiness === 'insufficient')).toBe(true);
  const rvk = checkedIn.items.find(item => item.id === 'rvk-lipetsk-cosk')!;
  const measured = rvk.evidence.filter(e => e.quantity?.parameter === 'Хлориды: концентрация на выходе ЦОСК');
  expect(measured.map(e => e.quantity!.value)).toEqual([127, 147, 130, 143, 114, 104.6, 98, 122, 109, 112, 137, 115]);
  expect(measured.every(e => e.period.startsWith('2022, ') && e.quantity?.unit === 'мг/дм³' && e.quantity.basis === 'actual')).toBe(true);
  expect(rvk.evidence.find(e => e.quantity?.value === 136.5)?.quantity?.basis).toBe('permitted');
  expect(rvk.evidence.find(e => e.quantity?.value === 112.7)?.quantity?.unit).toBe('тыс. м³/сут');
});

test('rejects false ready on an incomplete item without an outfall or matched reach', () => {
  const catalog = fixture();
  catalog.items[0].readiness = 'ready';
  expect(validDischargeCatalog(catalog)).toBe(false);
});

test('accepts a complete documented known-reach outfall and preserves enterprise meaning', () => {
  expect(validDischargeCatalog(fixture())).toBe(true);
  expect(validDischargeCatalog(readyFixture())).toBe(true);
  const enterprise = fixture();
  enterprise.items[0].coordinates = coordinate('enterprise');
  expect(validDischargeCatalog(enterprise)).toBe(true);
  expect(enterprise.items[0].coordinates?.kind).toBe('enterprise');
});

const invalidItems: [string, (c: DischargeCatalog) => void][] = [
  ['ready with missing data', c => c.items[0].missing.push('Flow')],
  ['ready with partial matrix', c => c.items[0].matrix.background.status = 'partial'],
  ['ready without match', c => Object.assign(c.items[0].prepared_reach, { status: 'outside', reach_id: null })],
  ['matched missing coordinate', c => c.items[0].coordinates = null],
  ['matched enterprise coordinate', c => c.items[0].coordinates = coordinate('enterprise')],
  ['matched unknown reach', c => c.items[0].prepared_reach.reach_id = 'nearest-pilot'],
  ['unmatched substitute reach', c => c.items[0].prepared_reach.status = 'not_established'],
  ['available outfall with enterprise coordinate', c => {
    Object.assign(c.items[0], { readiness: 'insufficient', coordinates: coordinate('enterprise') });
    Object.assign(c.items[0].prepared_reach, { status: 'not_established', reach_id: null });
  }],
  ['matrix duplicate references', c => c.items[0].matrix.channel.source_ids.push('source')],
  ['available without source', c => c.items[0].matrix.channel.source_ids = []],
  ['partial without source', c => Object.assign(c.items[0].matrix.channel, { status: 'partial', source_ids: [] })],
  ['coordinate unknown source', c => c.items[0].coordinates!.source_id = 'absent'],
  ['evidence unknown source', c => c.items[0].evidence[0].source_id = 'absent'],
  ['matrix unknown source', c => c.items[0].matrix.channel.source_ids = ['absent']],
  ['nonfinite longitude', c => c.items[0].coordinates!.longitude = Infinity],
  ['latitude outside Earth', c => c.items[0].coordinates!.latitude = 91],
  ['duplicate item IDs', c => c.items.push(structuredClone(c.items[0]))],
  ['duplicate source IDs', c => c.sources.push(structuredClone(c.sources[0]))],
  ['source checked after catalog', c => c.sources[0].checked_on = '2026-10-31'],
  ['publication after source check', c => c.sources[0].published_on = '2026-10-31'],
  ['unknown publication text', c => c.sources[0].publication_note = ' '],
  ['invalid publication date', c => c.sources[0].published_on = '2026-02-30'],
  ['invalid SHA', c => c.sources[0].sha256 = 'not-a-sha'],
  ['control character text', c => c.items[0].name = 'facility\u0000name'],
];
for (const [name, mutate] of invalidItems) test(`rejects ${name}`, () => {
  const catalog = readyFixture();
  mutate(catalog);
  expect(validDischargeCatalog(catalog)).toBe(false);
});

for (const period of ['unknown', ' ', '2023–2022', '2023 - 2022', '2023/2022',
  '2022-12-01–2022-01-01', '2022-12—2022-01', '2022-02-30', '2023-02-29',
  '2022-00', '2022-13', '2027', '2026-12', '2026-10-31']) {
  test(`rejects invalid evidence period ${JSON.stringify(period)}`, () => {
    const catalog = fixture();
    catalog.items[0].evidence[0].period = period;
    expect(validDischargeCatalog(catalog)).toBe(false);
  });
}
for (const period of ['2022', '2022, январь', '2020–2021 (период мониторинга)',
  '2022-02', '2024-02-29', '2022-01-01–2022-12-31', '2026-10-30']) {
  test(`preserves valid documentary precision ${JSON.stringify(period)}`, () => {
    const catalog = fixture();
    catalog.items[0].evidence[0].period = period;
    expect(validDischargeCatalog(catalog)).toBe(true);
    expect(catalog.items[0].evidence[0].period).toBe(period);
  });
}

for (const url of ['javascript:alert(1)', 'data:text/html,unsafe', 'https://user:secret@example.org',
  'https://@example.org', ' https://example.org', 'https://example.org/a b',
  'https://example.org/a\nb', 'https://example.org/a\tb', 'https://example.org/\\evil',
  'https:///example.org', 'https://example.org:65536', 'https://example.org:wrong']) {
  test(`rejects malformed source URL ${JSON.stringify(url)}`, () => {
    expect(safeSourceUrl(url)).toBe(false);
    const catalog = fixture();
    catalog.sources[0].url = url;
    expect(validDischargeCatalog(catalog)).toBe(false);
  });
}
test('accepts safe source URL with an explicit legal port', () => {
  expect(safeSourceUrl('https://example.org:8443/path?q=value#table')).toBe(true);
});

test('requires literal string enums without array coercion', () => {
  const catalog = fixture();
  catalog.items[0].coordinates = coordinate('enterprise');
  Object.assign(catalog.items[0].coordinates, { kind: ['enterprise'] });
  expect(validDischargeCatalog(catalog)).toBe(false);
  const reach = fixture();
  Object.assign(reach.items[0].prepared_reach, { status: ['outside'] });
  expect(validDischargeCatalog(reach)).toBe(false);
});

const extraTargets = ['catalog', 'source', 'item', 'coordinate', 'evidence', 'quantity', 'prepared_reach', 'matrix', 'cell'] as const;
for (const target of extraTargets) test(`rejects undeclared fields in ${target}`, () => {
  const catalog = readyFixture();
  const item = catalog.items[0];
  item.evidence[0].quantity = { parameter: 'Chlorides', value: 127, unit: 'мг/дм³', basis: 'actual', scope: 'Outlet' };
  const targets = { catalog, source: catalog.sources[0], item, coordinate: item.coordinates!,
    evidence: item.evidence[0], quantity: item.evidence[0].quantity,
    prepared_reach: item.prepared_reach, matrix: item.matrix, cell: item.matrix.channel };
  Object.assign(targets[target], { undeclared: 'not in v1' });
  expect(validDischargeCatalog(catalog)).toBe(false);
});

for (const value of [NaN, Infinity, -1, true, '127', null]) test(`rejects invalid quantity ${String(value)}`, () => {
  const catalog = fixture();
  Object.assign(catalog.items[0].evidence[0], { quantity: { parameter: 'Chlorides', value, unit: 'мг/дм³', basis: 'actual', scope: 'Outlet' } });
  expect(validDischargeCatalog(catalog)).toBe(false);
});
for (const [field, value] of [['unit', ''], ['scope', ' '], ['parameter', ''], ['basis', 'estimated']]) {
  test(`requires explicit quantity ${field}`, () => {
    const catalog = fixture();
    const quantity = { parameter: 'Chlorides', value: 127, unit: 'мг/дм³', basis: 'actual', scope: 'Outlet' };
    Object.assign(quantity, { [field]: value });
    Object.assign(catalog.items[0].evidence[0], { quantity });
    expect(validDischargeCatalog(catalog)).toBe(false);
  });
}

test('keeps resource bounds and accepts an explicitly empty catalog', () => {
  const catalog = fixture();
  catalog.items[0].evidence = Array.from({ length: 100 }, () => structuredClone(catalog.items[0].evidence[0]));
  expect(validDischargeCatalog(catalog)).toBe(true);
  catalog.items[0].evidence.push(structuredClone(catalog.items[0].evidence[0]));
  expect(validDischargeCatalog(catalog)).toBe(false);
  const sources = fixture();
  sources.sources = Array.from({ length: 50 }, (_, index) => ({ ...sources.sources[0], id: index === 0 ? 'source' : `source-${index}` }));
  expect(validDischargeCatalog(sources)).toBe(true);
  sources.sources.push({ ...sources.sources[0], id: 'source-51' });
  expect(validDischargeCatalog(sources)).toBe(false);
  expect(validDischargeCatalog({ ...fixture(), sources: [] })).toBe(false);
  expect(validDischargeCatalog({ ...fixture(), items: [] })).toBe(true);
  expect(validDischargeCatalog({ format_version: 1, checked_on: '2026-10-30', sources: [], items: [] })).toBe(true);
  const items = fixture();
  items.items = Array.from({ length: 50 }, (_, index) => ({ ...items.items[0], id: `item-${index}` }));
  expect(validDischargeCatalog(items)).toBe(true);
  items.items.push({ ...items.items[0], id: 'item-51' });
  expect(validDischargeCatalog(items)).toBe(false);
});

const malformedCollections: [string, (c: DischargeCatalog) => void][] = [
  ['sources', c => Object.assign(c, { sources: {} })],
  ['items', c => Object.assign(c, { items: {} })],
  ['evidence', c => Object.assign(c.items[0], { evidence: {} })],
  ['missing', c => Object.assign(c.items[0], { missing: {} })],
  ['source IDs', c => Object.assign(c.items[0].matrix.channel, { source_ids: {} })],
  ['matrix as array', c => Object.assign(c.items[0], { matrix: [] })],
  ['missing matrix key', c => { Reflect.deleteProperty(c.items[0].matrix, 'channel'); }],
  ['missing explicit null', c => { Reflect.deleteProperty(c.items[0], 'receiver'); }],
  ['missing evidence period', c => { Reflect.deleteProperty(c.items[0].evidence[0], 'period'); }],
];
for (const [name, mutate] of malformedCollections) test(`rejects malformed or missing ${name}`, () => {
  const catalog = fixture();
  mutate(catalog);
  expect(validDischargeCatalog(catalog)).toBe(false);
});
