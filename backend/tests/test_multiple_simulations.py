import pytest
from pydantic import ValidationError
from app.multiple_simulation import MultipleSimulationRequest, validate_multiple_geometry
from app.river import prepared_reach
from test_multiple_transport import BASE, source

def request(*sources,**changes):
    return {k:v for k,v in BASE.items() if k!='length_m'}|dict(reach_id='don-olkhovets',sources=list(sources))|changes

def test_pydantic_snapshot_has_explicit_independent_full_sources():
    p=request(source(),source('b',500.,.05,60.));assert MultipleSimulationRequest.model_validate(p).model_dump()==p

@pytest.mark.parametrize('change',[dict(sources=[]),dict(sources=[source(),source()]),dict(sources=[source(ce=None)]),dict(sources=[source()|dict(name=' ')]),dict(sources=[source()|dict(id='ид')]),dict(sources=[source()|dict(load_intervals=[])]),dict(sources=[{k:v for k,v in source().items() if k!='load_intervals'}])])
def test_strict_new_request_rejects_incomplete_invalid_sources(change):
    with pytest.raises(ValidationError):MultipleSimulationRequest.model_validate(request(source())|change)

def test_geometry_guard_rejects_end_and_preserves_exact_position():
    p=MultipleSimulationRequest.model_validate(request(source(x=1200.)))
    reach,line=validate_multiple_geometry(p);assert reach['id']=='don-olkhovets'
    with pytest.raises(ValueError):validate_multiple_geometry(MultipleSimulationRequest.model_validate(request(source(x=line.length_m-99.))))

@pytest.mark.anyio
async def test_actual_api_dispatches_new_model_with_full_reach_and_all_sources(client):
    p=request(source(x=0.),source('b',1200.,.05,60.),duration_hours=.1)
    response=await client.post('/api/v1/simulations',json=p);assert response.status_code==200,response.text
    data=response.json();assert data['format_version']==3 and data['model_id']=='conservative-1d-lateral-inflow-v2'
    assert data['inputs']==p|dict(length_m=prepared_reach()[1].length_m)
    assert len(data['segment_geometries'])==100
    assert data['geometry']['coordinates'][0]==list(prepared_reach()[1].point_at(0))
    assert [s['id'] for s in data['source_coordinates']]==['a','b']
    assert data['source_coordinates'][1]['coordinate']==list(prepared_reach()[1].point_at(1200.))
    assert data['derived']['total_flow_m3_s']==10.15
    assert data['derived']['steady_mg_l'] is None
    assert abs(data['diagnostics']['mass_error_kg'])<1e-8

@pytest.mark.anyio
async def test_api_legacy_still_returns_format2_and_model1(client):
    p=BASE|dict(effluent_flow_m3_s=.1,effluent_mg_l=100.)
    response=await client.post('/api/v1/simulations',json=p);assert response.status_code==200
    assert response.json()['format_version']==2 and response.json()['model_id']=='conservative-1d-advection-dispersion-v1'

@pytest.mark.anyio
async def test_new_api_errors_remain_bounded_and_invalid_positions_clear(client):
    response=await client.post('/api/v1/simulations',json=request(source(x=10000.)))
    assert response.status_code==422 and '100' in response.text
    response=await client.post('/api/v1/simulations',content=b' '*4097)
    assert response.status_code==413


@pytest.mark.parametrize('name',['a'+chr(127),'a'+chr(128),chr(31)+'a',chr(159)+'a'])
def test_request_rejects_controls_before_name_trimming(name):
    with pytest.raises(ValidationError):MultipleSimulationRequest.model_validate(request(source()|dict(name=name)))


@pytest.mark.anyio
async def test_new_api_measures_response_budget_without_relaxing_it(client,monkeypatch):
    import app.multiple_simulation as module
    monkeypatch.setattr(module,'MAX_RESPONSE_BYTES',20)
    response=await client.post('/api/v1/simulations',json=request(source()))
    assert response.status_code==422 and '20' in response.text

@pytest.mark.anyio
@pytest.mark.parametrize('duration',[.1,.2,.4,.7,6.1])
@pytest.mark.parametrize('mode',['continuous','profile'])
async def test_new_api_fractional_horizons_have_exact_strict_times(client,duration,mode):
    from test_multiple_transport import row
    s=source() if mode=='continuous' else source(mode='profile',ce=None,rows=[row(.001,duration/2,100.)])
    response=await client.post('/api/v1/simulations',json=request(s,duration_hours=duration));assert response.status_code==200,response.text
    times=response.json()['times_hours'];assert times[0]==0 and times[-1]==duration
    assert all(0<=a<b<=duration for a,b in zip(times,times[1:]))
    if mode=='profile':assert .001 in times and duration/2 in times


def test_new_union_openapi_request_has_resolvable_local_references():
    from fastapi import FastAPI
    from app.simulation import router
    app=FastAPI();app.include_router(router);document=app.openapi()
    def visit(value):
        if isinstance(value,dict):
            if '$ref' in value and value['$ref'].startswith('#/'):
                target=document
                for key in value['$ref'][2:].split('/'):
                    target=target[key.replace('~1','/').replace('~0','~')]
            for child in value.values():visit(child)
        elif isinstance(value,list):
            for child in value:visit(child)
    visit(document)
