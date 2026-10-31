/** Shared schedule semantics for saved inputs, charts, previews and exports. */
export type LoadMode = 'continuous' | 'finite' | 'profile';
export type LoadInterval = { start_hours: number; end_hours: number; effluent_mg_l: number };
export type LoadConditions = {
  load_mode?: LoadMode; load_duration_hours?: number | null; load_intervals?: LoadInterval[] | null;
  background_mg_l: number; effluent_mg_l: number | null; duration_hours: number; effluent_flow_m3_s?: number;
};
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const concentration = (v: unknown): v is number => finite(v) && v >= 0 && v <= 10000;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function validLoadProfile<T>(inputs: T): inputs is T & LoadConditions;
export function validLoadProfile(inputs: unknown): inputs is LoadConditions {
  if (!record(inputs) || !concentration(inputs.background_mg_l)
    || !finite(inputs.duration_hours) || inputs.duration_hours <= 0) return false;
  const mode = inputs.load_mode ?? 'continuous';
  if (!(mode === 'profile' && inputs.effluent_mg_l === null) && !concentration(inputs.effluent_mg_l)) return false;
  if (mode !== 'profile') {
    if (inputs.load_intervals != null) return false;
    return mode === 'finite' ? finite(inputs.load_duration_hours) && inputs.load_duration_hours > 0
      && inputs.load_duration_hours <= inputs.duration_hours
      : mode === 'continuous' && inputs.load_duration_hours == null;
  }
  if (inputs.load_duration_hours != null || !Array.isArray(inputs.load_intervals) || inputs.load_intervals.length > 12) return false;
  let previousEnd = 0;
  for (const interval of inputs.load_intervals) {
    if (!record(interval) || Object.keys(interval).some(key => !['start_hours', 'end_hours', 'effluent_mg_l'].includes(key))
      || !finite(interval.start_hours) || !finite(interval.end_hours) || !concentration(interval.effluent_mg_l)
      || interval.start_hours < previousEnd || interval.start_hours < 0
      || interval.end_hours <= interval.start_hours || interval.end_hours > inputs.duration_hours) return false;
    previousEnd = interval.end_hours;
  }
  return true;
}
export function sourceConcentrationAt(inputs: LoadConditions, hour: number): number {
  if (inputs.load_mode === 'profile') {
    return inputs.load_intervals?.find(row => hour >= row.start_hours && hour < row.end_hours)?.effluent_mg_l ?? inputs.background_mg_l;
  }
  return inputs.load_mode === 'finite' && hour >= (inputs.load_duration_hours ?? 0)
    ? inputs.background_mg_l : inputs.effluent_mg_l!;
}
export function sourceEvents(inputs: LoadConditions): { hour: number; kind: 'start' | 'end'; concentration_mg_l: number }[] {
  if (inputs.load_mode === 'finite' && inputs.load_duration_hours != null)
    return [{ hour: inputs.load_duration_hours, kind: 'end', concentration_mg_l: inputs.background_mg_l }];
  if (inputs.load_mode !== 'profile') return [];
  const rows = inputs.load_intervals ?? [];
  const boundaries = [...new Set(rows.flatMap(row => [row.start_hours, row.end_hours]))].sort((a, b) => a - b);
  return boundaries.map(hour => ({ hour, kind: rows.some(row => row.start_hours === hour) ? 'start' : 'end',
    concentration_mg_l: sourceConcentrationAt(inputs, hour) }));
}
