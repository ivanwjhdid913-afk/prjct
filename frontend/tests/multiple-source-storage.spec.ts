import { test, expect } from '@playwright/test';
import { validSaved } from '../src/scenarioStorage';
import { validDocument, documentFromSaved } from '../src/scenarioExchange';
import { buildResultCsv } from '../src/resultExport';
const conditions={river_flow_m3_s:10,background_mg_l:10,velocity_m_s:.25,dispersion_m2_s:5,duration_hours:6,reach_id:'don-olkhovets',sources:[
{id:'s1',name:'Первый',source_distance_m:0,effluent_flow_m3_s:.1,effluent_mg_l:null,load_mode:'profile',load_duration_hours:null,load_intervals:[{start_hours:0,end_hours:.5,effluent_mg_l:100}]},
{id:'s2',name:'Второй',source_distance_m:1200,effluent_flow_m3_s:.05,effluent_mg_l:60,load_mode:'finite',load_duration_hours:2.5,load_intervals:null}]};
const saved={id:'11111111-1111-1111-1111-111111111111',name:'Два источника',created_at:'2026-10-31T00:00:00Z',reach_name:'Дон',geometry_mode:'river',geometry_version:'river-wgs84-v1',geometry_sha256:'a'.repeat(64),downstream_geometry_sha256:'b'.repeat(64),geometry_source:{},reach_id:'don-olkhovets',format_version:3,model_id:'conservative-1d-lateral-inflow-v2',load_mode:'multiple',conditions,compatibility:{compatible:true,reasons:[]}};
test('format3 keeps complete independent multi-source portable snapshots',()=>{
expect(validSaved(saved)).toBe(true);const doc=documentFromSaved(saved);expect(validDocument(doc)).toBe(true);expect(doc.conditions).toEqual(conditions);
const before=structuredClone(saved);(doc.conditions as typeof conditions).sources[0].load_intervals![0].effluent_mg_l=777;expect(saved).toEqual(before);
expect(doc.conditions).not.toHaveProperty('source_distance_m');
});
test('source version identity cannot pretend to be legacy model',()=>{
expect(validSaved({...saved,format_version:2})).toBe(false);expect(validSaved({...saved,model_id:'conservative-1d-advection-dispersion-v1'})).toBe(false);
for(const sources of [[],[...conditions.sources,conditions.sources[0]],conditions.sources.map(s=>({...s,id:'duplicate'})),conditions.sources.map(s=>({...s,source_distance_m:NaN}))]) expect(validSaved({...saved,conditions:{...conditions,sources}})).toBe(false);
});
test('CSV metadata contains all source identities, loads, events and absolute reach distances',()=>{
const result={format_version:3,model_id:saved.model_id,inputs:{...conditions,length_m:3126},distances_m:[15,1205],times_hours:[0,6],concentrations_mg_l:[[10,10],[11,12]],reach_id:conditions.reach_id};
const csv=buildResultCsv({result,hour:0,selected:0,kind:'time'});const metadata=JSON.parse(/,"(\{.*\})"$/.exec(csv.split('\r\n')[1])![1].replaceAll('""','"'));
expect(metadata.scenarios[0].inputs.sources).toEqual(conditions.sources);expect(metadata.scenarios[0].source_events.map((s:{id:string})=>s.id)).toEqual(['s1','s2']);expect(metadata.units.distance).toBe('m_from_reach_start');expect(metadata.coordinate_origin).toBe('reach_start');expect(csv.split('\r\n')[0]).toContain('distance_from_reach_start_m');
});

test('unknown multi-source versions remain readable as incompatible previews',()=>{
 const doc=documentFromSaved(saved);expect(validDocument({...doc,format_version:4})).toBe(true);
 expect(validDocument({...doc,model_id:'future-model'})).toBe(true);expect(validSaved({...saved,model_id:'future-model'})).toBe(false);
});

test('all three twelve-period source arrays remain distinct and validators reject malformed snapshots',()=>{
 const inputs={...conditions,sources:Array.from({length:3},(_,i)=>({...conditions.sources[0],id:`s${i}`,name:`Источник ${i+1}`,source_distance_m:i*800,
  load_intervals:Array.from({length:12},(_,j)=>({start_hours:j/4,end_hours:(j+1)/4,effluent_mg_l:100+i+j}))}))};
 expect(validSaved({...saved,conditions:inputs})).toBe(true);
 expect((documentFromSaved({...saved,conditions:inputs}).conditions as typeof inputs).sources).toEqual(inputs.sources);
 for (const field of ['id','name','source_distance_m','effluent_flow_m3_s','effluent_mg_l','load_mode','load_duration_hours','load_intervals']) {
  const bad=structuredClone(inputs) as unknown as {sources:Record<string,unknown>[]};delete bad.sources[1][field];expect(validSaved({...saved,conditions:bad})).toBe(false);
 }
 for (const values of [{id:'плохой'},{name:' bad '},{name:'a\n'},{effluent_flow_m3_s:Infinity},{source_distance_m:-1},{load_intervals:[{start_hours:0,end_hours:7,effluent_mg_l:100}]}]) {
   const bad=structuredClone(inputs);Object.assign(bad.sources[1],values);expect(validSaved({...saved,conditions:bad})).toBe(false);
 }
 expect(validSaved({...saved,conditions:{...inputs,sources:[...inputs.sources,{...inputs.sources[0],id:'fourth'}]}})).toBe(false);
});
test('CSV comparison keeps distinct source configurations and rejects different model domains',()=>{
 const a={format_version:3,model_id:saved.model_id,inputs:{...conditions,length_m:3126},distances_m:[15,1205],times_hours:[0,6],concentrations_mg_l:[[10,10],[11,12]],reach_id:conditions.reach_id};
 const b=structuredClone(a);b.inputs.sources[1].source_distance_m=800;
 const csv=buildResultCsv({result:b,a,b,hour:1,selected:1,kind:'space'});expect(csv).toContain('1200');expect(csv).toContain('800');
 expect(()=>buildResultCsv({result:b,a,b:{...b,model_id:'old-model'},hour:1,selected:1,kind:'space'})).toThrow('одинаковые модель');
 expect(()=>buildResultCsv({result:b,a,b:{...b,reach_id:'other'},hour:1,selected:1,kind:'space'})).toThrow('одинаковые модель');
});
