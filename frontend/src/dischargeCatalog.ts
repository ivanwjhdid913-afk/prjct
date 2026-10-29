export const matrixLabels = {
  outfall_position: 'Положение выпуска', channel: 'Русло и направление', river_flow: 'Расход реки',
  effluent_flow: 'Расход стоков', background: 'Фоновая концентрация', substance_load: 'Хлориды: концентрация / нагрузка',
  time_regime: 'Временной режим', velocity_dispersion: 'Скорость и дисперсия', observations: 'Наблюдения для проверки',
} as const;
export type MatrixKey = keyof typeof matrixLabels;
export const cellLabels = { missing: 'Нет данных', partial: 'Частично', available: 'Есть сведения', not_applicable: 'Неприменимо' } as const;
export const readinessLabels = { insufficient: 'Данных недостаточно', assumptions: 'Только с допущениями', ready: 'Можно поставить задачу' } as const;
export const basisLabels = { actual: 'Фактический показатель', permitted: 'Разрешённое значение', capacity: 'Проектная / техническая величина', organisation_total: 'Сумма по организации' } as const;
export type Source = { id: string; title: string; publisher: string; url: string; published_on: string | null; publication_note: string; checked_on: string; document_id: string; sha256: string | null; acquisition: string; redistribution: string };
export type Coordinate = { longitude: number; latitude: number; crs: 'EPSG:4326'; kind: 'enterprise' | 'outfall'; description: string; source_id: string; locator: string };
export type Evidence = { source_id: string; locator: string; statement: string; period: string; quantity: null | { parameter: string; value: number; unit: string; basis: keyof typeof basisLabels; scope: string }; conversion: string | null };
export type Cell = { status: keyof typeof cellLabels; note: string; source_ids: string[] };
export type DischargeItem = { id: string; name: string; kind: string; location_description: string; receiver: string | null; receiver_note: string; discharge_summary: string; coordinates: Coordinate | null; evidence: Evidence[]; missing: string[]; readiness: keyof typeof readinessLabels; readiness_reason: string; prepared_reach: { status: 'not_established' | 'outside' | 'matched'; reach_id: string | null; explanation: string }; matrix: Record<MatrixKey, Cell> };
export type DischargeCatalog = { format_version: 1; checked_on: string; sources: Source[]; items: DischargeItem[] };

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 15000;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
export function safeSourceUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 4096) return false;
  try { const url = new URL(v); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}
function source(v: unknown): v is Source {
  return record(v) && ['id','title','publisher','publication_note','document_id','acquisition','redistribution'].every(k => text(v[k]))
    && safeSourceUrl(v.url) && date(v.checked_on) && (v.published_on === null || date(v.published_on) && v.published_on <= v.checked_on)
    && (v.sha256 === null || typeof v.sha256 === 'string' && /^[a-f0-9]{64}$/.test(v.sha256));
}
export function validDischargeCatalog(v: unknown): v is DischargeCatalog {
  if (!record(v) || v.format_version !== 1 || !date(v.checked_on) || !Array.isArray(v.sources) || v.sources.length > 50 || !v.sources.every(source)
    || !Array.isArray(v.items) || v.items.length > 50) return false;
  const ids = new Set(v.sources.map(s => s.id));
  const checkedOn = v.checked_on;
  if (ids.size !== v.sources.length || v.sources.some(s => s.checked_on > checkedOn)) return false;
  const ref = (id: unknown) => typeof id === 'string' && ids.has(id);
  const evidence = (e: unknown): e is Evidence => record(e) && ref(e.source_id) && ['locator','statement','period'].every(k => text(e[k]))
    && (e.conversion === null || text(e.conversion)) && (e.quantity === null || record(e.quantity) && finite(e.quantity.value) && e.quantity.value >= 0
      && ['parameter','unit','scope'].every(k => text((e.quantity as Record<string, unknown>)[k])) && typeof e.quantity.basis === 'string' && Object.hasOwn(basisLabels, e.quantity.basis));
  const coordinate = (c: unknown): c is Coordinate => record(c) && finite(c.longitude) && finite(c.latitude) && Math.abs(c.longitude) <= 180 && Math.abs(c.latitude) <= 90
    && c.crs === 'EPSG:4326' && ['enterprise','outfall'].includes(String(c.kind)) && text(c.description) && ref(c.source_id) && text(c.locator);
  const validItem = (i: unknown): i is DischargeItem => {
    if (!record(i) || !['id','name','kind','location_description','receiver_note','discharge_summary','readiness_reason'].every(k => text(i[k]))
      || !(i.receiver === null || text(i.receiver)) || !(i.coordinates === null || coordinate(i.coordinates))
      || !Array.isArray(i.evidence) || !i.evidence.length || i.evidence.length > 100 || !i.evidence.every(evidence)
      || !Array.isArray(i.missing) || !i.missing.every(text) || typeof i.readiness !== 'string' || !Object.hasOwn(readinessLabels, i.readiness)
      || !record(i.prepared_reach) || !['not_established','outside','matched'].includes(String(i.prepared_reach.status)) || !text(i.prepared_reach.explanation)
      || !(i.prepared_reach.status === 'matched' ? text(i.prepared_reach.reach_id) : i.prepared_reach.reach_id === null) || !record(i.matrix)) return false;
    return Object.keys(matrixLabels).every(k => {
      const cell = (i.matrix as Record<string, unknown>)[k];
      return record(cell) && typeof cell.status === 'string' && Object.hasOwn(cellLabels, cell.status) && text(cell.note) && Array.isArray(cell.source_ids) && cell.source_ids.every(ref);
    });
  };
  return v.items.every(validItem) && new Set(v.items.map(i => i.id)).size === v.items.length;
}
