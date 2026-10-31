"""Reproduce numerical/output checks for the specified two-source Don scenario.

No database and no project dependencies beyond the existing backend are used.
This tests the numerical model, not field accuracy or real effluent data.
"""
import argparse
from bisect import bisect_left
from copy import deepcopy
import json
import math
from pathlib import Path
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app.multiple_transport import simulate_multiple, build_grid, validate_sources
from app.transport import simulate
from app.river import prepared_reach

REACH,LINE=prepared_reach('don-olkhovets')
PARAMS=dict(river_flow_m3_s=10.,background_mg_l=10.,velocity_m_s=.25,dispersion_m2_s=5.,length_m=LINE.length_m,duration_hours=6.,
    sources=[dict(id='source-1',name='Сценарный источник 1',source_distance_m=0.,effluent_flow_m3_s=.1,effluent_mg_l=None,
                  load_mode='profile',load_duration_hours=None,load_intervals=[dict(start_hours=0.,end_hours=.5,effluent_mg_l=100.)]),
             dict(id='source-2',name='Сценарный источник 2',source_distance_m=1200.,effluent_flow_m3_s=.05,effluent_mg_l=None,
                  load_mode='profile',load_duration_hours=None,load_intervals=[dict(start_hours=2.,end_hours=2.5,effluent_mg_l=60.)])])

def values_at(result,t):
    times=result['times_hours'];rows=result['concentrations_mg_l'];i=bisect_left(times,t)
    if i==0:return rows[0]
    if i==len(times):return rows[-1]
    weight=(t-times[i-1])/(times[i]-times[i-1])
    return [a+weight*(b-a) for a,b in zip(rows[i-1],rows[i])]

def local_peaks(reference,j):
    previous_direction=0;peaks=[]
    for i in range(1,len(reference)):
        delta=reference[i][1][j]-reference[i-1][1][j]
        direction=(delta>0)-(delta<0)
        if direction<0 and previous_direction>0:
            t,row=reference[i-1]
            # Report resolved positive excursions above a stated roundoff floor.
            if row[j]-10.>1e-8:peaks.append((t,row[j]))
        if direction:previous_direction=direction
    return peaks

def maximum_common_difference(a,b):
    return max(abs(x-y) for i in range(49) for x,y in zip(values_at(a,6.*i/48),values_at(b,6.*i/48)))

def run(output:Path):
    reference=[]
    result=simulate_multiple(PARAMS,reference_callback=lambda t,row:reference.append((t,row.copy())))
    saved=dict(zip(result['times_hours'],result['concentrations_mg_l']))
    maximum_relative=0.;maximum_absolute=0.;peak_error=0.;count=0;per_segment=[]
    for j in range(100):
        amplitude=max(abs(row[j]-10.) for _,row in reference)
        errors=[abs(values_at(result,t)[j]-row[j]) for t,row in reference]
        absolute=max(errors);relative=absolute/max(amplitude,1e-7)
        maximum_relative=max(maximum_relative,relative);maximum_absolute=max(maximum_absolute,absolute)
        peaks=[]
        for t,value in local_peaks(reference,j):
            assert t in saved, (j,t)
            error=abs(saved[t][j]-value)/(value-10.)
            assert error<=.02
            peak_error=max(peak_error,error);count+=1
            peaks.append(dict(time_hours=t,reference_mg_l=value,saved_mg_l=saved[t][j],amplitude_above_background_mg_l=value-10.,relative_amplitude_error=error,time_error_seconds=0.))
        per_segment.append(dict(index=j,distance_m=result['distances_m'][j],peaks=peaks,max_absolute_interpolation_error_mg_l=absolute,max_relative_interpolation_error=relative))
    assert maximum_relative<=.01+1e-12
    assert all(saved[t]==dict(reference)[t] for t in saved)
    assert {0.,.5,2.,2.5,6.}<=set(saved)
    assert abs(result['diagnostics']['excess_incoming_kg']-20.7)<1e-12
    assert result['diagnostics']['downstream_flow_m3_s']==10.15
    assert abs(result['diagnostics']['excess_mass_error_kg'])<1e-8
    report=dict(purpose='Numerical/output control against the same scheme, NOT field validation.',reach_id=REACH['id'],params=PARAMS,
        diagnostics=result['diagnostics'],temporal_resolution=result['temporal_resolution'],resolved_peak_roundoff_floor_mg_l=1e-8,
        resolved_peaks=count,max_peak_relative_error=peak_error,max_peak_time_error_seconds=0.,
        independently_measured_interpolation_error=maximum_relative,independently_measured_absolute_interpolation_error_mg_l=maximum_absolute,
        source_coordinate_approximation_error_m=0.,per_segment=per_segment)
    report['refinement']=[]
    for options in [dict(spatial_refinement=2.),dict(temporal_refinement=2.),dict(buffer_factor=2.),dict(spatial_refinement=4.)]:
        try:
            refined_reference=[]
            refined=simulate_multiple(PARAMS,reference_callback=lambda t,row:refined_reference.append((t,row.copy())),**options)
            controls=[]
            for j in [0,35,38,40,49,75,99]:
                ordinary=local_peaks(reference,j);fine=local_peaks(refined_reference,j)
                matched=[]
                for t,c in ordinary:
                    if fine:
                        tf,cf=min(fine,key=lambda pair:abs(pair[0]-t))
                        matched.append(dict(base_time_hours=t,refined_time_hours=tf,time_difference_seconds=(t-tf)*3600,
                            base_amplitude_mg_l=c-10.,refined_amplitude_mg_l=cf-10.,relative_amplitude_difference=(c-cf)/(cf-10.)))
                controls.append(dict(segment_index=j,peaks=matched))
            report['refinement'].append(dict(options=options,max_difference_at_49_common_times_mg_l=maximum_common_difference(result,refined),cells=refined['diagnostics']['cells'],steps=refined['diagnostics']['steps'],peak_comparison=controls))
        except ValueError as error:report['refinement'].append(dict(options=options,rejected=str(error)))
    report['source_grid_phase']=[]
    dx=build_grid(validate_sources(PARAMS))['maximum_dx_m']
    for shift in [-dx/4,0.,dx/4]:
        p=deepcopy(PARAMS);p['sources'][1]['source_distance_m']+=shift
        grid=build_grid(validate_sources(p));assert p['sources'][1]['source_distance_m'] in grid['edges']
        base=simulate_multiple(p)
        item=dict(position_m=p['sources'][1]['source_distance_m'],position_approximation_error_m=0.,physical_shift_m=shift,
                  base_difference_due_to_physical_position_shift_mg_l=maximum_common_difference(result,base))
        try:
            fine=simulate_multiple(p,spatial_refinement=2.)
            item['max_dx_refinement_difference_mg_l']=maximum_common_difference(base,fine)
        except ValueError as error:item['refinement_rejected']=str(error)
        report['source_grid_phase'].append(item)
    # Legacy uses its historical one-source domain/model identity, unchanged.
    old={k:v for k,v in PARAMS.items() if k!='sources'}|{k:v for k,v in PARAMS['sources'][0].items() if k in ('effluent_flow_m3_s','effluent_mg_l','load_mode','load_duration_hours','load_intervals')}
    single=simulate_multiple(PARAMS|dict(sources=[PARAMS['sources'][0]]));legacy=simulate(old)
    report['one_source_vs_legacy']=dict(max_difference_at_49_common_times_mg_l=maximum_common_difference(single,legacy),new_cells=single['diagnostics']['cells'],legacy_cells=legacy['diagnostics']['cells'])
    assert report['one_source_vs_legacy']['max_difference_at_49_common_times_mg_l']<1e-10
    signed=deepcopy(PARAMS);signed['sources']=signed['sources'][1:];s=signed['sources'][0];s['effluent_flow_m3_s']=.1
    s['load_intervals']=[dict(start_hours=0.,end_hours=.5,effluent_mg_l=0.),dict(start_hours=2.,end_hours=2.5,effluent_mg_l=20.)]
    cancellation=simulate_multiple(signed)
    report['signed_cancellation']=dict(diagnostics=cancellation['diagnostics'],absolute_excess_throughput_kg=3.6,minimum_output_mg_l=min(map(min,cancellation['concentrations_mg_l'])))
    assert abs(cancellation['diagnostics']['excess_incoming_kg'])<1e-14
    assert cancellation['diagnostics']['relative_excess_mass_error']<1e-10
    output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k in ('resolved_peaks','max_peak_relative_error','independently_measured_interpolation_error','one_source_vs_legacy')},indent=2))
    print(output)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args();run(args.output)
