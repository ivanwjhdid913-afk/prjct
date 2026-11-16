import type { Reach, RestorableConditions } from './multipleSources';
import type { MultipleConditions } from './scenarioStorage';

export const PASSPORT_FORMAT = 5;
const fields = {
  discharge_coordinates: ['Сценарная точка', 'EPSG:4326'],
  receiver: ['Принимающая река', ''],
  source_distance_m: ['Положение вдоль русла', 'м'],
  effluent_flow_m3_s: ['Расход стоков', 'м³/с'],
  effluent_mg_l: ['Хлориды в стоках', 'мг/л'],
  river_flow_m3_s: ['Расход реки выше источника', 'м³/с'],
  background_mg_l: ['Фон хлоридов', 'мг/л'],
  velocity_m_s: ['Скорость течения', 'м/с'],
  dispersion_m2_s: ['Продольная дисперсия', 'м²/с'],
  duration_hours: ['Горизонт расчёта', 'ч'],
  load_mode: ['Режим нагрузки', ''],
} as const;

export type FieldKey = keyof typeof fields;
type Basis = 'prepared_geometry' | 'synthetic';
type Entry<T> = { basis: Basis; source: string; value: T };
type NumericKey = Exclude<FieldKey, 'discharge_coordinates' | 'receiver' | 'load_mode'>;
export type InputProvenance = {
  schema_version: 1;
  passport_id: string;
  kind: 'synthetic';
  fields: Record<NumericKey, Entry<number>> & {
    discharge_coordinates: Entry<[number, number]>;
    receiver: Entry<string>;
    load_mode: Entry<'continuous'>;
  };
};

const keys = Object.keys(fields) as FieldKey[];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function validProvenance(value: unknown, conditions: MultipleConditions): value is InputProvenance {
  if (!record(value) || Object.keys(value).length !== 4 || value.schema_version !== 1 || value.kind !== 'synthetic'
      || !text(value.passport_id, 80) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.passport_id)
      || !record(value.fields) || Object.keys(value.fields).length !== keys.length || conditions.sources.length !== 1) return false;
  const source = conditions.sources[0];
  const expected = { ...conditions, ...source };
  const entries = value.fields;
  return source.load_mode === 'continuous' && keys.every(key => {
    const entry = entries[key];
    if (!record(entry) || Object.keys(entry).length !== 3 || (entry.basis !== 'prepared_geometry' && entry.basis !== 'synthetic')
        || !text(entry.source, 240)) return false;
    if (key === 'discharge_coordinates') {
      const coords = entry.value;
      return Array.isArray(coords) && coords.length === 2 && coords.every(finite) && Math.abs(coords[0]) <= 180 && Math.abs(coords[1]) <= 90;
    }
    if (key === 'receiver') return text(entry.value, 160);
    return entry.value === expected[key];
  });
}

export function provenanceRows(value: InputProvenance) {
  return keys.map(key => {
    const [label, unit] = fields[key];
    const entry = value.fields[key];
    const number = (n: number, precision: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: precision });
    const formatted = key === 'load_mode' ? 'Постоянная нагрузка'
      : Array.isArray(entry.value) ? entry.value.map(n => number(n, 7)).join(' / ')
      : typeof entry.value === 'number' ? number(entry.value, 3) : entry.value;
    return { key, label, value: `${formatted}${unit ? ` ${unit}` : ''}`,
      origin: entry.basis === 'prepared_geometry' ? 'Подготовленная геометрия' : 'Синтетическое условие', source: entry.source };
  });
}

export const DEMO_REACH_ID = 'don-olkhovets';
export const DEMO_TITLE = 'Условный источник на Дону';
const reachHash = '470d4cd05dcac877844d40596c2e7a9a506468b7b31748a9d8682c46f7d5fa92';
const downstreamHash = 'cb145a17e4a2883eb81762a1122bb968baa64045cd29a1141576c63683552cee';

export function dischargeDemo(reaches: Reach[]): RestorableConditions & { input_provenance: InputProvenance } {
  const reach = reaches.find(item => item.id === DEMO_REACH_ID);
  if (!reach) throw new Error('Подготовленный участок Дона отсутствует в реестре.');
  if (reach.metadata.geometry_sha256 !== reachHash || reach.metadata.downstream_geometry_sha256 !== downstreamHash)
    throw new Error('Геометрия подготовленного участка изменилась. Условия паспорта недоступны.');
  const vertex = 3;
  const distance = reach.distances_m[vertex];
  const coordinate = reach.geometry.coordinates[vertex];
  if (!coordinate || !Number.isFinite(distance) || distance > reach.length_m - 100)
    throw new Error('Сценарная точка не совпадает с подготовленным руслом.');
  const shared = { river_flow_m3_s: 10, background_mg_l: 10, velocity_m_s: 0.4, dispersion_m2_s: 5, duration_hours: 3 };
  const source = { id: 'discharge-demo-don', name: 'Условный источник', source_distance_m: distance,
    effluent_flow_m3_s: 0.1, effluent_mg_l: 100, load_mode: 'continuous' as const, load_duration_hours: null, load_intervals: null };
  const geometry = <T>(value: T, source: string): Entry<T> => ({ basis: 'prepared_geometry', source, value });
  const synthetic = <T>(value: T, source = 'Значение задано для учебного расчёта.'): Entry<T> => ({ basis: 'synthetic', source, value });
  return {
    name: DEMO_TITLE, geometry_sha256: reachHash, downstream_geometry_sha256: downstreamHash,
    conditions: { reach_id: DEMO_REACH_ID, ...shared, sources: [source] },
    analysis_settings: { points: [{ id: 'discharge-demo-control', name: 'Учебный створ ниже источника', segment_index: 45 }], threshold_mg_l: null },
    input_provenance: { schema_version: 1, passport_id: 'synthetic-continuous-don-v1', kind: 'synthetic', fields: {
      discharge_coordinates: synthetic(coordinate, 'Условная точка выбрана на вершине подготовленной линии Дона. Порядок: долгота, широта.'),
      receiver: geometry('Дон', 'Реестр подготовленных участков, don-olkhovets.'),
      source_distance_m: synthetic(distance, 'Расстояние по подготовленной линии до выбранной условной точки.'),
      effluent_flow_m3_s: synthetic(source.effluent_flow_m3_s), effluent_mg_l: synthetic(source.effluent_mg_l),
      river_flow_m3_s: synthetic(shared.river_flow_m3_s), background_mg_l: synthetic(shared.background_mg_l),
      velocity_m_s: synthetic(shared.velocity_m_s), dispersion_m2_s: synthetic(shared.dispersion_m2_s),
      duration_hours: synthetic(shared.duration_hours, 'Модельные часы от начала сценария.'),
      load_mode: synthetic(source.load_mode, 'Одинаковая концентрация и расход стоков на всём горизонте.'),
    } },
  };
}
