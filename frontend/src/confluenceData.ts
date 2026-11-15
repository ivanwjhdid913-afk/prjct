export const branchIds = ['a', 'b', 'out'] as const;
export type BranchId = typeof branchIds[number];
export type InletId = Exclude<BranchId, 'out'>;
export type Point = [east: number, north: number];
export type HydraulicInputs = { velocity_m_s: number; dispersion_m2_s: number };
export type InletInputs = HydraulicInputs & {
  id: InletId; flow_m3_s: number; concentration_mg_l: number; load_duration_minutes: number | null;
};
export type Inputs = {
  background_mg_l: number; duration_hours: number; branches: InletInputs[]; downstream: HydraulicInputs;
};
export type Branch = { id: BranchId; length_m: number; coordinates_m: Point[] };
export type Geometry = { id: 'synthetic-confluence-v1'; branches: Branch[]; junction_m: Point };
export type Pilot = { geometry: Geometry; defaults: Inputs };
export type Balance = { input: number[]; output: number[]; stored: number[]; residual: number[] };
export type Result = {
  model_id: 'conservative-1d-confluence-v1'; format_version: 1; geometry: Geometry; inputs: Inputs;
  flows_m3_s: Record<BranchId, number>; times_hours: number[]; concentrations_mg_l: Record<BranchId, number[][]>;
  junction_mg_l: Record<BranchId, number[]>; scale_mg_l: [number, number]; balance_kg: Balance;
  branch_balance_kg: Record<BranchId, Balance>; grid: { cells: Record<BranchId, number>; max_step_seconds: number };
};
const maxCells = 1200;
const maxFrames = 2501;
const maxResultValues = 450_000;
const maxResponseBytes = 12 * 1024 * 1024;

export type DraftInlet = Record<Exclude<keyof InletInputs, 'id'>, string> & { continuous: boolean };
export type Draft = {
  background_mg_l: string; duration_hours: string; a: DraftInlet; b: DraftInlet;
  out: Record<keyof HydraulicInputs, string>;
};

function hydraulicDraft(values: HydraulicInputs) {
  return { velocity_m_s: String(values.velocity_m_s), dispersion_m2_s: String(values.dispersion_m2_s) };
}

export function toDraft(inputs: Inputs): Draft {
  function inlet(id: InletId): DraftInlet {
    const values = inputs.branches.find(branch => branch.id === id)!;
    return {
      ...hydraulicDraft(values), flow_m3_s: String(values.flow_m3_s), concentration_mg_l: String(values.concentration_mg_l),
      continuous: values.load_duration_minutes === null, load_duration_minutes: String(values.load_duration_minutes ?? 30),
    };
  }
  return { background_mg_l: String(inputs.background_mg_l), duration_hours: String(inputs.duration_hours), a: inlet('a'), b: inlet('b'), out: hydraulicDraft(inputs.downstream) };
}

export function toInputs(draft: Draft): Inputs {
  function hydraulic(values: Draft['out']): HydraulicInputs {
    return { velocity_m_s: numeric(values.velocity_m_s, 'Скорость', .05, 5), dispersion_m2_s: numeric(values.dispersion_m2_s, 'Дисперсия', 0, 100) };
  }
  const duration_hours = numeric(draft.duration_hours, 'Горизонт расчёта', 0, 24, true);
  const horizonMinutes = duration_hours * 60 * (1 + Number.EPSILON);
  return {
    background_mg_l: numeric(draft.background_mg_l, 'Фоновая концентрация', 0, 10_000), duration_hours,
    branches: (['a', 'b'] as const).map(id => {
      const item = draft[id];
      return {
        id, ...hydraulic(item), flow_m3_s: numeric(item.flow_m3_s, 'Расход', .1, 100), concentration_mg_l: numeric(item.concentration_mg_l, 'Концентрация на входе', 0, 10_000),
        load_duration_minutes: item.continuous ? null : numeric(item.load_duration_minutes, 'Длительность сброса', 0, horizonMinutes, true),
      };
    }), downstream: hydraulic(draft.out),
  };
}

function numeric(raw: string, name: string, min: number, max: number, strictMin = false): number {
  const value = raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value > max || (strictMin ? value <= min : value < min)) {
    const number = (bound: number) => bound.toLocaleString('ru-RU', { maximumFractionDigits: 6 });
    throw new Error(`${name} — ${strictMin ? 'больше' : 'от'} ${number(min)} до ${number(max)}.`);
  }
  return value;
}

export function sameInputs(draft: Draft, accepted: Inputs): boolean {
  try {
    return JSON.stringify(toInputs(draft)) === JSON.stringify(toInputs(toDraft(accepted)));
  } catch { return false; }
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0;
const positive = (value: unknown): value is number => finite(value) && value > 0;
const point = (value: unknown): value is Point => Array.isArray(value) && value.length === 2 && value.every(finite);
const metricPoint = (value: unknown): value is Point => point(value) && value.every(coordinate => Math.abs(coordinate) <= 10_000);
const distance = ([x, y]: Point, [endX, endY]: Point): number => Math.hypot(endX - x, endY - y);

function isGeometry(value: unknown): value is Geometry {
  if (!record(value) || value.id !== 'synthetic-confluence-v1' || !metricPoint(value.junction_m) || !Array.isArray(value.branches) || value.branches.length !== 3) return false;
  const junction = value.junction_m;
  const branches = value.branches;
  return branchIds.every(id => {
    const branch = branches.find((item: unknown) => record(item) && item.id === id);
    if (!record(branch) || !positive(branch.length_m) || !Array.isArray(branch.coordinates_m) || branch.coordinates_m.length < 2 || branch.coordinates_m.length > 256 || !branch.coordinates_m.every(metricPoint)) return false;
    const coordinates = branch.coordinates_m as Point[];
    const lengths = coordinates.slice(1).map((vertex, index) => distance(coordinates[index], vertex));
    const node = id === 'out' ? coordinates[0] : coordinates[coordinates.length - 1];
    return lengths.every(positive) && Math.abs(lengths.reduce((sum, length) => sum + length, 0) - branch.length_m) <= 1e-3 && distance(node, junction) <= 1e-6;
  });
}

function isInputs(value: unknown): value is Inputs {
  const hydraulic = (item: unknown) => record(item) && positive(item.velocity_m_s) && nonnegative(item.dispersion_m2_s);
  if (!record(value) || !nonnegative(value.background_mg_l) || !positive(value.duration_hours) || !hydraulic(value.downstream) || !Array.isArray(value.branches) || value.branches.length !== 2) return false;
  const branches = value.branches;
  return ['a', 'b'].every(id => {
    const inlet = branches.find((item: unknown) => record(item) && item.id === id);
    return record(inlet) && hydraulic(inlet) && positive(inlet.flow_m3_s) && nonnegative(inlet.concentration_mg_l) && (inlet.load_duration_minutes === null || positive(inlet.load_duration_minutes));
  });
}

function isResult(value: unknown): value is Result {
  if (!record(value) || value.model_id !== 'conservative-1d-confluence-v1' || value.format_version !== 1 || !isGeometry(value.geometry) || !isInputs(value.inputs) || !point(value.scale_mg_l) || value.scale_mg_l[0] > value.scale_mg_l[1]) return false;
  const { times_hours: times, concentrations_mg_l: concentrations, junction_mg_l: junction, flows_m3_s: flows, branch_balance_kg: branchBalance, grid } = value;
  if (!Array.isArray(times) || times.length < 2 || times.length > maxFrames || !times.every((time, index) => nonnegative(time) && (index ? time > times[index - 1] : time === 0)) || !record(concentrations) || !record(junction) || !record(flows) || !record(branchBalance) || !record(grid) || !record(grid.cells) || !positive(grid.max_step_seconds)) return false;
  if (times[times.length - 1] !== value.inputs.duration_hours) return false;
  const cells = grid.cells;
  const cellCounts = branchIds.map(id => cells[id]).filter((count): count is number => positive(count) && Number.isSafeInteger(count));
  const totalCells = cellCounts.reduce((sum, count) => sum + count, 0);
  if (cellCounts.length !== branchIds.length || totalCells > maxCells || (totalCells + 20) * times.length > maxResultValues) return false;
  const series = (data: unknown, size: number) => Array.isArray(data) && data.length === size && data.every(finite);
  const balance = (data: unknown) => record(data) && ['input', 'output', 'stored', 'residual'].every(key => series(data[key], times.length));
  return balance(value.balance_kg) && branchIds.every(id => {
    const count = cells[id];
    const branch = concentrations[id];
    return positive(flows[id]) && positive(count) && Number.isSafeInteger(count) && Array.isArray(branch) && branch.length === times.length && branch.every(row => series(row, count)) && series(junction[id], times.length) && balance(branchBalance[id]);
  });
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (Number(response.headers.get('Content-Length')) > limit) {
    await response.body?.cancel();
    throw new Error('Ответ сервера превышает допустимый объём.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Сервер вернул пустой ответ.');
  const decoder = new TextDecoder();
  let bytes = 0, json = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      throw new Error('Ответ сервера превышает допустимый объём.');
    }
    json += decoder.decode(chunk.value, { stream: true });
  }
  try { return JSON.parse(json + decoder.decode()); } catch { throw new Error('Сервер вернул некорректный JSON.'); }
}

async function request(url: string, signal: AbortSignal, inputs?: Inputs): Promise<unknown> {
  const failed = inputs ? 'Не удалось выполнить расчёт слияния.' : 'Не удалось загрузить схему слияния.';
  const deadline = new AbortController();
  const timer = window.setTimeout(() => deadline.abort(), inputs ? 30_000 : 12_000);
  try {
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, deadline.signal]), method: inputs ? 'POST' : 'GET',
      headers: inputs ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' },
      body: inputs ? JSON.stringify(inputs) : undefined,
    });
    if (response.ok) return await boundedJson(response, maxResponseBytes);
    if (response.status === 422 && inputs) {
      const error = await boundedJson(response, 16_384).catch(() => null);
      if (record(error) && typeof error.detail === 'string' && error.detail.includes('pilot limit')) {
        throw new Error('Расчёт превышает допустимый объём. Уменьшите горизонт расчёта.');
      }
      throw new Error('Сервер отклонил условия расчёта. Проверьте диапазоны параметров и длительность сброса.');
    }
    void response.body?.cancel().catch(() => {});
    if (response.status === 503 && inputs) throw new Error('Другой расчёт ещё выполняется. Повторите попытку через несколько секунд.');
    throw new Error(`${failed} Код ${response.status}.`);
  } catch (error) {
    if (deadline.signal.aborted) throw new Error('Время ожидания ответа истекло. Повторите попытку.');
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

export async function loadPilot(signal: AbortSignal): Promise<Pilot> {
  const value = await request('/api/v1/confluence/pilot', signal);
  if (!record(value) || !isGeometry(value.geometry) || !isInputs(value.defaults)) throw new Error('Сервер вернул некорректную схему слияния.');
  return { geometry: value.geometry, defaults: value.defaults };
}

export async function simulate(inputs: Inputs, geometry: Geometry, signal: AbortSignal): Promise<Result> {
  const value = await request('/api/v1/confluence/simulations', signal, inputs);
  if (!isResult(value)) throw new Error('Сервер вернул неполный результат расчёта.');
  const sameGeometry = JSON.stringify(value.geometry.junction_m) === JSON.stringify(geometry.junction_m) && branchIds.every(id => {
    const expected = geometry.branches.find(branch => branch.id === id)!;
    const received = value.geometry.branches.find(branch => branch.id === id)!;
    return expected.length_m === received.length_m && JSON.stringify(expected.coordinates_m) === JSON.stringify(received.coordinates_m);
  });
  if (!sameGeometry || !sameInputs(toDraft(inputs), value.inputs)) throw new Error('Результат не соответствует условиям и схеме текущего запроса.');
  return value;
}

export type Segment = { id: string; start: number; end: number; path: Point[] };

/** Cut at model cell edges along Euclidean chainage, keeping all interior bends. */
export function segments(branch: Branch, count: number): Segment[] {
  const vertices = branch.coordinates_m;
  const chainage = [0];
  for (let index = 1; index < vertices.length; index++) chainage.push(chainage[index - 1] + distance(vertices[index - 1], vertices[index]));
  const total = chainage[chainage.length - 1];
  let leg = 1;
  function interpolate(position: number): Point {
    const ratio = (position - chainage[leg - 1]) / (chainage[leg] - chainage[leg - 1]);
    const [x, y] = vertices[leg - 1], [nextX, nextY] = vertices[leg];
    return [x + (nextX - x) * ratio, y + (nextY - y) * ratio];
  }
  let previous = vertices[0];
  return Array.from({ length: count }, (_, index) => {
    const start = branch.length_m * index / count, end = branch.length_m * (index + 1) / count;
    const path = [previous];
    const edge = total * (index + 1) / count;
    while (chainage[leg] < edge) path.push(vertices[leg++]);
    previous = interpolate(edge);
    path.push(previous);
    return { id: `${branch.id}-${index + 1}`, start, end, path };
  });
}

export function resultCsv(result: Result): Blob {
  const header = ['record_type', 'time_hours', 'branch_id', 'segment_id', 'distance_start_m', 'distance_end_m',
    'concentration_mg_l', 'flow_m3_s', 'junction_concentration_mg_l', 'input_kg', 'output_kg', 'stored_kg',
    'residual_kg', 'model_id', 'model_format_version', 'geometry_id'];
  const parts: string[] = [];
  let part = `${header.join(',')}\r\n`;
  function append(row: (string | number)[]) {
    part += `${row.join(',')}${','.repeat(header.length - row.length)}\r\n`;
    if (part.length >= 64 * 1024) {
      parts.push(part);
      part = '';
    }
  }
  function balanceRow(time: number, id: BranchId | 'network', flow: number, concentration: number, balance: Balance, frame: number) {
    append(['balance', time, id, '', '', '', '', flow, concentration,
      balance.input[frame], balance.output[frame], balance.stored[frame], balance.residual[frame]]);
  }
  append(['metadata', ...Array<string>(header.indexOf('model_id') - 1).fill(''), result.model_id, result.format_version, result.geometry.id]);
  const branches = result.geometry.branches.map(branch => ({ id: branch.id, cells: segments(branch, result.grid.cells[branch.id]) }));
  result.times_hours.forEach((time, frame) => {
    for (const { id, cells } of branches) {
      cells.forEach((segment, index) => append(['segment', time, id, segment.id, segment.start, segment.end,
        result.concentrations_mg_l[id][frame][index]]));
      balanceRow(time, id, result.flows_m3_s[id], result.junction_mg_l[id][frame], result.branch_balance_kg[id], frame);
    }
    balanceRow(time, 'network', result.flows_m3_s.out, result.junction_mg_l.out[frame], result.balance_kg, frame);
  });
  if (part) parts.push(part);
  return new Blob(parts, { type: 'text/csv;charset=utf-8' });
}
