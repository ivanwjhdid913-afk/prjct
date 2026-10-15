import json
import sys

import pytest
from sqlalchemy import func, select, text

from app.models import ObservationPoint, WaterBody
from app import simulation


PARAMS = dict(river_flow_m3_s=10, effluent_flow_m3_s=0.1, background_mg_l=10,
              effluent_mg_l=100, velocity_m_s=0.25, dispersion_m2_s=5,
              length_m=10000, duration_hours=24)


@pytest.mark.anyio
async def test_real_simulation_contract_geometry_and_database_preserved(client, session):
    before = [session.scalar(select(func.count()).select_from(model))
              for model in (WaterBody, ObservationPoint)]
    response = await client.post('/api/v1/simulations', json=PARAMS)
    assert response.status_code == 200
    assert len(response.content) < 250_000
    result = response.json()
    assert result['provenance'] == 'synthetic'
    assert result['inputs'] == PARAMS
    assert result['derived']['area_m2'] == pytest.approx(40.4)
    assert result['derived']['load_kg_s'] == pytest.approx(0.010)
    assert result['derived']['excess_load_kg_s'] == pytest.approx(0.009)
    assert result['derived']['steady_mg_l'] == pytest.approx(10.8910891089)
    assert result['derived']['travel_hours'] == pytest.approx(11.1111111111)
    assert len(result['distances_m']) == 100
    assert len(result['times_hours']) == 49
    assert result['times_hours'][0] == 0
    assert result['times_hours'][-1] == 24
    assert result['distances_m'][0] == 50
    assert result['distances_m'][-1] == 9950
    values = result['concentrations_mg_l']
    assert len(values) == 49 and all(len(row) == 100 for row in values)
    assert values[0] == pytest.approx([10] * 100)
    assert values[-1] == pytest.approx([10.8910891089] * 100, abs=0.002)
    assert result['scale_mg_l'] == pytest.approx([10, 10.8910891089])
    geometry = result['geometry']
    assert geometry['type'] == 'LineString'
    assert len(geometry['coordinates']) == 101
    # Independent ellipsoidal measurement by PostGIS, not the geometry constructor.
    measured = session.scalar(text('SELECT ST_Length(ST_GeomFromGeoJSON(:geo)::geography)'),
                              {'geo': json.dumps(geometry)})
    assert measured == pytest.approx(10000, abs=0.01)
    for index in (0, 49, 99):
        segment = {'type': 'LineString', 'coordinates': geometry['coordinates'][index:index + 2]}
        length = session.scalar(text('SELECT ST_Length(ST_GeomFromGeoJSON(:geo)::geography)'),
                                {'geo': json.dumps(segment)})
        assert length == pytest.approx(100, abs=0.001)
    after = [session.scalar(select(func.count()).select_from(model))
             for model in (WaterBody, ObservationPoint)]
    assert before == after


@pytest.mark.anyio
@pytest.mark.parametrize('field,value', [
    ('river_flow_m3_s', 0), ('river_flow_m3_s', 1001), ('effluent_flow_m3_s', -1),
    ('effluent_flow_m3_s', 101), ('background_mg_l', -1), ('effluent_mg_l', 10001),
    ('velocity_m_s', 0), ('velocity_m_s', 2.1), ('dispersion_m2_s', 0),
    ('dispersion_m2_s', 101), ('length_m', 99), ('length_m', 20001),
    ('duration_hours', 0), ('duration_hours', 49), ('velocity_m_s', 'NaN'),
    ('background_mg_l', True), ('length_m', '10000'), ('extra', 1),
    ('river_flow_m3_s', 10**1000),
])
async def test_invalid_parameters_are_rejected(client, field, value):
    response = await client.post('/api/v1/simulations', json={**PARAMS, field: value})
    assert response.status_code == 422


@pytest.mark.anyio
async def test_expensive_combination_is_rejected_before_calculation(client):
    response = await client.post('/api/v1/simulations', json={
        **PARAMS, 'velocity_m_s': 2, 'dispersion_m2_s': 0.1,
        'length_m': 20000, 'duration_hours': 48,
    })
    assert response.status_code == 422
    assert isinstance(response.json()['detail'], str)


@pytest.mark.anyio
@pytest.mark.parametrize('body,status', [('{' ,422), ('{"padding":"' + 'x' * 5000 + '"}', 413),
                                       ('NaN', 422), ('[' * 1500 + '0' + ']' * 1500, 422)],
                         ids=['invalid-json', 'large-body', 'nan', 'deeply-nested'])
async def test_malformed_or_oversized_request(client, body, status):
    previous_limit = sys.getrecursionlimit()
    try:
        # Pytest raises this limit; retain coverage of the normal server parser.
        sys.setrecursionlimit(1000)
        response = await client.post('/api/v1/simulations', content=body,
                                     headers={'Content-Type': 'application/json'})
        assert response.status_code == status
    finally:
        sys.setrecursionlimit(previous_limit)


@pytest.mark.anyio
async def test_missing_fields_are_rejected(client):
    assert (await client.post('/api/v1/simulations', json={})).status_code == 422


@pytest.mark.anyio
async def test_busy_solver_returns_retry_without_queueing(client):
    simulation.calculation_lock.acquire()
    try:
        response = await client.post('/api/v1/simulations', json=PARAMS)
        assert response.status_code == 503
        assert response.headers['Retry-After'] == '5'
    finally:
        simulation.calculation_lock.release()


@pytest.mark.anyio
async def test_cost_rejection_releases_calculation_slot(client):
    expensive = {**PARAMS, 'velocity_m_s': 2, 'dispersion_m2_s': 0.1}
    assert (await client.post('/api/v1/simulations', json=expensive)).status_code == 422
    assert simulation.calculation_lock.acquire(blocking=False)
    simulation.calculation_lock.release()


@pytest.mark.anyio
async def test_chunked_body_limit_does_not_depend_on_content_length(client):
    async def chunks():
        yield b'{"padding":"'
        for _ in range(6):
            yield b'x' * 1000
        yield b'"}'
    response = await client.post('/api/v1/simulations', content=chunks(),
                                 headers={'Content-Type': 'application/json'})
    assert response.status_code == 413


@pytest.mark.parametrize('length', [100, 20000])
def test_geometry_length_extremes_against_postgis(session, length):
    geometry = simulation.synthetic_line(length)
    measured = session.scalar(text('SELECT ST_Length(ST_GeomFromGeoJSON(:geo)::geography)'),
                              {'geo': json.dumps(geometry)})
    assert measured == pytest.approx(length, abs=0.01)
