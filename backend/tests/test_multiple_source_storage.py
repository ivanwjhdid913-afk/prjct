"""Portable and library snapshots for the explicitly versioned multi-source model."""
import copy
import json
import pytest
from app.river import prepared_reach


def document():
    reach, _ = prepared_reach('don-olkhovets')
    source = dict(id='source-1', name='Сценарный источник 1', source_distance_m=0., effluent_flow_m3_s=.1,
                  effluent_mg_l=None, load_mode='profile', load_duration_hours=None,
                  load_intervals=[dict(start_hours=0., end_hours=.5, effluent_mg_l=100.)])
    second = copy.deepcopy(source)
    second.update(id='source-2', name='Сценарный источник 2', source_distance_m=1200., effluent_flow_m3_s=.05)
    second['load_intervals']=[dict(start_hours=2., end_hours=2.5, effluent_mg_l=60.)]
    return dict(name='Два сценарных источника',format_version=3,model_id='conservative-1d-lateral-inflow-v2',
                geometry_mode='river',geometry_version='river-wgs84-v1',geometry_sha256=reach['metadata']['geometry_sha256'],
                downstream_geometry_sha256=reach['metadata']['downstream_geometry_sha256'],reach_id=reach['id'],reach_name=reach['name'],
                geometry_source={},conditions=dict(river_flow_m3_s=10.,background_mg_l=10.,velocity_m_s=.25,
                    dispersion_m2_s=5.,duration_hours=6.,reach_id=reach['id'],sources=[source,second]))


def payload(sent):
    return {key:sent[key] for key in ('name','format_version','model_id','geometry_version','geometry_sha256','conditions')}


@pytest.mark.anyio
async def test_multi_document_and_library_keep_all_sources_without_averaging(client):
    sent=document();original=copy.deepcopy(sent)
    response=await client.post('/api/v1/scenario-files/validate',json=sent)
    assert response.status_code==200,response.text
    assert response.json()['compatibility']==dict(compatible=True,reasons=[])
    assert response.json()['document']==sent
    saved=await client.post('/api/v1/scenarios',json=payload(sent))
    assert saved.status_code==201,saved.text
    saved=saved.json();assert saved['load_mode']=='multiple';assert saved['conditions']==original['conditions']
    sent['conditions']['sources'][0]['load_intervals'][0]['effluent_mg_l']=777.
    actual=(await client.get('/api/v1/scenarios/'+saved['id'])).json()
    assert actual['conditions']==original['conditions']
    assert actual['compatibility']['compatible']
    assert (await client.get('/api/v1/scenarios')).json()['items'][0]['load_mode']=='multiple'


@pytest.mark.anyio
@pytest.mark.parametrize('version,model',[(1,'conservative-1d-advection-dispersion-v1'),(2,'conservative-1d-advection-dispersion-v1'),(3,'conservative-1d-advection-dispersion-v1'),(2,'conservative-1d-lateral-inflow-v2')])
async def test_multi_snapshot_cannot_masquerade_as_old_format_or_physics(client,version,model):
    sent=document();sent.update(format_version=version,model_id=model)
    assert (await client.post('/api/v1/scenarios',json=payload(sent))).status_code==422
    checked=await client.post('/api/v1/scenario-files/validate',json=sent)
    assert checked.status_code==422 or not checked.json()['compatibility']['compatible']


@pytest.mark.anyio
@pytest.mark.parametrize('field',['id','name','source_distance_m','effluent_flow_m3_s','effluent_mg_l','load_mode','load_duration_hours','load_intervals'])
async def test_multi_portable_source_requires_complete_explicit_snapshot(client,field):
    sent=document();sent['conditions']['sources'][0].pop(field)
    assert (await client.post('/api/v1/scenario-files/validate',json=sent)).status_code==422


@pytest.mark.anyio
async def test_multi_positions_and_snapshot_size_rejected_without_writes(client):
    sent=document();sent['conditions']['sources'][1]['source_distance_m']=99999.
    assert (await client.post('/api/v1/scenarios',json=payload(sent))).status_code==422
    sent=document();sent['conditions']['sources']=sent['conditions']['sources'][:1]
    for i in range(3):
        source=copy.deepcopy(sent['conditions']['sources'][0]);source['id']=f'{i+1}'+'s'*63;source['name']='я'*80
        source['load_intervals']=[dict(start_hours=j/4,end_hours=(j+1)/4,effluent_mg_l=100.12345678912345) for j in range(12)]
        if i:sent['conditions']['sources'].append(source)
        else:sent['conditions']['sources'][0]=source
    assert len(json.dumps(sent['conditions'],ensure_ascii=False).encode())>4096
    response=await client.post('/api/v1/scenarios',content=json.dumps(payload(sent),ensure_ascii=False),headers={'Content-Type':'application/json'})
    assert response.status_code==422 and '4096' in response.json()['detail'],response.text
    assert (await client.get('/api/v1/scenarios')).json()['total']==0


def test_0005_preserves_legacy_snapshots_and_blocks_multiple_source_downgrade():
    import subprocess,sys
    from sqlalchemy import text
    from sqlalchemy.orm import Session
    from app.db import engine
    from app.scenarios import ScenarioCreate,persist
    ids=[]
    try:
        with Session(engine) as db:
            sent=document();saved=persist(ScenarioCreate.model_validate(payload(sent)),db);ids.append(str(saved.id))
        rejected=subprocess.run([sys.executable,'-m','alembic','downgrade','0004'],text=True,capture_output=True)
        assert rejected.returncode!=0
        assert 'saved multiple-source scenarios exist' in rejected.stderr
        with engine.connect() as connection:
            assert connection.scalar(text('SELECT version_num FROM alembic_version'))=='0006'
            assert connection.scalar(text('SELECT conditions FROM saved_scenarios WHERE id=:id'),{'id':ids[0]})==sent['conditions']
        with engine.begin() as connection:
            connection.execute(text('DELETE FROM saved_scenarios WHERE id=:id'),{'id':ids[0]})
        ids.clear()
        subprocess.run([sys.executable,'-m','alembic','downgrade','0004'],check=True)
        subprocess.run([sys.executable,'-m','alembic','upgrade','head'],check=True)
    finally:
        with engine.begin() as connection:
            for identity in ids:connection.execute(text('DELETE FROM saved_scenarios WHERE id=:id'),{'id':identity})
        subprocess.run([sys.executable,'-m','alembic','upgrade','head'],check=True)
