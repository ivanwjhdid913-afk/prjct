// Comparison operates only on completed results; it never edits their inputs.
type ComparableResult = {
  inputs: { length_m: number; duration_hours: number };
  reach_id?: string | null;
  source_distance_m?: number;
  geometry: { type: string; coordinates: number[][] };
  segment_geometries?: { type: string; coordinates: number[][] }[] | null;
  distances_m: number[];
  times_hours: number[];
  concentrations_mg_l: number[][];
  scale_mg_l: number[];
};

export function comparisonReason(a: ComparableResult, b: ComparableResult): string {
  if ((a.reach_id ?? null) !== (b.reach_id ?? null)) return 'Для сравнения нужен один и тот же участок и режим геометрии.';
  if ((a.source_distance_m ?? 0) !== (b.source_distance_m ?? 0)) return 'Для сравнения положение источника должно совпадать с А.';
  if (a.inputs.duration_hours !== b.inputs.duration_hours) return 'Для сравнения длительность должна совпадать с А.';
  if (a.inputs.length_m !== b.inputs.length_m
    || JSON.stringify(a.geometry) !== JSON.stringify(b.geometry)
    || JSON.stringify(a.segment_geometries ?? null) !== JSON.stringify(b.segment_geometries ?? null)
    || JSON.stringify(a.distances_m) !== JSON.stringify(b.distances_m)) return 'Для сравнения нужны одинаковые геометрия и расчётные сегменты.';
  return '';
}

export function sharedScale(a: ComparableResult, b: ComparableResult): [number, number] {
  let minimum = Math.min(a.scale_mg_l[0], b.scale_mg_l[0]);
  let maximum = Math.max(a.scale_mg_l[1], b.scale_mg_l[1]);
  for (const result of [a, b]) for (const row of result.concentrations_mg_l) for (const value of row) {
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  return [minimum, maximum];
}

export function valuesAtHour(result: Pick<ComparableResult, 'times_hours' | 'concentrations_mg_l'>, hour: number): number[] {
  const last = result.times_hours.length - 1;
  if (hour <= result.times_hours[0]) return [...result.concentrations_mg_l[0]];
  if (hour >= result.times_hours[last]) return [...result.concentrations_mg_l[last]];
  const upper = result.times_hours.findIndex(time => time >= hour);
  const lower = upper - 1;
  const fraction = (hour - result.times_hours[lower]) / (result.times_hours[upper] - result.times_hours[lower]);
  return result.concentrations_mg_l[lower].map((value, index) => value + fraction * (result.concentrations_mg_l[upper][index] - value));
}
