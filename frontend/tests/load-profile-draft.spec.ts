import { expect, test } from '@playwright/test';
import { intervalDrafts, validateIntervalDraft, type IntervalDraft } from '../src/loadProfileDraft';

const row = (id: string, start: string, end: string, concentration: string): IntervalDraft => ({
  id, start_hours: start, end_hours: end, effluent_mg_l: concentration,
});

test('draft parser accepts empty, separated, touching and fractional intervals without changing order', () => {
  expect(validateIntervalDraft([], 6)).toEqual({ intervals: [], errors: {} });
  const separated = [row('a', '0', '.5', '100'), row('b', '2', '2.5', '60')];
  expect(validateIntervalDraft(separated, 6)).toEqual({ intervals: [
    { start_hours: 0, end_hours: .5, effluent_mg_l: 100 },
    { start_hours: 2, end_hours: 2.5, effluent_mg_l: 60 },
  ], errors: {} });
  expect(validateIntervalDraft([row('a', '0', '0.125', '0'), row('b', '0.125', '6', '10000')], 6).errors).toEqual({});
});

test('draft conversion preserves numeric values and gives every row a stable unique identifier', () => {
  const intervals = [{ start_hours: 1 / 3, end_hours: .7, effluent_mg_l: 3.4567890123456 }];
  const drafts = intervalDrafts(intervals);
  expect(drafts[0]).toMatchObject({ start_hours: String(1 / 3), end_hours: '0.7', effluent_mg_l: '3.4567890123456' });
  expect(drafts[0].id).toBeTruthy();
  expect(intervalDrafts(intervals)[0].id).not.toBe(drafts[0].id);
  expect(validateIntervalDraft(drafts, 6).intervals).toEqual(intervals);
});

for (const invalid of ['', ' ', 'NaN', 'Infinity', '-Infinity', 'abc', '1.2.3', '0x10', '1,5', true, null, undefined]) {
  test(`draft parser rejects invalid numeric values: ${String(invalid)}`, () => {
    for (const field of ['start_hours', 'end_hours', 'effluent_mg_l'] as const) {
      const draft = { ...row('a', '0', '1', '50'), [field]: invalid } as unknown as IntervalDraft;
      const result = validateIntervalDraft([draft], 6);
      expect(result.intervals).toBeNull();
      expect(result.errors.a).toBeTruthy();
    }
  });
}

test('draft parser rejects negative, zero width, overlap, out of order and out of horizon rows', () => {
  for (const draft of [row('a', '-1', '1', '50'), row('a', '0', '0', '50'), row('a', '2', '1', '50'),
    row('a', '0', '7', '50'), row('a', '0', '1', '-1'), row('a', '0', '1', '10001')]) {
    expect(validateIntervalDraft([draft], 6).errors.a).toBeTruthy();
  }
  for (const drafts of [[row('a', '0', '2', '50'), row('b', '1', '3', '60')],
    [row('a', '3', '4', '50'), row('b', '1', '2', '60')]]) {
    const result = validateIntervalDraft(drafts, 6);
    expect(result.intervals).toBeNull();
    expect(result.errors.b).toBeTruthy();
  }
});

test('draft parser requires a finite positive horizon and at most 12 rows', () => {
  for (const duration of [0, -1, NaN, Infinity, true as unknown as number]) {
    expect(validateIntervalDraft([], duration).errors._list).toBeTruthy();
  }
  const twelve = Array.from({ length: 12 }, (_, index) => row(String(index), String(index), String(index + 1), '50'));
  expect(validateIntervalDraft(twelve, 13).intervals).toHaveLength(12);
  expect(validateIntervalDraft([...twelve, row('13', '12', '13', '50')], 13).errors._list).toBeTruthy();
});

test('draft parsing leaves inputs untouched and permits every nonnegative concentration regardless of background', () => {
  const rows = [row('a', '0', '.5', '0'), row('b', '.5', '1', '5'), row('c', '2', '3', '100')];
  const original = JSON.stringify(rows);
  rows.forEach(Object.freeze);
  Object.freeze(rows);
  expect(validateIntervalDraft(rows, 6).intervals?.map(interval => interval.effluent_mg_l)).toEqual([0, 5, 100]);
  expect(JSON.stringify(rows)).toBe(original);
});
