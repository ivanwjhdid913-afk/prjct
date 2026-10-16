import json

import pytest
from sqlalchemy import text

from app import simulation
from test_simulations import PARAMS


@pytest.mark.anyio
async def test_prepared_route_has_measured_downstream_geometry(client, session):
    response = await client.get('/api/v1/river-reaches')
    assert response.status_code == 200
    reach = response.json()['items'][0]
    assert 100 <= reach['length_m'] <= 20000
    assert reach['metadata']['direction_basis']
    assert reach['metadata']['attribution']
    assert len(reach['metadata']['geometry_sha256']) == 64
    distances = reach['distances_m']
    assert distances[0] == 0 and distances[-1] == reach['length_m']
    assert all(a < b for a, b in zip(distances, distances[1:]))
    measured = session.scalar(text('SELECT ST_Length(ST_GeomFromGeoJSON(:geo)::geography)'), {'geo': json.dumps(reach['geometry'])})
    assert measured == pytest.approx(reach['length_m'], abs=.001)


@pytest.mark.anyio
@pytest.mark.parametrize('position', ['start', 'middle', 'end'])
async def test_source_positions_preserve_bends_lengths_and_mass(client, session, position):
    reach = (await client.get('/api/v1/river-reaches')).json()['items'][0]
    source = {'start': 0, 'middle': reach['length_m']/2, 'end': reach['length_m']-100}[position]
    params = {k: v for k, v in PARAMS.items() if k != 'length_m'}
    # A 100 m reach with D=5 has a fine diffusive time step: use an explicitly
    # short scenario, rather than changing user parameters inside the API.
    params.update(reach_id=reach['id'], source_distance_m=source, duration_hours=.1 if position == 'end' else 2)
    response = await client.post('/api/v1/simulations', json=params)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['provenance'] == 'river_scenario'
    assert result['reach_id'] == reach['id']
    assert result['source_distance_m'] == source
    assert result['inputs']['length_m'] == pytest.approx(reach['length_m']-source)
    assert result['source_coordinate'] == result['geometry']['coordinates'][0]
    assert result['geometry']['coordinates'][-1] == reach['geometry']['coordinates'][-1]
    assert result['diagnostics']['relative_mass_error'] < 1e-9
    assert result['diagnostics']['relative_excess_mass_error'] < 1e-9
    segments = result['segment_geometries']
    assert len(segments) == len(result['distances_m']) == 100
    assert all(a['coordinates'][-1] == b['coordinates'][0] for a, b in zip(segments, segments[1:]))
    flattened = [p for segment in segments for p in segment['coordinates']]
    assert all(point in flattened for point in result['geometry']['coordinates'])
    for segment in segments:
        length = session.scalar(text('SELECT ST_Length(ST_GeomFromGeoJSON(:geo)::geography)'), {'geo': json.dumps(segment)})
        assert length == pytest.approx(result['inputs']['length_m']/100, abs=.001)
    assert len(response.content) < 300000


@pytest.mark.anyio
async def test_expensive_short_reach_is_rejected_without_changing_parameters(client):
    reach = (await client.get('/api/v1/river-reaches')).json()['items'][0]
    params = {k: v for k, v in PARAMS.items() if k != 'length_m'}
    params.update(reach_id=reach['id'], source_distance_m=reach['length_m']-100, duration_hours=2)
    response = await client.post('/api/v1/simulations', json=params)
    assert response.status_code == 422
    assert 'размер вычислений' in response.json()['detail']
    assert 'длина определяется руслом' in response.json()['detail']


@pytest.mark.anyio
@pytest.mark.parametrize('change', [dict(reach_id='missing'), dict(source_distance_m=-1), dict(source_distance_m='20'), dict(source_distance_m=True), dict(source_distance_m=20000), dict(length_m=1000), dict(source_distance_m=None)])
async def test_rejects_bad_river_parameters(client, change):
    reach = (await client.get('/api/v1/river-reaches')).json()['items'][0]
    params = {k: v for k, v in PARAMS.items() if k != 'length_m'}
    params.update(reach_id=reach['id'], source_distance_m=0)
    params.update(change)
    assert (await client.post('/api/v1/simulations', json=params)).status_code == 422


@pytest.mark.anyio
async def test_rejects_short_remainder_and_unverified_buffer_before_solver(client, monkeypatch):
    reach = (await client.get('/api/v1/river-reaches')).json()['items'][0]
    def forbidden(*args, **kwargs):
        raise AssertionError('Unsuitable reach must be rejected before solving')
    monkeypatch.setattr(simulation, 'simulate', forbidden)
    params = {k: v for k, v in PARAMS.items() if k != 'length_m'}
    params.update(reach_id=reach['id'], source_distance_m=reach['length_m']-99)
    response = await client.post('/api/v1/simulations', json=params)
    assert response.status_code == 422 and '100' in response.text
    params.update(source_distance_m=0, dispersion_m2_s=100, velocity_m_s=.02)
    response = await client.post('/api/v1/simulations', json=params)
    assert response.status_code == 422 and 'буфер' in response.text
