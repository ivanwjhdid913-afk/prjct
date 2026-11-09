import { validReach, type Reach } from './multipleSources';

export type RegionalKind = 'boundary' | 'river' | 'lake' | 'reservoir';
export type RegionalSource = { id: string; name: string; url: string; license: string; attribution: string; obtained_on: string; raw_sha256: string };
export type RegionalProperties = { id: string; name: string; kind: RegionalKind; source_id: string; source_elements: { type: string; id: number | string; version?: number }[]; prepared_reach_ids: string[]; limitation: string };
export type RegionalFeature = GeoJSON.Feature<GeoJSON.LineString | GeoJSON.MultiLineString | GeoJSON.Polygon | GeoJSON.MultiPolygon, RegionalProperties>;
export type RegionalData = { type: 'FeatureCollection'; features: RegionalFeature[]; metadata: { format_version: 1; name: string; obtained_on: string; crs: string; coordinate_order: string; coverage_note: string; sources: RegionalSource[]; preparation: Record<string, unknown> } };
export const kindLabel: Record<RegionalKind, string> = { boundary: 'Граница области', river: 'Река', lake: 'Озеро', reservoir: 'Водохранилище' };
export const readiness = (feature: RegionalFeature) => feature.properties.kind === 'lake' || feature.properties.kind === 'reservoir' ? 'Расчёт не подключён' : feature.properties.prepared_reach_ids.length ? 'Есть подготовленный участок' : 'Только обзор';
export const normalizedName = (value: string) => value.toLocaleLowerCase('ru').replaceAll('ё', 'е').trim();
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 4000): value is string => typeof value === 'string' && value.length <= max;
const safeId = (value: unknown): value is string => text(value, 128) && /^[A-Za-z0-9_-]+$/.test(value);
const date = (value: unknown): value is string => text(value, 10) && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export const safeSourceUrl = (value: string): string | undefined => { try { if (/[\u0000-\u0020\u007f]/.test(value)) return; const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; } };

/** Validate once before Leaflet sees data; cap both payload bytes and coordinate work. */
export function validRegionalData(value: unknown): value is RegionalData {
  if (!record(value) || value.type !== 'FeatureCollection' || !Array.isArray(value.features) || value.features.length < 1 || value.features.length > 10000 || !record(value.metadata)) return false;
  const metadata = value.metadata;
  if (metadata.format_version !== 1 || metadata.crs !== 'EPSG:4326' || metadata.coordinate_order !== 'longitude, latitude' || !text(metadata.name) || !metadata.name.trim() || !text(metadata.coverage_note) || !metadata.coverage_note.trim() || !date(metadata.obtained_on) || !record(metadata.preparation) || !Array.isArray(metadata.sources) || metadata.sources.length < 1 || metadata.sources.length > 100) return false;
  const sourceIds = new Set<string>();
  if (!metadata.sources.every(source => {
    if (!record(source) || !['id', 'name', 'url', 'license', 'attribution', 'obtained_on', 'raw_sha256'].every(key => text(source[key]) && !!(source[key] as string).trim()) || !safeId(source.id) || !date(source.obtained_on) || !/^[0-9a-f]{64}$/i.test(source.raw_sha256 as string) || !safeSourceUrl(source.url as string)) return false;
    if (sourceIds.has(source.id as string)) return false;
    sourceIds.add(source.id as string); return true;
  })) return false;
  const ids = new Set<string>(); let vertices = 0;
  const coordinate = (point: unknown): boolean => { vertices++; return vertices <= 250000 && Array.isArray(point) && point.length === 2 && point.every(Number.isFinite) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90; };
  const line = (points: unknown, ring = false): boolean => Array.isArray(points) && points.length >= (ring ? 4 : 2) && points.every(coordinate) && (!ring || (points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1]));
  const polygon = (rings: unknown): boolean => Array.isArray(rings) && rings.length > 0 && rings.every(ring => line(ring, true));
  let boundaries = 0;
  const valid = value.features.every(feature => {
    if (!record(feature) || feature.type !== 'Feature' || !record(feature.properties) || !record(feature.geometry)) return false;
    const p = feature.properties, g = feature.geometry;
    if (!safeId(p.id) || ids.has(p.id) || !text(p.name, 300) || !p.name.trim() || !['boundary', 'river', 'lake', 'reservoir'].includes(p.kind as string) || !text(p.source_id) || !sourceIds.has(p.source_id) || !text(p.limitation) || !Array.isArray(p.prepared_reach_ids) || p.prepared_reach_ids.length > 100 || !p.prepared_reach_ids.every(safeId) || new Set(p.prepared_reach_ids).size !== p.prepared_reach_ids.length || !Array.isArray(p.source_elements) || p.source_elements.length < 1 || p.source_elements.length > 10000 || !p.source_elements.every(item => record(item) && text(item.type, 40) && /^[A-Za-z][A-Za-z0-9_-]*$/.test(item.type) && ((typeof item.id === 'number' && Number.isSafeInteger(item.id) && item.id > 0) || (text(item.id, 128) && /^[A-Za-z0-9_.:/-]+$/.test(item.id))))) return false;
    if (p.kind !== 'river' && p.prepared_reach_ids.length) return false;
    if (p.kind === 'boundary') boundaries++;
    ids.add(p.id);
    if (p.kind === 'river') return g.type === 'LineString' ? line(g.coordinates) : g.type === 'MultiLineString' && Array.isArray(g.coordinates) && g.coordinates.length > 0 && g.coordinates.every(points => line(points));
    return g.type === 'Polygon' ? polygon(g.coordinates) : g.type === 'MultiPolygon' && Array.isArray(g.coordinates) && g.coordinates.length > 0 && g.coordinates.every(polygon);
  });
  return valid && boundaries === 1;
}

async function boundedJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('Не удалось загрузить сохранённые данные.');
  const maxBytes = 16 * 1024 * 1024;
  if (Number(response.headers.get('Content-Length')) > maxBytes) throw new Error('Набор превышает допустимый размер.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Пустой ответ сервера.');
  const decoder = new TextDecoder(); let bytes = 0, json = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maxBytes) { await reader.cancel(); throw new Error('Набор превышает допустимый размер.'); }
    json += decoder.decode(chunk.value, { stream: true });
  }
  return JSON.parse(json + decoder.decode());
}
let overviewCache: Promise<RegionalData> | null = null;
let reachCache: Promise<Reach[]> | null = null;
export function loadRegionalOverview() {
  if (!overviewCache) overviewCache = boundedJson('/api/v1/regional-overview').then(value => { if (!validRegionalData(value)) throw new Error('Сохранённый обзор не прошёл проверку геометрии и происхождения.'); return value; }).catch(error => { overviewCache = null; throw error; });
  return overviewCache;
}
export function loadRegionalReaches() {
  if (!reachCache) reachCache = boundedJson('/api/v1/river-reaches').then(value => { if (!record(value) || !Array.isArray(value.items) || value.items.length > 500 || !value.items.every(validReach)) throw new Error('Реестр подготовленных участков недоступен.'); return value.items as Reach[]; }).catch(error => { reachCache = null; throw error; });
  return reachCache;
}
