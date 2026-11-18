import { riverCoordinate } from './riverCoordinate';

export const NETWORK_MODEL = 'conservative-1d-network-v1';
export type Coordinate = [number, number];
export type NetworkNode = { id: string; coordinate: Coordinate; kind: string; name?: string };
export type NetworkReach = {
  id: string; name?: string; from_node: string; to_node: string; length_m: number; distances_m: number[];
  geometry: { type: 'LineString'; coordinates: Coordinate[] };
};
export type RiverNetwork = {
  id: string; name?: string; geometry_sha256: string; nodes: NetworkNode[]; reaches: NetworkReach[];
  metadata?: Record<string, unknown>;
};
export type NetworkInputs = {
  network_id: string; geometry_sha256: string; background_mg_l: number; duration_hours: number;
  headwaters: { node_id: string; flow_m3_s: number; concentration_mg_l: number }[];
  hydraulics: { reach_id: string; velocity_m_s: number; dispersion_m2_s: number }[];
  source: { reach_id: string; distance_m: number; flow_m3_s: number; concentration_mg_l: number; load_duration_hours: number | null };
  provenance: { hydraulics: 'synthetic'; load: 'synthetic' };
};
export type NetworkPilot = { network: RiverNetwork; defaults: NetworkInputs };
export type ReachResult = {
  id: string; distances_m: number[]; segment_geometries: { type: 'LineString'; coordinates: Coordinate[] }[];
  concentrations_mg_l: number[][]; flows_m3_s: number[];
};
export type NetworkResult = {
  model_id: typeof NETWORK_MODEL; format_version: 1; network: RiverNetwork; inputs: NetworkInputs;
  times_hours: number[]; scale_mg_l: [number, number]; source_coordinate: Coordinate;
  reaches: ReachResult[]; nodes: { id: string; flow_m3_s: number; concentrations_mg_l: number[] }[];
  balance_kg: { input: number[]; output: number[]; stored: number[]; residual: number[] };
  diagnostics: Record<string, unknown>;
};
export type NetworkSaved = {
  id: string; name: string; model_id: typeof NETWORK_MODEL; format_version: 1;
  conditions: NetworkInputs; created_at: string; network_snapshot: RiverNetwork;
};
export type NetworkSavedSummary = Pick<NetworkSaved, 'id' | 'name' | 'created_at'>;
export type NetworkSavedPage = { items: NetworkSavedSummary[]; total: number };
export type NetworkDraft = {
  background: string; duration: string; sourceReach: string; distance: string; flow: string; concentration: string;
  continuous: boolean; loadDuration: string;
  headwaters: { node_id: string; flow: string; concentration: string }[];
  hydraulics: { reach_id: string; velocity: string; dispersion: string }[];
};

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const between = (value: unknown, low: number, high: number): value is number => finite(value) && value >= low && value <= high;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const text = (value: unknown, max = 300): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const coordinate = (value: unknown): value is Coordinate => Array.isArray(value) && value.length === 2 && between(value[0], -180, 180) && between(value[1], -90, 90);
const line = (value: unknown): value is NetworkReach['geometry'] => record(value) && value.type === 'LineString' && Array.isArray(value.coordinates) && value.coordinates.length >= 2 && value.coordinates.length <= 4096 && value.coordinates.every(coordinate);
const unique = (values: string[]) => new Set(values).size === values.length;
const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

const sameCoordinate = (a: Coordinate, b: Coordinate) => near(a[0], b[0]) && near(a[1], b[1]);

export function validNetwork(value: unknown): value is RiverNetwork {
  if (!record(value) || !identifier(value.id) || !hash(value.geometry_sha256) || !Array.isArray(value.nodes) || value.nodes.length < 2 || value.nodes.length > 24 || !Array.isArray(value.reaches) || value.reaches.length < 1 || value.reaches.length > 16) return false;
  if (!value.nodes.every(node => record(node) && identifier(node.id) && coordinate(node.coordinate) && text(node.kind, 50))) return false;
  const nodes = value.nodes as NetworkNode[];
  if (!unique(nodes.map(node => node.id))) return false;
  if (!value.reaches.every(reach => {
    if (!record(reach) || !identifier(reach.id) || !identifier(reach.from_node) || !identifier(reach.to_node) || reach.from_node === reach.to_node || !between(reach.length_m, .001, 20_000) || !line(reach.geometry) || !Array.isArray(reach.distances_m)) return false;
    const positions = reach.distances_m;
    const points = reach.geometry.coordinates;
    const upstream = nodes.find(node => node.id === reach.from_node), downstream = nodes.find(node => node.id === reach.to_node);
    return positions.length === points.length && positions.every((distance, index) => finite(distance) && (index ? distance > positions[index - 1] : distance === 0)) && near(positions[positions.length - 1], reach.length_m)
      && !!upstream && !!downstream && sameCoordinate(upstream.coordinate, points[0]) && sameCoordinate(downstream.coordinate, points[points.length - 1]);
  })) return false;
  const reaches = value.reaches as NetworkReach[];
  if (!unique(reaches.map(reach => reach.id))) return false;
  const pending = new Set(nodes.map(node => node.id));
  while (pending.size) {
    const ready = [...pending].filter(id => !reaches.some(reach => reach.to_node === id && pending.has(reach.from_node)));
    if (!ready.length) return false;
    ready.forEach(id => pending.delete(id));
  }
  return nodes.every(node => reaches.some(reach => reach.from_node === node.id || reach.to_node === node.id)
    && reaches.filter(reach => reach.from_node === node.id).length <= 1)
    && nodes.filter(node => !reaches.some(reach => reach.from_node === node.id)).length === 1
    && nodes.filter(node => reaches.filter(reach => reach.to_node === node.id).length > 1).length === 1;
}

export function validNetworkInputs(value: unknown, network: RiverNetwork): value is NetworkInputs {
  if (!record(value) || value.network_id !== network.id || value.geometry_sha256 !== network.geometry_sha256 || !between(value.background_mg_l, 0, 10_000) || !between(value.duration_hours, Number.MIN_VALUE, 24) || !record(value.provenance) || value.provenance.hydraulics !== 'synthetic' || value.provenance.load !== 'synthetic' || !Array.isArray(value.headwaters) || !Array.isArray(value.hydraulics) || !record(value.source)) return false;
  const headIds = network.nodes.filter(node => !network.reaches.some(reach => reach.to_node === node.id)).map(node => node.id);
  const heads = value.headwaters;
  if (heads.length !== headIds.length || !heads.every(head => record(head) && headIds.includes(String(head.node_id)) && between(head.flow_m3_s, .1, 100) && between(head.concentration_mg_l, 0, 10_000)) || !unique(heads.map(head => head.node_id))) return false;
  const hydraulics = value.hydraulics;
  if (hydraulics.length !== network.reaches.length || !hydraulics.every(item => record(item) && network.reaches.some(reach => reach.id === item.reach_id) && between(item.velocity_m_s, .05, 5) && between(item.dispersion_m2_s, 0, 100)) || !unique(hydraulics.map(item => item.reach_id))) return false;
  const source = value.source;
  const reach = network.reaches.find(item => item.id === source.reach_id);
  return !!reach && between(source.distance_m, 0, reach.length_m) && between(source.flow_m3_s, 0, 100) && between(source.concentration_mg_l, 0, 10_000)
    && (source.load_duration_hours === null || between(source.load_duration_hours, Number.MIN_VALUE, value.duration_hours));
}

export function draftFromInputs(inputs: NetworkInputs): NetworkDraft {
  return {
    background: String(inputs.background_mg_l), duration: String(inputs.duration_hours), sourceReach: inputs.source.reach_id,
    distance: String(inputs.source.distance_m), flow: String(inputs.source.flow_m3_s), concentration: String(inputs.source.concentration_mg_l),
    continuous: inputs.source.load_duration_hours === null, loadDuration: String(inputs.source.load_duration_hours ?? .25),
    headwaters: inputs.headwaters.map(item => ({ node_id: item.node_id, flow: String(item.flow_m3_s), concentration: String(item.concentration_mg_l) })),
    hydraulics: inputs.hydraulics.map(item => ({ reach_id: item.reach_id, velocity: String(item.velocity_m_s), dispersion: String(item.dispersion_m2_s) })),
  };
}


export function inputsFromDraft(draft: NetworkDraft, network: RiverNetwork): NetworkInputs {
  const number = (value: string) => value.trim() ? Number(value) : NaN;
  const inputs: NetworkInputs = {
    network_id: network.id, geometry_sha256: network.geometry_sha256,
    background_mg_l: number(draft.background), duration_hours: number(draft.duration),
    source: { reach_id: draft.sourceReach, distance_m: number(draft.distance), flow_m3_s: number(draft.flow), concentration_mg_l: number(draft.concentration), load_duration_hours: draft.continuous ? null : number(draft.loadDuration) },
    headwaters: draft.headwaters.map(item => ({ node_id: item.node_id, flow_m3_s: number(item.flow), concentration_mg_l: number(item.concentration) })),
    hydraulics: draft.hydraulics.map(item => ({ reach_id: item.reach_id, velocity_m_s: number(item.velocity), dispersion_m2_s: number(item.dispersion) })),
    provenance: { hydraulics: 'synthetic', load: 'synthetic' },
  };
  if (!validNetworkInputs(inputs, network)) throw new Error('Проверьте условия. Положение источника должно быть на выбранном участке, длительность сброса — в пределах горизонта. Расходы и концентрации должны быть конечными числами.');
  return inputs;
}

export function equalInputs(a: NetworkInputs, b: NetworkInputs): boolean {
  return a.network_id === b.network_id && a.geometry_sha256 === b.geometry_sha256 && a.background_mg_l === b.background_mg_l && a.duration_hours === b.duration_hours
    && (['reach_id', 'distance_m', 'flow_m3_s', 'concentration_mg_l', 'load_duration_hours'] as const).every(key => a.source[key] === b.source[key])
    && a.headwaters.length === b.headwaters.length && a.headwaters.every(item => b.headwaters.some(other => item.node_id === other.node_id && item.flow_m3_s === other.flow_m3_s && item.concentration_mg_l === other.concentration_mg_l))
    && a.hydraulics.length === b.hydraulics.length && a.hydraulics.every(item => b.hydraulics.some(other => item.reach_id === other.reach_id && item.velocity_m_s === other.velocity_m_s && item.dispersion_m2_s === other.dispersion_m2_s));
}

export function validNetworkResult(value: unknown, network: RiverNetwork, inputs: NetworkInputs): value is NetworkResult {
  if (!record(value) || value.model_id !== NETWORK_MODEL || value.format_version !== 1 || !validNetwork(value.network) || value.network.geometry_sha256 !== network.geometry_sha256 || !validNetworkInputs(value.inputs, network) || !equalInputs(value.inputs, inputs) || !coordinate(value.source_coordinate) || !Array.isArray(value.times_hours) || value.times_hours.length < 2 || value.times_hours.length > 2501 || !Array.isArray(value.scale_mg_l) || value.scale_mg_l.length !== 2 || !value.scale_mg_l.every(finite) || value.scale_mg_l[0] > value.scale_mg_l[1]) return false;
  const times = value.times_hours;
  if (JSON.stringify(value.network.nodes) !== JSON.stringify(network.nodes) || JSON.stringify(value.network.reaches) !== JSON.stringify(network.reaches)) return false;
  const sourceReach = network.reaches.find(reach => reach.id === inputs.source.reach_id)!;
  const sourcePoint = riverCoordinate(sourceReach.geometry.coordinates, sourceReach.distances_m, inputs.source.distance_m);
  if (!sameCoordinate(value.source_coordinate, sourcePoint)) return false;
  if (!times.every((time, index) => finite(time) && (index ? time > times[index - 1] : time === 0)) || !near(times[times.length - 1], inputs.duration_hours)) return false;
  if (!Array.isArray(value.reaches) || value.reaches.length !== network.reaches.length || !Array.isArray(value.nodes) || value.nodes.length !== network.nodes.length || !record(value.balance_kg) || !record(value.diagnostics)) return false;
  const series = (data: unknown, count = times.length): data is number[] => Array.isArray(data) && data.length === count && data.every(finite);
  const balance = value.balance_kg;
  if (!['input', 'output', 'stored', 'residual'].every(key => series(balance[key]))) return false;
  let cells = 0;
  const reaches = value.reaches;
  if (!network.reaches.every(reach => {
    const item = reaches.find(candidate => record(candidate) && candidate.id === reach.id);
    if (!record(item) || !Array.isArray(item.distances_m) || !item.distances_m.length) return false;
    const distances = item.distances_m;
    if (!distances.every((distance, index) => between(distance, 0, reach.length_m) && (!index || distance > distances[index - 1]))) return false;
    const count = item.distances_m.length;
    cells += count;
    return cells <= 1200 && Array.isArray(item.segment_geometries) && item.segment_geometries.length === count && item.segment_geometries.every(line)
      && series(item.flows_m3_s, count) && item.flows_m3_s.every(flow => flow > 0) && Array.isArray(item.concentrations_mg_l) && item.concentrations_mg_l.length === times.length && item.concentrations_mg_l.every(row => series(row, count));
  })) return false;
  const nodes = value.nodes;
  return (cells + network.nodes.length + 5) * times.length <= 350_000 && network.nodes.every(node => nodes.some(item => record(item) && item.id === node.id && between(item.flow_m3_s, 0, 1000) && series(item.concentrations_mg_l)));
}

/** Linear interpolation between adjacent genuine model states. */
export function timeBracket(times: number[], time: number): { left: number; right: number; weight: number } {
  let lo = 0, hi = times.length - 1;
  if (time <= times[0]) return { left: 0, right: 0, weight: 0 };
  if (time >= times[hi]) return { left: hi, right: hi, weight: 0 };
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (times[mid] <= time) lo = mid; else hi = mid;
  }
  return { left: lo, right: hi, weight: (time - times[lo]) / (times[hi] - times[lo]) };
}
export function sampleSeries(values: number[], bracket: ReturnType<typeof timeBracket>): number {
  return values[bracket.left] + (values[bracket.right] - values[bracket.left]) * bracket.weight;
}

async function request(path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
  const timeout = new AbortController();
  const timer = window.setTimeout(() => timeout.abort(), 30_000);
  try {
    return await readResponse(path, AbortSignal.any([signal, timeout.signal]), body);
  } catch (error) {
    if (timeout.signal.aborted && !signal.aborted) throw new Error('Сервер не ответил за 30 секунд. Повторите попытку.');
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

async function readResponse(path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
  const response = await fetch(`/api/v1/river-networks/${path}`, { signal, method: body ? 'POST' : 'GET', headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) {
    if (response.status === 503) throw new Error('Сервер занят. Повторите попытку через несколько секунд.');
    if (response.status === 422) throw new Error('Сервер отклонил условия. Проверьте параметры и уменьшите горизонт расчёта.');
    if (response.status === 409) throw new Error('Геометрия сохранённой сети изменилась. Условия недоступны для текущей версии.');
    throw new Error(`Не удалось получить данные речной сети. Код ${response.status}.`);
  }
  const limit = 12 * 1024 * 1024;
  if (Number(response.headers.get('Content-Length')) > limit) throw new Error('Ответ сервера превышает допустимый объём.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Пустой ответ сервера.');
  const decoder = new TextDecoder();
  let bytes = 0, content = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > limit) { await reader.cancel(); throw new Error('Ответ сервера превышает допустимый объём.'); }
    content += decoder.decode(chunk.value, { stream: true });
  }
  try { return JSON.parse(content + decoder.decode()); } catch { throw new Error('Некорректный ответ сервера.'); }
}

export async function loadNetworkPilot(signal: AbortSignal): Promise<NetworkPilot> {
  const value = await request('pilot', signal);
  if (!record(value) || !validNetwork(value.network) || !validNetworkInputs(value.defaults, value.network)) throw new Error('Схема сети или начальные условия не прошли проверку.');
  return { network: value.network, defaults: value.defaults };
}
export async function calculateNetwork(network: RiverNetwork, inputs: NetworkInputs, signal: AbortSignal): Promise<NetworkResult> {
  const value = await request('simulations', signal, inputs);
  if (!validNetworkResult(value, network, inputs)) throw new Error('Результат не соответствует условиям, геометрии или временам расчёта.');
  return value;
}
export async function listNetworkSaved(signal: AbortSignal, offset = 0): Promise<NetworkSavedPage> {
  const value = await request(offset ? `scenarios?limit=50&offset=${offset}` : 'scenarios', signal);
  if (!record(value) || !Array.isArray(value.items) || value.items.length > 50 || !Number.isSafeInteger(value.total) || Number(value.total) < offset + value.items.length
    || !value.items.every(item => record(item) && typeof item.id === 'string' && item.id.length <= 100 && text(item.name, 120) && typeof item.created_at === 'string')) throw new Error('Не удалось прочитать список сохранённых условий.');
  return { items: value.items as NetworkSavedSummary[], total: Number(value.total) };
}
function savedRecord(value: unknown, network: RiverNetwork): NetworkSaved {
  if (!record(value) || value.model_id !== NETWORK_MODEL || value.format_version !== 1 || !text(value.name, 120) || typeof value.id !== 'string' || !validNetworkInputs(value.conditions, network) || !validNetwork(value.network_snapshot) || value.network_snapshot.geometry_sha256 !== network.geometry_sha256) throw new Error('Сохранённые условия относятся к другой версии речной сети.');
  return value as NetworkSaved;
}
export async function saveNetworkConditions(network: RiverNetwork, inputs: NetworkInputs, name: string, signal: AbortSignal): Promise<NetworkSaved> {
  if (!text(name.trim(), 120)) throw new Error('Введите название от 1 до 120 символов.');
  return savedRecord(await request('scenarios', signal, { name: name.trim(), model_id: NETWORK_MODEL, format_version: 1, conditions: inputs }), network);
}
export async function loadNetworkSaved(network: RiverNetwork, id: string, signal: AbortSignal): Promise<NetworkSaved> {
  return savedRecord(await request(`scenarios/${encodeURIComponent(id)}`, signal), network);
}
