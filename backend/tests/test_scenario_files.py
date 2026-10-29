"""Portable condition files are validated without writes or calculations."""
import json

import pytest
from sqlalchemy import text

from app.river import prepared_reach


PARAMS = dict(river_flow_m3_s=10., effluent_flow_m3_s=.1, background_mg_l=10.,
              effluent_mg_l=100., velocity_m_s=.25, dispersion_m2_s=5.,
              duration_hours=.1, load_mode='continuous', load_duration_hours=None)


def document(reach_id=None, finite=False, last=False):
    conditions = PARAMS.copy()
    if finite:
        conditions.update(load_mode='finite', load_duration_hours=.001)
    if reach_id:
        reach, line = prepared_reach(reach_id)
        conditions.update(reach_id=reach_id, source_distance_m=line.length_m - 100 if last else 12.3456789,
                          length_m=None)
        return dict(name='  Перенос условий  ', format_version=1,
                    model_id='conservative-1d-advection-dispersion-v1', geometry_mode='river',
                    geometry_version='river-wgs84-v1', geometry_sha256=reach['metadata']['geometry_sha256'],
                    downstream_geometry_sha256=reach['metadata']['downstream_geometry_sha256'],
                    reach_id=reach_id, reach_name=reach['name'], geometry_source={}, conditions=conditions)
    conditions.update(length_m=500.125, reach_id=None, source_distance_m=0.)
    return dict(name='  Перенос условий  ', format_version=1,
                model_id='conservative-1d-advection-dispersion-v1', geometry_mode='synthetic',
                geometry_version='synthetic-wgs84-meridian-v1', geometry_sha256=None,
                downstream_geometry_sha256=None, reach_id=None, reach_name='Синтетический участок',
                geometry_source={}, conditions=conditions)


@pytest.mark.anyio
@pytest.mark.parametrize('reach_id', [None, 'don-olkhovets', 'voronezh-zheltye-peski'])
@pytest.mark.parametrize('finite', [False, True])
async def test_condition_file_roundtrip_without_side_effects(client, session, monkeypatch, reach_id, finite):
    import app.simulation
    def forbidden(*args, **kwargs):
        raise AssertionError('Validation must not run the model')
    monkeypatch.setattr(app.simulation, 'simulate', forbidden)
    counts = session.execute(text('SELECT (SELECT count(*) FROM water_bodies), '
                                  '(SELECT count(*) FROM observation_points), (SELECT count(*) FROM saved_scenarios)')).one()
    sent = document(reach_id, finite, last=True)
    response = await client.post('/api/v1/scenario-files/validate', json=sent)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['compatibility'] == {'compatible': True, 'reasons': []}
    assert result['document'] == sent | {'name': sent['name'].strip()}
    assert session.execute(text('SELECT (SELECT count(*) FROM water_bodies), '
                                '(SELECT count(*) FROM observation_points), (SELECT count(*) FROM saved_scenarios)')).one() == counts


@pytest.mark.anyio
async def test_completed_calculation_declares_supported_model_and_format(client):
    response = await client.post('/api/v1/simulations', json=PARAMS | {'length_m': 500.})
    assert response.status_code == 200
    result = response.json()
    assert result['model_id'] == 'conservative-1d-advection-dispersion-v1'
    assert result['format_version'] == 1


@pytest.mark.anyio
@pytest.mark.parametrize(('change', 'reason'), [
    ({'format_version': 2}, 'формата'),
    ({'model_id': 'future-model-v2'}, 'модели'),
    ({'geometry_version': 'river-wgs84-v2'}, 'Версия'),
    ({'geometry_sha256': '0' * 64}, 'Геометрия участка'),
    ({'downstream_geometry_sha256': '0' * 64}, 'продолжения'),
])
async def test_incompatible_file_preserves_original_and_explains_reason(client, change, reason):
    sent = document('voronezh-zheltye-peski') | change
    response = await client.post('/api/v1/scenario-files/validate', json=sent)
    assert response.status_code == 200
    result = response.json()
    assert not result['compatibility']['compatible']
    assert any(reason in item for item in result['compatibility']['reasons'])
    assert result['document'] == sent | {'name': sent['name'].strip()}


@pytest.mark.anyio
async def test_unknown_reach_does_not_use_another_geometry(client):
    sent = document('don-olkhovets')
    sent['reach_id'] = sent['conditions']['reach_id'] = 'removed-reach'
    response = await client.post('/api/v1/scenario-files/validate', json=sent)
    result = response.json()
    assert response.status_code == 200
    assert not result['compatibility']['compatible']
    assert 'Неизвестный' in result['compatibility']['reasons'][0]
    assert result['document']['reach_id'] == result['document']['conditions']['reach_id'] == 'removed-reach'


@pytest.mark.anyio
@pytest.mark.parametrize('field', list(document()))
async def test_incomplete_documents_are_rejected(client, field):
    sent = document()
    sent.pop(field)
    response = await client.post('/api/v1/scenario-files/validate', json=sent)
    assert response.status_code == 422


@pytest.mark.anyio
@pytest.mark.parametrize('field', list(document()['conditions']))
async def test_condition_file_requires_explicit_load_geometry_and_physical_fields(client, field):
    sent = document()
    sent['conditions'].pop(field)
    response = await client.post('/api/v1/scenario-files/validate', json=sent)
    assert response.status_code == 422


@pytest.mark.anyio
@pytest.mark.parametrize('change', [
    {'name': '  '}, {'name': 'x' * 121}, {'name': 'Имя\x00'}, {'name': 'Имя\x85'},
    {'format_version': True}, {'model_id': ''}, {'geometry_mode': 'lake'},
    {'geometry_sha256': 'broken'}, {'downstream_geometry_sha256': 'broken'},
    {'concentrations_mg_l': [[10.]]}, {'results': {}}, {'a': {}, 'b': {}},
    {'geometry_source': {'source_url': 'x' * 2049}}, {'geometry_source': {'nested': {'secret': 'x'}}},
])
async def test_invalid_top_level_values_are_rejected(client, change):
    response = await client.post('/api/v1/scenario-files/validate', json=document() | change)
    assert response.status_code == 422, response.text


@pytest.mark.anyio
@pytest.mark.parametrize('change', [
    {'river_flow_m3_s': '10'}, {'effluent_flow_m3_s': True}, {'effluent_mg_l': -1},
    {'velocity_m_s': 0}, {'duration_hours': .09}, {'length_m': 99},
    {'source_distance_m': 1}, {'reach_id': 'don-olkhovets'},
    {'load_mode': 'finite', 'load_duration_hours': .2}, {'load_duration_hours': .01},
])
async def test_library_physical_validation_is_shared_by_files(client, change):
    sent = document()
    sent['conditions'].update(change)
    response = await client.post('/api/v1/scenario-files/validate', json=sent)
    assert response.status_code == 422, response.text


@pytest.mark.anyio
async def test_geometry_mismatch_and_buffer_limits_share_library_policy(client):
    for sent, reason in [
        (document('don-olkhovets') | {'geometry_mode': 'synthetic'}, 'не согласованы'),
        (document('don-olkhovets') | {'reach_id': 'other-reach'}, 'не согласованы'),
        (document('don-olkhovets', last=True), '100 м'),
        (document('voronezh-zheltye-peski'), 'буфер'),
    ]:
        if reason == '100 м':
            sent['conditions']['source_distance_m'] += .01
        if reason == 'буфер':
            sent['conditions'].update(velocity_m_s=.02, dispersion_m2_s=100.)
        response = await client.post('/api/v1/scenario-files/validate', json=sent)
        assert response.status_code == 200, response.text
        assert not response.json()['compatibility']['compatible']
        assert any(reason in item for item in response.json()['compatibility']['reasons'])


@pytest.mark.anyio
@pytest.mark.parametrize('body', [b'{broken', b'[]', b'null', b'\xff', b'{"name":"a","name":"b"}',
                                  b'{"conditions":{"velocity_m_s":NaN}}'])
async def test_malformed_json_is_rejected(client, body):
    response = await client.post('/api/v1/scenario-files/validate', content=body,
                                 headers={'content-type': 'application/json'})
    assert response.status_code == 422


@pytest.mark.anyio
@pytest.mark.parametrize('content_type', ['text/plain', 'multipart/form-data', None])
async def test_file_validation_accepts_json_only(client, content_type):
    headers = {'content-type': content_type} if content_type else {}
    response = await client.post('/api/v1/scenario-files/validate', content=json.dumps(document()), headers=headers)
    assert response.status_code == 415


@pytest.mark.anyio
async def test_utf8_byte_limit_is_enforced_before_json_parsing_including_chunks(client):
    async def body():
        yield b' ' * 8192
        yield b'{}'
    response = await client.post('/api/v1/scenario-files/validate', content=body(),
                                 headers={'content-type': 'application/json'})
    assert response.status_code == 413 and '8192' in response.json()['detail']
    encoded = json.dumps(document(), ensure_ascii=False).encode('utf-8')
    exact = encoded + b' ' * (8192 - len(encoded))
    response = await client.post('/api/v1/scenario-files/validate', content=exact,
                                 headers={'content-type': 'application/json; charset=UTF-8'})
    assert response.status_code == 200
    response = await client.post('/api/v1/scenario-files/validate', content=exact + b' ',
                                 headers={'content-type': 'application/json'})
    assert response.status_code == 413


@pytest.mark.anyio
async def test_validation_is_independent_of_database_and_does_not_open_supplied_urls(client, monkeypatch):
    import urllib.request
    from app.db import get_session
    from app.main import app
    def forbidden(*args, **kwargs):
        raise AssertionError('File validation must not access DB or URLs')
    original = app.dependency_overrides[get_session]
    app.dependency_overrides[get_session] = forbidden
    monkeypatch.setattr(urllib.request, 'urlopen', forbidden)
    sent = document() | {'name': '<img src="https://untrusted.invalid/x" onerror="alert(1)">',
                         'geometry_source': {'source_url': 'https://untrusted.invalid/x'}}
    try:
        response = await client.post('/api/v1/scenario-files/validate', json=sent)
        assert response.status_code == 200
        assert response.json()['document']['name'] == sent['name']
    finally:
        app.dependency_overrides[get_session] = original


@pytest.mark.anyio
async def test_unpaired_unicode_surrogates_are_rejected(client):
    sent = document() | {'name': '\ud800'}
    response = await client.post('/api/v1/scenario-files/validate', content=json.dumps(sent),
                                 headers={'content-type': 'application/json'})
    assert response.status_code == 422
