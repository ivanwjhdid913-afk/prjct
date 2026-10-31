import { SCENARIO_FORMAT, validConditions, type Conditions } from './scenarioStorage';

export const MAX_CONDITIONS_FILE_BYTES = 8192;
export type ConditionsDocument = {
  name: string; format_version: number; model_id: string;
  geometry_mode: 'river' | 'synthetic'; geometry_version: string;
  geometry_sha256: string | null; downstream_geometry_sha256: string | null;
  reach_id: string | null; reach_name: string; geometry_source: Record<string, unknown>;
  conditions: Conditions;
};
export type DocumentValidation = { document: ConditionsDocument; compatibility: { compatible: boolean; reasons: string[] } };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const hash = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
export function validDocument(v: unknown): v is ConditionsDocument {
  if (!record(v) || typeof v.name !== 'string' || !v.name.trim() || v.name.length > 120
    || /[\u0000-\u001f\u007f-\u009f]/.test(v.name)
    || !Number.isSafeInteger(v.format_version) || Number(v.format_version) <= 0
    || typeof v.model_id !== 'string' || !v.model_id || v.model_id.length > 80
    || typeof v.geometry_version !== 'string' || !v.geometry_version || v.geometry_version.length > 64
    || typeof v.reach_name !== 'string' || !v.reach_name || v.reach_name.length > 200
    || !record(v.geometry_source) || !validConditions(v.conditions)) return false;
  if ((v.format_version === 1 && v.conditions.load_mode === 'profile')
    || (v.format_version === SCENARIO_FORMAT && !Object.hasOwn(v.conditions, 'load_intervals'))) return false;
  return v.geometry_mode === 'synthetic'
    ? v.reach_id === null && v.geometry_sha256 === null && v.downstream_geometry_sha256 === null && v.conditions.reach_id == null
    : v.geometry_mode === 'river' && typeof v.reach_id === 'string' && v.reach_id === v.conditions.reach_id
      && hash(v.geometry_sha256) && hash(v.downstream_geometry_sha256);
}
export function validDocumentValidation(v: unknown): v is DocumentValidation {
  if (!record(v) || !validDocument(v.document) || !record(v.compatibility)) return false;
  const c = v.compatibility;
  return typeof c.compatible === 'boolean' && Array.isArray(c.reasons) && c.reasons.length <= 20
    && c.reasons.every(reason => typeof reason === 'string' && reason.length <= 1000)
    && (c.compatible ? c.reasons.length === 0 : c.reasons.length > 0);
}
export function documentFromSaved(v: unknown): ConditionsDocument {
  if (!record(v) || !record(v.conditions)) throw new Error('Сервер вернул неполную сохранённую запись.');
  const conditions = { ...structuredClone(v.conditions), reach_id: v.conditions.reach_id ?? null, source_distance_m: v.conditions.source_distance_m ?? 0 };
  const document = {
    name: v.name, format_version: v.format_version, model_id: v.model_id,
    geometry_mode: v.geometry_mode, geometry_version: v.geometry_version,
    geometry_sha256: v.geometry_sha256, downstream_geometry_sha256: v.downstream_geometry_sha256 ?? null,
    reach_id: v.reach_id ?? v.conditions.reach_id ?? null, reach_name: v.reach_name,
    geometry_source: structuredClone(v.geometry_source ?? {}), conditions,
  };
  if (!validDocument(document)) throw new Error('Сохранённая запись не содержит полного переносимого набора условий.');
  return document;
}
export function downloadConditions(document: ConditionsDocument) {
  if (!validDocument(document)) throw new Error('Проверьте название, условия и сведения о геометрии перед выгрузкой.');
  const text = JSON.stringify(document, null, 2) + '\n';
  if (new TextEncoder().encode(text).byteLength > MAX_CONDITIONS_FILE_BYTES) throw new Error('Файл условий превышает 8192 байта. Сократите название или сведения о геометрии.');
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const anchor = window.document.createElement('a');
  anchor.href = url;
  const base = document.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').slice(0, 80) || 'условия-сценария';
  anchor.download = `${base}.json`; anchor.hidden = true;
  window.document.body.append(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
