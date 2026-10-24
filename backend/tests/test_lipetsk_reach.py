"""The additional saved pilot, real API and independent PostGIS distances."""
import json

import pytest
from sqlalchemy import text


PILOT = 'voronezh-zheltye-peski'
PARAMS = dict(river_flow_m3_s=10., effluent_flow_m3_s=.1, background_mg_l=10.,
              effluent_mg_l=100., velocity_m_s=.25, dispersion_m2_s=5., duration_hours=.1)


@pytest.mark.anyio
async def test_lipetsk_pilot_is_named_identified_and_measured_on_its_own_geometry(client, session):
    catalog = (await client.get('/api/v1/river-reaches')).json()['items']
    assert {item['id'] for item in catalog} == {'don-olkhovets', PILOT}
    reach = next(item for item in catalog if item['id'] == PILOT)
    assert 'Воронеж' in reach['name']
    assert reach['metadata']['id'] == PILOT
    assert reach['metadata']['license'] == 'ODbL-1.0'
    assert reach['metadata']['direction_basis']
    assert reach['metadata']['verified_downstream_m'] >= 400
    measured = session.scalar(text('SELECT ST_Length(ST_GeomFromGeoJSON(:geo)::geography)'),
                              {'geo': json.dumps(reach['geometry'])})
    assert measured == pytest.approx(reach['length_m'], abs=.001)


@pytest.mark.anyio
@pytest.mark.parametrize('position', ['start', 'middle', 'last_100m'])
@pytest.mark.parametrize('load_mode', ['continuous', 'finite'])
async def test_lipetsk_source_positions_keep_mass_geometry_and_fractional_horizon(client, session, position, load_mode):
    catalog = (await client.get('/api/v1/river-reaches')).json()['items']
    reach = next(item for item in catalog if item['id'] == PILOT)
    start = {'start': 0, 'middle': reach['length_m'] / 2, 'last_100m': reach['length_m'] - 100}[position]
    params = PARAMS | dict(reach_id=PILOT, source_distance_m=start, load_mode=load_mode)
    if load_mode == 'finite':
        params['load_duration_hours'] = .001
    response = await client.post('/api/v1/simulations', json=params)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['reach_id'] == result['reach_metadata']['id'] == PILOT
    assert result['reach_metadata']['name'] == reach['name']
    assert result['source_distance_m'] == start
    assert result['source_coordinate'] == result['geometry']['coordinates'][0]
    assert result['geometry']['coordinates'][-1] == reach['geometry']['coordinates'][-1]
    assert result['inputs']['length_m'] == pytest.approx(reach['length_m'] - start, abs=1e-8)
    assert result['times_hours'][-1] == .1
    if load_mode == 'finite':
        assert .001 in result['times_hours']
    assert result['diagnostics']['relative_excess_mass_error'] < 1e-9
    assert result['diagnostics']['buffer_m'] <= reach['metadata']['verified_downstream_m']
    geometries = result['segment_geometries']
    assert len(geometries) == 100
    assert all(a['coordinates'][-1] == b['coordinates'][0] for a, b in zip(geometries, geometries[1:]))
    for segment in geometries:
        length = session.scalar(text('SELECT ST_Length(ST_GeomFromGeoJSON(:geo)::geography)'),
                                {'geo': json.dumps(segment)})
        assert length == pytest.approx(result['inputs']['length_m'] / 100, abs=.001)


@pytest.mark.anyio
async def test_lipetsk_buffer_and_source_limits_are_not_silently_adjusted(client):
    catalog = (await client.get('/api/v1/river-reaches')).json()['items']
    reach = next(item for item in catalog if item['id'] == PILOT)
    too_short = await client.post('/api/v1/simulations', json=PARAMS | dict(reach_id=PILOT, source_distance_m=reach['length_m'] - 99))
    assert too_short.status_code == 422 and '100 м' in too_short.json()['detail']
    excessive_buffer = await client.post('/api/v1/simulations', json=PARAMS | dict(reach_id=PILOT, velocity_m_s=.02, dispersion_m2_s=100.))
    assert excessive_buffer.status_code == 422 and 'буфер' in excessive_buffer.json()['detail']
