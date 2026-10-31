"""Saved conditions use the disposable PostgreSQL database, never working data."""
from datetime import datetime
import json
from uuid import UUID, uuid4

import pytest
import httpx
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.db import engine, get_session
from app.main import app


MODEL_ID = 'conservative-1d-advection-dispersion-v1'
PARAMS = dict(river_flow_m3_s=10., effluent_flow_m3_s=.1, background_mg_l=10.,
              effluent_mg_l=100., velocity_m_s=.25, dispersion_m2_s=5.,
              duration_hours=.1, load_mode='continuous', load_duration_hours=None)


async def payload(client, reach_id=None, finite=False, last=False):
    conditions = PARAMS.copy()
    if finite:
        conditions.update(load_mode='finite', load_duration_hours=.001)
    if reach_id:
        catalog = (await client.get('/api/v1/river-reaches')).json()['items']
        reach = next(item for item in catalog if item['id'] == reach_id)
        conditions.update(reach_id=reach_id, source_distance_m=reach['length_m'] - 100 if last else 12.3456789)
        version = 'river-wgs84-v1'
        checksum = reach['metadata']['geometry_sha256']
    else:
        conditions.update(length_m=500.25, source_distance_m=0.)
        version = 'synthetic-wgs84-meridian-v1'
        checksum = None
    return dict(name='  Проверка условий  ', format_version=1, model_id=MODEL_ID,
                geometry_version=version, geometry_sha256=checksum, conditions=conditions)


@pytest.mark.anyio
@pytest.mark.parametrize('reach_id', [None, 'don-olkhovets', 'voronezh-zheltye-peski'])
@pytest.mark.parametrize('finite', [False, True])
async def test_saved_conditions_roundtrip_keeps_fractional_inputs_and_independent_copies(client, reach_id, finite):
    sent = await payload(client, reach_id, finite, last=True)
    response = await client.post('/api/v1/scenarios', json=sent)
    assert response.status_code == 201, response.text
    record = response.json()
    UUID(record['id'])
    assert record['name'] == sent['name'].strip()
    assert record['format_version'] == 1 and record['model_id'] == MODEL_ID
    assert record['geometry_version'] == sent['geometry_version']
    assert record['geometry_sha256'] == sent['geometry_sha256']
    assert record['compatibility'] == {'compatible': True, 'reasons': []}
    assert datetime.fromisoformat(record['created_at'].replace('Z', '+00:00')).utcoffset() is not None
    for key, value in sent['conditions'].items():
        assert record['conditions'][key] == value
    assert record['geometry_mode'] == ('river' if reach_id else 'synthetic')
    if reach_id:
        assert len(record['downstream_geometry_sha256']) == 64
        assert record['geometry_source']['osm_way_version'] in [32, 57]
    loaded = (await client.get('/api/v1/scenarios/' + record['id'])).json()
    assert loaded == record
    sent['name'] = 'Изменённый вариант'
    sent['conditions']['effluent_mg_l'] = 50.
    changed = await client.post('/api/v1/scenarios', json=sent)
    assert changed.status_code == 201
    assert changed.json()['id'] != record['id']
    assert (await client.get('/api/v1/scenarios/' + record['id'])).json() == record
    assert 'concentrations_mg_l' not in record and 'results' not in record


@pytest.mark.anyio
async def test_saved_conditions_empty_list_and_bounded_stable_pagination(client):
    assert (await client.get('/api/v1/scenarios')).json() == {'items': [], 'total': 0, 'limit': 20, 'offset': 0}
    sent = await payload(client)
    ids = []
    for number in range(3):
        response = await client.post('/api/v1/scenarios', json=sent | {'name': f'Условия {number}'})
        assert response.status_code == 201
        ids.append(response.json()['id'])
    first = (await client.get('/api/v1/scenarios?limit=2')).json()
    last = (await client.get('/api/v1/scenarios?limit=2&offset=2')).json()
    assert first['total'] == last['total'] == 3
    assert len(first['items']) == 2 and len(last['items']) == 1
    assert {item['id'] for item in first['items'] + last['items']} == set(ids)
    assert first == (await client.get('/api/v1/scenarios?limit=2')).json()
    assert all('conditions' not in item for item in first['items'])
    for query in ['limit=0', 'limit=51', 'offset=-1', 'offset=1000001']:
        assert (await client.get('/api/v1/scenarios?' + query)).status_code == 422


@pytest.mark.anyio
async def test_saved_conditions_unknown_uuid_and_unsupported_mutations(client):
    assert (await client.get('/api/v1/scenarios/' + str(uuid4()))).status_code == 404
    assert (await client.get('/api/v1/scenarios/not-a-uuid')).status_code == 422
    assert (await client.put('/api/v1/scenarios/' + str(uuid4()), json={})).status_code == 405


@pytest.mark.anyio
@pytest.mark.parametrize('change', [
    {'name': ''}, {'name': '   '}, {'name': 'x' * 121}, {'name': 'a\nName'},
    {'format_version': 2}, {'format_version': True}, {'model_id': 'unknown'},
    {'geometry_version': 'unknown'}, {'geometry_sha256': 'a' * 64}, {'results': []},
    {'conditions': {}}, {'conditions': PARAMS | {'length_m': 500., 'duration_hours': float('inf')}},
    {'conditions': PARAMS | {'length_m': 500., 'effluent_flow_m3_s': -1.}},
    {'conditions': PARAMS | {'length_m': 500., 'load_mode': 'finite', 'load_duration_hours': .2}},
    {'conditions': PARAMS | {'length_m': 500., 'source_distance_m': 1.}},
])
async def test_saved_conditions_reject_invalid_data_without_writes(client, change):
    sent = await payload(client)
    # httpx intentionally refuses non-finite JSON, so encode this one explicitly.
    import json
    response = await client.post('/api/v1/scenarios', content=json.dumps(sent | change),
                                 headers={'content-type': 'application/json'})
    assert response.status_code == 422, response.text
    assert (await client.get('/api/v1/scenarios')).json()['total'] == 0


@pytest.mark.anyio
async def test_saved_conditions_reject_unknown_changed_and_too_short_geometry(client):
    sent = await payload(client, 'don-olkhovets')
    for invalid in [
        sent | {'geometry_sha256': 'a' * 64},
        sent | {'conditions': sent['conditions'] | {'reach_id': 'missing'}},
        sent | {'conditions': sent['conditions'] | {'source_distance_m': 20000.}},
        sent | {'conditions': sent['conditions'] | {'length_m': 500.}},
    ]:
        response = await client.post('/api/v1/scenarios', json=invalid)
        assert response.status_code == 422, response.text


@pytest.mark.anyio
async def test_save_rejects_hydraulics_outside_verified_river_continuation(client):
    sent = await payload(client, 'voronezh-zheltye-peski')
    sent['conditions'].update(velocity_m_s=.02, dispersion_m2_s=100.)
    response = await client.post('/api/v1/scenarios', json=sent)
    assert response.status_code == 422
    assert 'буфер' in response.json()['detail']
    assert (await client.get('/api/v1/scenarios')).json()['total'] == 0


@pytest.mark.anyio
async def test_saved_conditions_bounds_streamed_request_before_json_parsing(client):
    async def oversized():
        yield b'{"name":"'
        yield b'x' * 8193
        yield b'"}'
    response = await client.post('/api/v1/scenarios', content=oversized(), headers={'content-type': 'application/json'})
    assert response.status_code == 413
    assert '8192' in response.json()['detail']


@pytest.mark.anyio
@pytest.mark.parametrize('column,value,reason', [
    ('reach_id', 'removed-reach', 'согласованы'),
    ('geometry_sha256', 'f' * 64, 'изменилась'),
    ('downstream_geometry_sha256', 'f' * 64, 'продолжения'),
    ('geometry_version', 'river-wgs84-v2', 'Версия'),
    ('model_id', 'future-numerics-v2', 'модели'),
    ('format_version', 3, 'формата'),
])
async def test_open_incompatible_record_explains_reason_and_preserves_original(client, session, column, value, reason):
    sent = await payload(client, 'don-olkhovets')
    created = (await client.post('/api/v1/scenarios', json=sent)).json()
    # Simulate catalog/model evolution or a record from a later format in the disposable database.
    # Column names are test constants, never user SQL.
    session.execute(text(f'UPDATE saved_scenarios SET {column}=:value WHERE id=:id'),
                    {'value': value, 'id': created['id']})
    session.flush()
    response = await client.get('/api/v1/scenarios/' + created['id'])
    assert response.status_code == 200, response.text
    record = response.json()
    assert record[column] == value
    assert record['conditions'] == created['conditions']
    assert not record['compatibility']['compatible']
    assert any(reason in item for item in record['compatibility']['reasons'])
    assert (await client.get('/api/v1/scenarios/' + created['id'])).json() == record
    assert (await client.get('/api/v1/scenarios')).json()['total'] == 1


@pytest.mark.anyio
async def test_removed_reach_does_not_remap_its_saved_source(client, session):
    from app.models import SavedScenario
    created = (await client.post('/api/v1/scenarios', json=await payload(client, 'don-olkhovets'))).json()
    row = session.get(SavedScenario, UUID(created['id']))
    row.reach_id = 'removed-reach'
    row.conditions = row.conditions | {'reach_id': 'removed-reach'}
    session.flush()
    result = (await client.get('/api/v1/scenarios/' + created['id'])).json()
    assert not result['compatibility']['compatible']
    assert 'Неизвестный' in result['compatibility']['reasons'][0]
    assert result['reach_id'] == result['conditions']['reach_id'] == 'removed-reach'
    assert result['conditions']['source_distance_m'] == created['conditions']['source_distance_m']


@pytest.mark.anyio
async def test_database_unavailable_does_not_acknowledge_saved_record(client):
    unavailable = create_engine(engine.url.set(port=1), connect_args={'connect_timeout': 1})
    sent = await payload(client)

    def fail_session():
        with Session(unavailable) as session:
            yield session

    app.dependency_overrides[get_session] = fail_session
    try:
        for method, url, kwargs in [
            ('POST', '/api/v1/scenarios', {'json': sent}),
            ('GET', '/api/v1/scenarios', {}),
            ('GET', '/api/v1/scenarios/' + str(uuid4()), {}),
        ]:
            response = await client.request(method, url, **kwargs)
            assert response.status_code == 503
            assert 'База данных временно недоступна' in response.json()['detail']
            assert 'password' not in response.text and 'localhost' not in response.text
    finally:
        unavailable.dispose()


@pytest.mark.anyio
async def test_failed_commit_rolls_back_and_never_returns_success(client, session, monkeypatch):
    from app.models import SavedScenario
    sent = await payload(client)
    def commit_failure():
        raise OperationalError('commit', {}, Exception('internal database detail'))
    monkeypatch.setattr(session, 'commit', commit_failure)
    response = await client.post('/api/v1/scenarios', json=sent)
    assert response.status_code == 503
    assert 'Условия не сохранены' in response.json()['detail']
    assert 'internal database detail' not in response.text
    assert session.scalar(select(func.count()).select_from(SavedScenario)) == 0


@pytest.mark.anyio
async def test_committed_conditions_survive_new_app_connection_without_calculating(client):
    # Use independent real transactions in the same disposable database to prove commit/persistence.
    app.dependency_overrides.pop(get_session)
    created = None
    try:
        sent = await payload(client, 'voronezh-zheltye-peski', True, last=True)
        response = await client.post('/api/v1/scenarios', json=sent)
        assert response.status_code == 201, response.text
        created = response.json()
        engine.dispose()
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://fresh') as fresh:
            loaded = await fresh.get('/api/v1/scenarios/' + created['id'])
        assert loaded.status_code == 200 and loaded.json() == created
        with engine.connect() as connection:
            assert connection.scalar(text('SELECT count(*) FROM saved_scenarios WHERE id=:id'), {'id': created['id']}) == 1
            assert connection.scalar(text("SELECT count(*) FROM information_schema.columns WHERE table_name='saved_scenarios' AND column_name LIKE '%concentration%'") ) == 0
    finally:
        if created:
            with engine.begin() as connection:
                connection.execute(text('DELETE FROM saved_scenarios WHERE id=:id'), {'id': created['id']})


@pytest.mark.anyio
@pytest.mark.parametrize('content_type', ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', None])
async def test_browser_simple_requests_cannot_create_scenarios(client, session, content_type):
    sent = await payload(client)
    headers = {'origin': 'https://unrelated.example'}
    if content_type is not None:
        headers['content-type'] = content_type
    response = await client.post('/api/v1/scenarios', content=json.dumps(sent),
                                 headers=headers)
    assert response.status_code == 415
    assert session.scalar(text('SELECT count(*) FROM saved_scenarios')) == 0


@pytest.mark.anyio
async def test_json_charset_remains_supported(client):
    sent = await payload(client)
    response = await client.post('/api/v1/scenarios', content=json.dumps(sent),
                                 headers={'content-type': 'application/json; charset=UTF-8'})
    assert response.status_code == 201
