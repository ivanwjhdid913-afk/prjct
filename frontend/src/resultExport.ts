import { valuesAtHour } from './scenarioComparison';
import { sourceEvents, validLoadProfile } from './loadProfile';

export type ExportResult = {
  inputs: Record<string, unknown> & { length_m: number; duration_hours: number };
  distances_m: number[]; times_hours: number[]; concentrations_mg_l: number[][];
  reach_id?: string | null; source_distance_m?: number; source_coordinate?: [number, number] | null;
  reach_metadata?: Record<string, unknown> | null; temporal_resolution?: unknown;
  model_id?: string; format_version?: number;
};
export type ExportSelection = { result: ExportResult; a?: ExportResult | null; b?: ExportResult | null; hour: number; selected: number; kind: 'space' | 'time' };

export function csvCell(value: string | number): string {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Нельзя выгрузить неконечное число.');
  const text = String(value);
  return /[,"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function at(result: ExportResult, hour: number) {
  // Preserve stored states exactly, including extrema. Interpolation is used
  // only when this scenario has no saved state at the chosen physical time.
  const index = result.times_hours.indexOf(hour);
  return index >= 0 ? { values: result.concentrations_mg_l[index], method: 'saved_state' }
    : { values: valuesAtHour(result, hour), method: 'linear_interpolation' };
}
function provenance(result: ExportResult, label: string) {
  return {
    label, model_id: result.model_id ?? null, format_version: result.format_version ?? null,
    version_status: result.model_id && result.format_version ? 'declared_by_calculation_api' : 'not_declared_by_legacy_response',
    geometry_mode: result.reach_id ? 'river' : 'synthetic', reach_id: result.reach_id ?? null,
    reach_name: result.reach_metadata?.name ?? 'Синтетический участок',
    geometry_version: result.reach_id ? 'river-wgs84-v1' : 'synthetic-wgs84-meridian-v1',
    geometry_sha256: result.reach_metadata?.geometry_sha256 ?? null,
    downstream_geometry_sha256: result.reach_metadata?.downstream_geometry_sha256 ?? null,
    geometry_source: Object.fromEntries(['name', 'source', 'source_url', 'attribution', 'license', 'license_url', 'crs', 'snapshot_date', 'osm_way_id', 'osm_way_version', 'osm_way_timestamp', 'raw_sha256'].filter(key => result.reach_metadata && key in result.reach_metadata).map(key => [key, result.reach_metadata![key]])),
    source_distance_m: result.source_distance_m ?? 0, source_coordinate: result.source_coordinate ?? null,
    inputs: result.inputs, temporal_resolution: result.temporal_resolution ?? null,
    source_events: validLoadProfile(result.inputs) ? sourceEvents(result.inputs) : null,
  };
}
export function buildResultCsv(selection: ExportSelection): string {
  const { hour, selected, kind } = selection;
  const comparison = !!(selection.a && selection.b);
  const primary = comparison ? selection.a! : selection.result;
  const secondary = comparison ? selection.b! : null;
  if (!Number.isFinite(hour) || hour < 0 || hour > primary.inputs.duration_hours)
    throw new Error('Выберите допустимое модельное время.');
  if (!Number.isInteger(selected) || selected < 0 || selected >= primary.distances_m.length)
    throw new Error('Выберите расчётный сегмент.');
  const columns = ['record_type', 'time_hours', 'distance_from_source_m', 'segment_index',
    ...(secondary ? ['concentration_A_mg_l', 'concentration_B_mg_l', 'delta_B_minus_A_mg_l', 'method_A', 'method_B'] : ['concentration_mg_l', 'method']), 'metadata_json'];
  const metadata = {
    csv_format_version: 1, kind: kind === 'space' ? 'C(x)' : 'C(t)',
    selected_time_hours: kind === 'space' ? hour : null,
    selected_segment_index: kind === 'time' ? selected + 1 : null,
    units: { time: 'hours', distance: 'm_from_scenario_source', concentration: 'mg/l', river_flow_m3_s: 'm3/s', effluent_flow_m3_s: 'm3/s', velocity_m_s: 'm/s', dispersion_m2_s: 'm2/s', start_hours: 'hours', end_hours: 'hours', effluent_mg_l: 'mg/l', source_events_hour: 'hours', source_events_concentration_mg_l: 'mg/l' },
    concentration_meaning: 'calculated_segment_mean_not_observation',
    time_meaning: 'saved_state_or_linear_interpolation_not_additional_integrator_step',
    provenance: 'scenario_parameters_not_confirmed_industrial_discharge',
    scenarios: [provenance(primary, comparison ? 'A' : 'result'), ...(secondary ? [provenance(secondary, 'B')] : [])],
  };
  const rows: (string | number)[][] = [columns, ['metadata', ...Array(columns.length - 2).fill(''), JSON.stringify(metadata)]];
  function append(time: number, segment: number, first: ReturnType<typeof at>, second: ReturnType<typeof at> | null) {
    const value = first.values[segment];
    rows.push(['data', time, primary.distances_m[segment], segment + 1,
      ...(second ? [value, second.values[segment], second.values[segment] - value, first.method, second.method] : [value, first.method]), '']);
  }
  if (kind === 'space') {
    const first = at(primary, hour), second = secondary ? at(secondary, hour) : null;
    primary.distances_m.forEach((_, index) => append(hour, index, first, second));
  } else {
    const times = secondary ? [...new Set([...primary.times_hours, ...secondary.times_hours])].sort((a, b) => a - b) : primary.times_hours;
    if (times.length > 4096) throw new Error('Слишком большая временная сетка для выгрузки.');
    for (const time of times) append(time, selected, at(primary, time), secondary ? at(secondary, time) : null);
  }
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
export function downloadText(text: string, name: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name;
  document.body.append(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
