import math
from copy import deepcopy
import pytest
from app.multiple_transport import simulate_multiple, validate_sources, build_grid
from app.transport import simulate

BASE=dict(river_flow_m3_s=10.,background_mg_l=10.,velocity_m_s=.25,dispersion_m2_s=5.,length_m=1000.,duration_hours=.1)
def source(id='a',x=0.,q=.1,ce=100.,mode='continuous',end=None,rows=None):
    return dict(id=id,name='Сценарный '+id,source_distance_m=x,effluent_flow_m3_s=q,effluent_mg_l=ce,load_mode=mode,load_duration_hours=end,load_intervals=rows)
def row(a,b,ce):return dict(start_hours=a,end_hours=b,effluent_mg_l=ce)
def params(*sources,**changes):return BASE|dict(sources=list(sources))|changes

def test_one_upstream_source_agrees_with_legacy_control():
    p=params(source());actual=simulate_multiple(p)
    old=simulate({k:v for k,v in BASE.items()}|dict(effluent_flow_m3_s=.1,effluent_mg_l=100.))
    # Compare common physical times: one model has a new storage/forcing contract.
    from bisect import bisect_left
    def at(r,t):
        i=bisect_left(r['times_hours'],t)
        if i==len(r['times_hours']):return r['concentrations_mg_l'][-1]
        if i==0:return r['concentrations_mg_l'][0]
        f=(t-r['times_hours'][i-1])/(r['times_hours'][i]-r['times_hours'][i-1]);return [a+f*(b-a) for a,b in zip(r['concentrations_mg_l'][i-1],r['concentrations_mg_l'][i])]
    assert max(abs(a-b) for i in range(49) for a,b in zip(at(actual,i*.1/48),at(old,i*.1/48)))<1e-10

@pytest.mark.parametrize('sources',[[source(x=0.,ce=10.),source('b',500.,.4,10.)],[source(x=500.,q=0.)]])
def test_background_invariant_with_nonzero_water_and_zero_load(sources):
    r=simulate_multiple(params(*sources));assert all(v==10. for values in r['concentrations_mg_l'] for v in values)
    assert abs(r['diagnostics']['mass_error_kg'])<1e-8

def test_zero_water_source_does_not_change_physics():
    a=simulate_multiple(params(source()));b=simulate_multiple(params(source(),source('b',543.21,0.,10000.)))
    assert a['times_hours']==b['times_hours'];assert a['concentrations_mg_l']==b['concentrations_mg_l']

def test_same_position_order_and_merge_are_equivalent():
    p=params(source(x=400.,q=.1,ce=100.),source('b',400.,.05,60.));a=simulate_multiple(p)
    b=simulate_multiple(p|dict(sources=list(reversed(p['sources']))))
    c=simulate_multiple(params(source(x=400.,q=.15,ce=(.1*100+.05*60)/.15)))
    assert a['times_hours']==b['times_hours'];assert a['concentrations_mg_l']==b['concentrations_mg_l']
    assert max(abs(x-y) for ar,cr in zip(a['concentrations_mg_l'],c['concentrations_mg_l']) for x,y in zip(ar,cr))<1e-10
    assert a['inputs']['sources']==p['sources']

def test_exact_event_faces_and_signed_mass():
    p=params(source(mode='profile',ce=None,rows=[row(.00123,.01123,100.),row(.01123,.02123,0.)]),source('b',543.21,.05,None,'profile',rows=[row(.01123,.03123,30.)]))
    r=simulate_multiple(p);events={0.,.00123,.01123,.02123,.03123,.1};assert events<=set(r['times_hours'])
    d=r['diagnostics'];expected=.1*.001*((100-10)*.01+(0-10)*.01)*3600+.05*.001*(30-10)*.02*3600
    assert d['excess_incoming_kg']==pytest.approx(expected,abs=1e-12);assert abs(d['excess_mass_error_kg'])<1e-10
    assert min(map(min,r['concentrations_mg_l']))>=0
    assert d['source_positions_m']==[0.,543.21]
    assert d['water_flow_segments_m3_s'][-1]==pytest.approx(10.15)

@pytest.mark.parametrize('change',[dict(sources=[]),dict(sources=[source(str(i)) for i in range(4)]),dict(sources=[source(),source()]),dict(sources=[source(x=901.)]),dict(sources=[source(x=-1.)]),dict(sources=[source(q=math.inf)]),dict(sources=[source(mode='profile',ce=None,rows=[row(0,.09,20),row(.08,.1,40)])])])
def test_invalid_sources_rejected(change):
    with pytest.raises(ValueError):validate_sources(BASE|change)

def test_exact_geometry_contains_internal_source_without_snapping():
    g=build_grid(validate_sources(params(source(x=543.21))));assert 543.21 in g['edges']
    with pytest.raises(ValueError):simulate_multiple(params(source(x=math.nextafter(500.,math.inf))))

@pytest.mark.parametrize('x',[5e-324,math.nextafter(500.,math.inf)])
def test_unresolvable_source_face_is_clear_validation_error(x):
    with pytest.raises(ValueError,match='близк|размер|границ'):
        simulate_multiple(params(source(x=x)))


def common_rows(result):
    return {t:values for t,values in zip(result['times_hours'],result['concentrations_mg_l'])}

def test_downstream_background_water_dilutes_upstream_load():
    p=params(source(),source('b',500.,.5,10.),duration_hours=6.)
    r=simulate_multiple(p);expected=10.+.1*(100.-10.)/10.6
    assert r['concentrations_mg_l'][-1][-1]==pytest.approx(expected,abs=1e-8)
    without=simulate_multiple(params(source(),duration_hours=6.))
    assert r['concentrations_mg_l'][-1][-1]<without['concentrations_mg_l'][-1][-1]
    assert abs(r['diagnostics']['mass_error_kg'])<1e-8

def test_linear_excess_loads_with_unchanged_all_source_water_flows():
    p=params(source(mode='profile',ce=None,rows=[row(0,.01,100.)]),source('b',543.21,.05,None,'profile',rows=[row(.02,.03,60.)]))
    both=simulate_multiple(p)
    first=deepcopy(p);first['sources'][1]['load_intervals'][0]['effluent_mg_l']=10.
    second=deepcopy(p);second['sources'][0]['load_intervals'][0]['effluent_mg_l']=10.
    a,b=simulate_multiple(first),simulate_multiple(second)
    ar,br,combined=common_rows(a),common_rows(b),common_rows(both)
    shared=sorted(set(ar)&set(br)&set(combined));assert len(shared)>=49
    assert max(abs(x+y-10.-z) for t in shared for x,y,z in zip(ar[t],br[t],combined[t]))<2e-11

def test_coincident_independent_profiles_equal_water_weighted_source():
    a=source(mode='profile',ce=None,rows=[row(0,.03,100.)]);b=source('b',0.,.1,None,'profile',rows=[row(.03,.06,60.)])
    both=simulate_multiple(params(a,b));one=simulate_multiple(params(source(q=.2,mode='profile',ce=None,rows=[row(0,.03,55.),row(.03,.06,35.)])))
    assert both['times_hours']==one['times_hours']
    assert max(abs(x-y) for a,b in zip(both['concentrations_mg_l'],one['concentrations_mg_l']) for x,y in zip(a,b))<1e-11

def test_signed_mass_cancellation_does_not_break_relative_diagnostic():
    r=simulate_multiple(params(source(x=500.,mode='profile',ce=None,rows=[row(0,.05,0.),row(.05,.1,20.)])))
    assert r['diagnostics']['excess_incoming_kg']==pytest.approx(0.,abs=1e-15)
    assert r['diagnostics']['relative_excess_mass_error']<1e-10
    assert min(map(min,r['concentrations_mg_l']))>0

@pytest.mark.parametrize('x',[0.,500.,900.])
def test_source_beginning_middle_and_allowed_end_have_exact_face(x):
    r=simulate_multiple(params(source(x=x)))
    assert r['diagnostics']['source_position_error_m']==[0.]
    assert r['diagnostics']['source_positions_m']==[x]

@pytest.mark.parametrize('field',['MAX_CELLS','MAX_STEPS','MAX_UPDATES','MAX_REFERENCE_BYTES'])
def test_each_existing_resource_budget_is_enforced(monkeypatch,field):
    import app.multiple_transport as module
    monkeypatch.setattr(module,field,1)
    with pytest.raises(ValueError,match='размер|разрешение'):module.simulate_multiple(params(source()))

def test_output_state_budget_is_not_silently_relaxed(monkeypatch):
    import app.transport as module
    monkeypatch.setattr(module,'MAX_OUTPUT_STATES',10)
    with pytest.raises(ValueError,match='разрешение'):simulate_multiple(params(source()))

@pytest.mark.parametrize('control',[chr(0),chr(31),chr(127),chr(128),chr(159)])
def test_source_names_reject_control_characters(control):
    with pytest.raises(ValueError):validate_sources(params(source()|dict(name='a'+control+'b')))


@pytest.mark.parametrize('mode,end',[('continuous',None),('finite',.0333)])
def test_legacy_load_modes_and_one_profile_row_are_equivalent(mode,end):
    a=simulate_multiple(params(source(mode=mode,end=end)))
    b=simulate_multiple(params(source(mode='profile',ce=None,rows=[row(0.,end or .1,100.)])))
    assert a['times_hours']==b['times_hours']
    assert a['concentrations_mg_l']==b['concentrations_mg_l']

def test_demonstration_dense_output_preserves_all_resolved_peaks_and_error_bound():
    from bisect import bisect_right
    from app.river import prepared_reach
    p=params(source(mode='profile',ce=None,rows=[row(0.,.5,100.)]),source('b',1200.,.05,None,'profile',rows=[row(2.,2.5,60.)]),length_m=prepared_reach()[1].length_m,duration_hours=6.)
    reference=[];r=simulate_multiple(p,reference_callback=lambda t,row:reference.append((t,row.copy())))
    saved=dict(zip(r['times_hours'],r['concentrations_mg_l']));control=dict(reference)
    assert all(control[t]==values for t,values in saved.items())
    assert r['diagnostics']['excess_incoming_kg']==pytest.approx(20.7,abs=1e-12)
    assert r['diagnostics']['downstream_flow_m3_s']==10.15
    assert abs(r['diagnostics']['excess_mass_error_kg'])<1e-8
    amplitudes=[max(abs(values[j]-10.) for _,values in reference) for j in range(100)]
    for t,values in reference:
        i=min(bisect_right(r['times_hours'],t),len(r['times_hours'])-1);left=max(0,i-1)
        weight=(t-r['times_hours'][left])/(r['times_hours'][i]-r['times_hours'][left]) if i!=left else 0.
        assert all(abs((a+weight*(b-a))-value)<=max(amplitude*.01,1e-9)+1e-12 for a,b,value,amplitude in zip(r['concentrations_mg_l'][left],r['concentrations_mg_l'][i],values,amplitudes))
    count=0
    for j in range(100):
        direction=0
        for i in range(1,len(reference)):
            difference=reference[i][1][j]-reference[i-1][1][j];new=(difference>0)-(difference<0)
            if new<0 and direction>0 and reference[i-1][1][j]-10.>1e-8:
                t,values=reference[i-1];assert t in saved and saved[t][j]==values[j];count+=1
            if new:direction=new
    assert count>100 # Some peaks overlap physically; only resolved separate maxima are counted.
