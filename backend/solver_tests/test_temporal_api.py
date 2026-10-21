"""Actual serialized output bounds without requiring the database service."""
import json

from fastapi import FastAPI
import httpx
import pytest

from app import simulation, transport
from test_temporal_resolution import SHORT


@pytest.fixture
def anyio_backend():
    return 'asyncio'


@pytest.fixture
async def api():
    app = FastAPI()
    app.include_router(simulation.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        yield client


@pytest.mark.anyio
async def test_actual_response_body_metadata_and_exact_size_boundary(api, monkeypatch):
    result = transport.simulate(SHORT)
    monkeypatch.setattr(simulation, 'simulate', lambda _: result)
    first = await api.post('/api/v1/simulations', json=SHORT)
    assert first.status_code == 200
    body = first.json()
    metadata = body['temporal_resolution']
    assert metadata['saved_states'] == len(body['times_hours']) == len(body['concentrations_mg_l'])
    assert metadata['max_response_bytes'] == 5 * 1024 * 1024
    assert len(first.content) < metadata['max_response_bytes']
    monkeypatch.setattr(simulation, 'MAX_RESPONSE_BYTES', len(first.content))
    equal = await api.post('/api/v1/simulations', json=SHORT)
    assert equal.status_code == 200 and equal.content == first.content
    monkeypatch.setattr(simulation, 'MAX_RESPONSE_BYTES', len(first.content) - 1)
    rejected = await api.post('/api/v1/simulations', json=SHORT)
    assert rejected.status_code == 422 and 'ответ превышает' in rejected.json()['detail']
    assert simulation.calculation_lock.acquire(blocking=False)
    simulation.calculation_lock.release()


def test_body_limit_counts_utf8_and_all_geometry_metadata(monkeypatch):
    result = simulation.SimulationResult(**transport.simulate(SHORT),
        geometry=simulation.synthetic_line(500), reach_metadata={'description': 'Река' * 100})
    expected = simulation.bounded_response(result).body
    assert len(expected) > len(expected.decode('utf-8'))
    monkeypatch.setattr(simulation, 'MAX_RESPONSE_BYTES', len(expected) - 1)
    with pytest.raises(ValueError, match='ответ превышает'):
        simulation.bounded_response(result)


@pytest.mark.parametrize('limit,value,message', [
    ('MAX_REFERENCE_BYTES', 1, 'траектория'),
    ('MAX_OUTPUT_STATES', 49, 'состояний'),
    ('MAX_COMPRESSION_CHECKS', 1, 'проверки интерполяции'),
])
@pytest.mark.anyio
async def test_resource_failures_are_actionable_422(api, monkeypatch, limit, value, message):
    monkeypatch.setattr(transport, limit, value)
    response = await api.post('/api/v1/simulations', json=SHORT)
    assert response.status_code == 422
    assert message in response.json()['detail']
    assert 'не снижена автоматически' in response.json()['detail']


@pytest.mark.parametrize('value', ['NaN', 'Infinity', '-Infinity', '-1', '0', '2'])
@pytest.mark.anyio
async def test_invalid_finite_time_is_rejected(api, value):
    params = SHORT.copy()
    params.pop('load_duration_hours')
    raw = json.dumps(params)[:-1] + ', "load_duration_hours": ' + value + '}'
    response = await api.post('/api/v1/simulations', content=raw, headers={'Content-Type': 'application/json'})
    assert response.status_code == 422
