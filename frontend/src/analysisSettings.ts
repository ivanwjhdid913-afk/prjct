/** Analysis belongs to the selected 100-segment geometry, independently of solver inputs. */
export type ControlPoint = { id: string; name: string; segment_index: number };
export type AnalysisSettings = { points: ControlPoint[]; threshold_mg_l: number | null };

export function emptyAnalysisSettings(): AnalysisSettings {
  return { points: [], threshold_mg_l: null };
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function validAnalysisSettings(value: unknown): value is AnalysisSettings {
  if (!record(value) || Object.keys(value).some(key => !['points', 'threshold_mg_l'].includes(key))
      || !Array.isArray(value.points) || value.points.length > 5
      || !(value.threshold_mg_l === null || typeof value.threshold_mg_l === 'number'
        && Number.isFinite(value.threshold_mg_l) && value.threshold_mg_l >= 0)) return false;
  const ids = new Set<string>();
  const indices = new Set<number>();
  return value.points.every(point => {
    if (!record(point) || Object.keys(point).some(key => !['id', 'name', 'segment_index'].includes(key))
        || typeof point.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(point.id) || ids.has(point.id)
        || typeof point.name !== 'string' || !point.name.trim() || point.name !== point.name.trim()
        || point.name.length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(point.name)
        || !Number.isInteger(point.segment_index) || Number(point.segment_index) < 0
        || Number(point.segment_index) > 99 || indices.has(Number(point.segment_index))) return false;
    ids.add(point.id);
    indices.add(Number(point.segment_index));
    return true;
  });
}
