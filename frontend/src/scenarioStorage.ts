// Identifies the supported condition format and numerical implementation.
// Changing the implementation requires an explicit compatibility decision.
import { validLoadProfile, type LoadMode, type LoadInterval } from './loadProfile';

export const SCENARIO_FORMAT = 2;
export const MODEL_ID = 'conservative-1d-advection-dispersion-v1';
export const MULTIPLE_FORMAT = 3;
export const MULTIPLE_MODEL_ID = 'conservative-1d-lateral-inflow-v2';
export const RIVER_VERSION = 'river-wgs84-v1';
export const SYNTHETIC_VERSION = 'synthetic-wgs84-meridian-v1';

export type Conditions = {
  river_flow_m3_s: number; effluent_flow_m3_s: number; background_mg_l: number;
  effluent_mg_l: number | null; velocity_m_s: number; dispersion_m2_s: number;
  duration_hours: number; length_m?: number | null; reach_id?: string | null;
  source_distance_m?: number; load_mode: LoadMode; load_duration_hours: number | null;
  load_intervals?: LoadInterval[] | null;
};
export type ScenarioSource = {
  id: string; name: string; source_distance_m: number; effluent_flow_m3_s: number;
  effluent_mg_l: number | null; load_mode: LoadMode; load_duration_hours: number | null;
  load_intervals: LoadInterval[] | null;
};
export type MultipleConditions = {
  river_flow_m3_s: number; background_mg_l: number; velocity_m_s: number; dispersion_m2_s: number;
  duration_hours: number; reach_id: string; sources: ScenarioSource[];
};
export type ScenarioConditions = Conditions | MultipleConditions;
export function isMultipleConditions(v: ScenarioConditions | unknown): v is MultipleConditions {
  return !!v && typeof v === 'object' && Array.isArray((v as { sources?: unknown }).sources);
}
export type SavePayload = {
  format_version: number; model_id: string; geometry_version: string;
  geometry_sha256: string | null; conditions: ScenarioConditions;
};
export type ScenarioSummary = {
  id: string; name: string; reach_name: string; geometry_mode: 'river' | 'synthetic';
  load_mode: LoadMode | 'multiple'; created_at: string;
};
export type SavedScenario = ScenarioSummary & SavePayload & {
  compatibility: { compatible: boolean; reasons: string[] };
};
export type ScenarioPage = { items: ScenarioSummary[]; total: number; limit: number; offset: number };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validSummary(v: unknown): v is ScenarioSummary {
  return record(v) && typeof v.id === 'string' && uuid.test(v.id)
    && typeof v.name === 'string' && v.name.length > 0 && v.name.length <= 120
    && typeof v.reach_name === 'string' && v.reach_name.length > 0 && v.reach_name.length <= 500
    && (v.geometry_mode === 'river' || v.geometry_mode === 'synthetic')
    && (v.load_mode === 'continuous' || v.load_mode === 'finite' || v.load_mode === 'profile' || v.load_mode === 'multiple')
    && typeof v.created_at === 'string' && Number.isFinite(Date.parse(v.created_at));
}
export function validPage(v: unknown, offset: number): v is ScenarioPage {
  return record(v) && Array.isArray(v.items) && v.items.length <= 20 && v.items.every(validSummary)
    && Number.isSafeInteger(v.total) && Number(v.total) >= 0
    && v.limit === 20 && v.offset === offset && v.items.length <= Math.max(0, Number(v.total) - offset);
}
export function validCompatibility(v: unknown): v is SavedScenario {
  if (!record(v)) return false;
  const compatibility = v.compatibility;
  return validSummary(v) && record(compatibility) && typeof compatibility.compatible === 'boolean'
    && Array.isArray(compatibility.reasons) && compatibility.reasons.length <= 20
    && compatibility.reasons.every(reason => typeof reason === 'string' && reason.length <= 1000)
    && (compatibility.compatible ? compatibility.reasons.length === 0 : compatibility.reasons.length > 0);
}
export function validConditions(v: unknown): v is Conditions {
  if (!record(v) || 'sources' in v) return false;
  const ranges = { river_flow_m3_s: [.1, 1000], effluent_flow_m3_s: [0, 100], background_mg_l: [0, 10000], velocity_m_s: [.02, 2], dispersion_m2_s: [.1, 100], duration_hours: [.1, 48] };
  if (!Object.entries(ranges).every(([key, [min, max]]) => finite(v[key]) && v[key] >= min && v[key] <= max)) return false;
  if (!validLoadProfile(v) || !['continuous', 'finite', 'profile'].includes(String(v.load_mode)) || v.load_duration_hours === undefined) return false;
  return v.reach_id == null
    ? finite(v.length_m) && v.length_m >= 100 && v.length_m <= 20000 && (v.source_distance_m == null || v.source_distance_m === 0)
    : typeof v.reach_id === 'string' && v.reach_id.length > 0 && v.reach_id.length <= 80 && v.length_m == null && finite(v.source_distance_m) && v.source_distance_m >= 0 && v.source_distance_m <= 20000;
}
export function validMultipleConditions(v: unknown): v is MultipleConditions {
  if (!record(v)) return false;
  const keys = ['river_flow_m3_s','background_mg_l','velocity_m_s','dispersion_m2_s','duration_hours','reach_id','sources'];
  if (Object.keys(v).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(v,key))) return false;
  const ranges = {river_flow_m3_s:[.1,1000],background_mg_l:[0,10000],velocity_m_s:[.02,2],dispersion_m2_s:[.1,100],duration_hours:[.1,48]};
  if (!Object.entries(ranges).every(([key,[low,high]])=>finite(v[key])&&v[key]>=low&&v[key]<=high)
      || typeof v.reach_id !== 'string' || !v.reach_id || v.reach_id.length>80
      || !Array.isArray(v.sources) || v.sources.length<1 || v.sources.length>3) return false;
  const ids = new Set<string>();
  const sourceKeys = ['id','name','source_distance_m','effluent_flow_m3_s','effluent_mg_l','load_mode','load_duration_hours','load_intervals'];
  return v.sources.every(source => {
    if (!record(source) || Object.keys(source).some(key=>!sourceKeys.includes(key)) || sourceKeys.some(key=>!Object.hasOwn(source,key))
      || typeof source.id!=='string' || !/^[A-Za-z0-9_-]{1,64}$/.test(source.id) || ids.has(source.id)
      || typeof source.name!=='string' || !source.name.trim() || source.name.length>80 || source.name!==source.name.trim()
      || /[\u0000-\u001f\u007f-\u009f]/.test(source.name)
      || !finite(source.source_distance_m) || source.source_distance_m<0 || source.source_distance_m>19900
      || !finite(source.effluent_flow_m3_s) || source.effluent_flow_m3_s<0 || source.effluent_flow_m3_s>100
      || !['continuous','finite','profile'].includes(String(source.load_mode))) return false;
    ids.add(source.id);
    return validLoadProfile({...source,background_mg_l:v.background_mg_l,duration_hours:v.duration_hours});
  });
}
export function validScenarioConditions(v: unknown): v is ScenarioConditions {
  return validConditions(v) || validMultipleConditions(v);
}
export function validSaved(v: unknown): v is SavedScenario {
  if (!validCompatibility(v)) return false;
  const multiple = isMultipleConditions(v.conditions);
  if (multiple ? v.format_version!==MULTIPLE_FORMAT || v.model_id!==MULTIPLE_MODEL_ID || v.load_mode!=='multiple' || !validMultipleConditions(v.conditions)
      : !((v.format_version===1 || v.format_version===SCENARIO_FORMAT) && v.model_id===MODEL_ID && validConditions(v.conditions)
          && v.load_mode===v.conditions.load_mode && (v.format_version===1 ? v.conditions.load_mode!=='profile' : Object.hasOwn(v.conditions,'load_intervals')))) return false;
  return v.conditions.reach_id == null
    ? v.geometry_mode==='synthetic' && v.geometry_version===SYNTHETIC_VERSION && v.geometry_sha256===null
    : v.geometry_mode==='river' && v.geometry_version===RIVER_VERSION && typeof v.geometry_sha256==='string' && /^[0-9a-f]{64}$/.test(v.geometry_sha256);
}

export async function responseData(response: Response): Promise<unknown> {
  const data: unknown = await response.json();
  if (!response.ok) {
    const detail = record(data) ? data.detail : null;
    throw new Error(typeof detail === 'string' ? detail : response.status === 422 ? 'Проверьте название и условия: сервер отклонил запись.' : 'Библиотека недоступна. Проверьте соединение и повторите запрос.');
  }
  return data;
}
