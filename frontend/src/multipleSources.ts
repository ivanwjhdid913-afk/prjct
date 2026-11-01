import type { AnalysisSettings } from './analysisSettings';
import { intervalDrafts, validateIntervalDraft, type IntervalDraft } from './loadProfileDraft';
import { validLoadProfile, type LoadMode, type LoadInterval } from './loadProfile';
import { validTimes, validTemporalResolution, type TemporalResolution } from './temporalResolution';
import type { ScenarioConditions } from './scenarioStorage';

export type RestorableConditions = { name?: string; analysis_settings?: AnalysisSettings | null; conditions: ScenarioConditions; geometry_sha256: string | null; downstream_geometry_sha256?: string | null };
export type ScenarioSource = { id: string; name: string; source_distance_m: number; effluent_flow_m3_s: number; effluent_mg_l: number | null; load_mode: LoadMode; load_duration_hours: number | null; load_intervals: LoadInterval[] | null };
export type MultipleInputs = {river_flow_m3_s:number;background_mg_l:number;velocity_m_s:number;dispersion_m2_s:number;duration_hours:number;reach_id:string;sources:ScenarioSource[]};
export type SharedKey='river_flow_m3_s'|'background_mg_l'|'velocity_m_s'|'dispersion_m2_s'|'duration_hours';
export type SharedDraft=Record<SharedKey,string>;
export type SourceDraft={id:string;name:string;source_distance_m:string;effluent_flow_m3_s:string;effluent_mg_l:string;load_mode:LoadMode;load_duration_hours:string;rows:IntervalDraft[]};
export type Line={type:'LineString';coordinates:[number,number][]};
export type Reach={id:string;name:string;length_m:number;geometry:Line;distances_m:number[];metadata:Record<string,unknown>};
export type MultipleResult={format_version:3;model_id:string;inputs:MultipleInputs&{length_m:number};reach_id:string;source_distance_m:number;source_coordinate:[number,number];source_coordinates:{id:string;coordinate:[number,number];source_distance_m:number}[];geometry:Line;segment_geometries:Line[];reach_metadata:Record<string,unknown>;distances_m:number[];times_hours:number[];concentrations_mg_l:number[][];scale_mg_l:[number,number];temporal_resolution:TemporalResolution;derived:{total_flow_m3_s:number;area_m2:number;travel_hours:number;load_kg_s:null;excess_load_kg_s:null;steady_mg_l:null};diagnostics:Record<string,unknown>};
const limits:Record<SharedKey,[number,number]>={river_flow_m3_s:[.1,1000],background_mg_l:[0,10000],velocity_m_s:[.02,2],dispersion_m2_s:[.1,100],duration_hours:[.1,48]};
export const sharedInitial:SharedDraft={river_flow_m3_s:'10',background_mg_l:'10',velocity_m_s:'.25',dispersion_m2_s:'5',duration_hours:'6'};
export function newSourceDraft(number:number):SourceDraft{return {id:`source-${number}-${crypto.randomUUID()}`,name:`Источник ${number}`,source_distance_m:'0',effluent_flow_m3_s:'.1',effluent_mg_l:'100',load_mode:'continuous',load_duration_hours:'.5',rows:[]};}
function parsed(value:string,low:number,high:number,label:string){if(!value.trim()||!Number.isFinite(Number(value))||Number(value)<low||Number(value)>high)throw new Error(`${label}: введите число от ${low} до ${high}.`);return Number(value);}
export function buildMultipleConditions(shared:SharedDraft,reachId:string,length:number,sources:SourceDraft[]):MultipleInputs{
 if(!reachId||!Number.isFinite(length)||length<100)throw new Error('Выберите подготовленный участок.');
 if(sources.length<1||sources.length>3)throw new Error('Нужно от одного до трёх источников.');
 const common=Object.fromEntries(Object.entries(shared).map(([key,value])=>[key,parsed(value,...limits[key as SharedKey],key)])) as Record<SharedKey,number>;
 const ids=new Set<string>();const result=sources.map((source,index)=>{const prefix=`Источник ${index+1}`;
 if(!/^[a-zA-Z0-9_-]{1,64}$/.test(source.id)||ids.has(source.id))throw new Error(`${prefix}: идентификатор должен быть уникальным.`);ids.add(source.id);
 const name=source.name.trim();if(!name||name.length>80||/[\u0000-\u001f\u007f-\u009f]/.test(source.name))throw new Error(`${prefix}: название от 1 до 80 символов без управляющих знаков.`);
 const position=parsed(source.source_distance_m,0,length-100,`${prefix}: ниже источника нужны 100 м`);
 const q=parsed(source.effluent_flow_m3_s,0,100,`${prefix}: расход стоков`);
 const ce=source.load_mode==='profile'?null:parsed(source.effluent_mg_l,0,10000,`${prefix}: концентрация`);
 const duration=source.load_mode==='finite'?parsed(source.load_duration_hours,Number.MIN_VALUE,common.duration_hours,`${prefix}: период нагрузки`):null;
 const check=source.load_mode==='profile'?validateIntervalDraft(source.rows,common.duration_hours):null;
 if(check&&!check.intervals)throw new Error(`${prefix}: проверьте интервалы нагрузки.`);
 return{id:source.id,name,source_distance_m:position,effluent_flow_m3_s:q,effluent_mg_l:ce,load_mode:source.load_mode,load_duration_hours:duration,load_intervals:check?check.intervals:null};});
 return {...common,reach_id:reachId,sources:result};
}
export function draftsFromSources(sources:ScenarioSource[]):SourceDraft[]{return sources.map(source=>({id:source.id,name:source.name,source_distance_m:String(source.source_distance_m),effluent_flow_m3_s:String(source.effluent_flow_m3_s),effluent_mg_l:source.effluent_mg_l===null?'':String(source.effluent_mg_l),load_mode:source.load_mode,load_duration_hours:source.load_duration_hours===null?'.5':String(source.load_duration_hours),rows:intervalDrafts(source.load_intervals??[])}));}
export function validReach(value:unknown):value is Reach{const r=value as Reach;return !!r&&typeof r.id==='string'&&typeof r.name==='string'&&Number.isFinite(r.length_m)&&r.length_m>=100&&r.length_m<=20000&&validLine(r.geometry)&&Array.isArray(r.distances_m)&&r.distances_m.length===r.geometry.coordinates.length&&r.distances_m[0]===0&&r.distances_m.every((d,i)=>Number.isFinite(d)&&(i===0||d>r.distances_m[i-1]))&&Math.abs(r.distances_m.at(-1)!-r.length_m)<1e-6&&!!r.metadata;}
export const validCoordinate=(p:unknown):p is [number,number]=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)&&Math.abs(p[0])<=180&&Math.abs(p[1])<=90;
function validLine(value:unknown):value is Line{const line=value as Line;return !!line&&line.type==='LineString'&&Array.isArray(line.coordinates)&&line.coordinates.length>=2&&line.coordinates.length<=10000&&line.coordinates.every(validCoordinate);}
export function validMultipleResult(value:unknown):value is MultipleResult{const r=value as MultipleResult;if(!r||r.format_version!==3||r.model_id!=='conservative-1d-lateral-inflow-v2'||!r.inputs||!Array.isArray(r.inputs.sources)||r.inputs.sources.length<1||r.inputs.sources.length>3)return false;
 const p=r.inputs;const ids=new Set<string>();if(!Object.entries(limits).every(([key,[low,high]])=>typeof p[key as SharedKey]==='number'&&Number.isFinite(p[key as SharedKey])&&p[key as SharedKey]>=low&&p[key as SharedKey]<=high))return false;
 if(typeof p.reach_id!=='string'||r.reach_id!==p.reach_id||!Number.isFinite(p.length_m)||p.length_m<100||p.length_m>20000)return false;
 if(!p.sources.every(s=>{if(!s||typeof s.id!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(s.id)||ids.has(s.id)||typeof s.name!=='string'||!s.name.trim()||s.name.length>80||/[\u0000-\u001f\u007f-\u009f]/.test(s.name)||!['continuous','finite','profile'].includes(s.load_mode)||!Object.hasOwn(s,'load_duration_hours')||!Object.hasOwn(s,'load_intervals')||!Number.isFinite(s.source_distance_m)||s.source_distance_m<0||s.source_distance_m>p.length_m-100||!Number.isFinite(s.effluent_flow_m3_s)||s.effluent_flow_m3_s<0||s.effluent_flow_m3_s>100||!validLoadProfile({...s,background_mg_l:p.background_mg_l,duration_hours:p.duration_hours}))return false;ids.add(s.id);return true;}))return false;
 return !!r.reach_metadata&&typeof r.reach_metadata==='object'&&!Array.isArray(r.reach_metadata)&&validCoordinate(r.source_coordinate)&&r.source_distance_m===0&&validTimes(r.times_hours,p.duration_hours)&&validTemporalResolution(r.temporal_resolution,r.times_hours.length)&&Array.isArray(r.distances_m)&&r.distances_m.length===100&&r.distances_m.every((d,i)=>Number.isFinite(d)&&d>0&&d<p.length_m&&(i===0||d>r.distances_m[i-1]))&&Array.isArray(r.concentrations_mg_l)&&r.concentrations_mg_l.length===r.times_hours.length&&r.concentrations_mg_l.every(row=>Array.isArray(row)&&row.length===100&&row.every(c=>Number.isFinite(c)&&c>=0))&&validLine(r.geometry)&&Array.isArray(r.segment_geometries)&&r.segment_geometries.length===100&&r.segment_geometries.every(validLine)&&Array.isArray(r.source_coordinates)&&r.source_coordinates.length===p.sources.length&&r.source_coordinates.every((s,i)=>!!s&&typeof s==='object'&&s.id===p.sources[i].id&&s.source_distance_m===p.sources[i].source_distance_m&&validCoordinate(s.coordinate))&&Array.isArray(r.scale_mg_l)&&r.scale_mg_l.length===2&&r.scale_mg_l.every(Number.isFinite)&&r.scale_mg_l[0]<=r.scale_mg_l[1]&&!!r.derived&&['total_flow_m3_s','area_m2','travel_hours'].every(key=>Number.isFinite(r.derived[key as keyof MultipleResult['derived']]))&&r.derived.load_kg_s===null&&r.derived.excess_load_kg_s===null&&r.derived.steady_mg_l===null;
}
export function multipleComparisonReason(a:MultipleResult,b:MultipleResult):string{
 if(a.model_id!==b.model_id)return 'Разные физические постановки нельзя сравнивать как одну модель.';
 if(a.reach_id!==b.reach_id)return 'Для сравнения нужен один подготовленный участок.';
 if(a.reach_metadata.geometry_sha256!==b.reach_metadata.geometry_sha256||a.reach_metadata.downstream_geometry_sha256!==b.reach_metadata.downstream_geometry_sha256)return 'Для сравнения нужны одинаковые версии геометрии и проверенного продолжения.';
 if(a.inputs.duration_hours!==b.inputs.duration_hours)return 'Для сравнения нужен одинаковый горизонт расчёта.';
 if(a.inputs.length_m!==b.inputs.length_m||JSON.stringify(a.geometry)!==JSON.stringify(b.geometry)||JSON.stringify(a.distances_m)!==JSON.stringify(b.distances_m)||JSON.stringify(a.segment_geometries)!==JSON.stringify(b.segment_geometries))return 'Для сравнения нужны одинаковые полная область и сегменты.';
 return '';
}
