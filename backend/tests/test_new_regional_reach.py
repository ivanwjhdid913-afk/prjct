"""Pinned, separately bounded Voronezh reach and its portable scenario path."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import xml.etree.ElementTree as ET

import pytest
from sqlalchemy import text

ROOT = Path(__file__).resolve().parents[1]
REACH_ID = 'voronezh-below-kuzminka'


def preparation():
    spec = importlib.util.spec_from_file_location('prepare_newreach', ROOT / 'scripts/prepare_newreach.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_new_reach_reproduces_pinned_source_vertices_and_bytes(tmp_path):
    module = preparation()
    result = module.prepare(destination=tmp_path)
    assert result['length_m'] == pytest.approx(1274.034968, abs=1e-6)
    assert result['verified_downstream_m'] == pytest.approx(789.954637, abs=1e-6)
    for suffix in ('reach', 'downstream'):
        filename = f'{REACH_ID}_{suffix}.geojson'
        assert (tmp_path / filename).read_bytes() == (ROOT / 'data/reaches' / filename).read_bytes()
    raw = ET.parse(module.RAW).getroot()
    nodes = {n.attrib['id']: [float(n.attrib['lon']), float(n.attrib['lat'])] for n in raw.findall('node')}
    ids = [n.attrib['ref'] for n in raw.find('way').findall('nd')]
    main = json.loads((tmp_path / f'{REACH_ID}_reach.geojson').read_text(encoding='utf-8'))
    tail = json.loads((tmp_path / f'{REACH_ID}_downstream.geojson').read_text(encoding='utf-8'))
    assert main['geometry']['coordinates'] == [nodes[i] for i in ids[392:404]]
    assert tail['geometry']['coordinates'] == [nodes[i] for i in ids[403:414]]
    assert main['geometry']['coordinates'][-1] == tail['geometry']['coordinates'][0]
    assert main['properties']['crs'] == 'EPSG:4326'
    assert main['properties']['coordinate_order'] == 'longitude, latitude'
    assert main['properties']['direction_source_url'] == 'https://lipkray.ru/dobroe/priroda'
    assert result['context_checks']['other_shared_waterway_nodes'] == []
    assert result['context_checks']['crossing_obstacle_ways'] == []


def test_new_reach_refuses_changed_raw_before_writing(tmp_path, monkeypatch):
    module = preparation()
    changed = tmp_path / 'changed.osm'
    changed.write_bytes(module.RAW.read_bytes() + b' ')
    monkeypatch.setattr(module, 'RAW', changed)
    with pytest.raises(ValueError, match='snapshot'):
        module.prepare(destination=tmp_path / 'outputs')
    assert not (tmp_path / 'outputs').exists()


def test_preexisting_pilot_bytes_remain_unchanged():
    for name, checksum in {
        'river_reach.geojson': '8f230700fbfe82a3a3bb5cd7d79e30ef581f7834d6d827e0c7c7d1e8cf4e84ca',
        'river_downstream.geojson': '5dd4502ecc4b9e83b67360b1ad65b6072780122ea516ea551f0f4c3156f275c4',
        'reaches/voronezh-zheltye-peski_reach.geojson': 'cd51715dd46a5e6a577bd9a6e567b4d34cd4ded7d7e940ede2de42b26b3a56df',
        'reaches/voronezh-zheltye-peski_downstream.geojson': '6ce4635fb5efa59c33dd6d558a1732d4f546be9bdc36065f8d6b995a8ea48760',
    }.items():
        assert hashlib.sha256((ROOT / 'data' / name).read_bytes()).hexdigest() == checksum


@pytest.mark.anyio
async def test_new_reach_is_registered_measured_and_supports_two_sources(client, session):
    from test_multiple_simulations import request
    from test_multiple_transport import source
    catalog = (await client.get('/api/v1/river-reaches')).json()['items']
    reach = next(item for item in catalog if item['id'] == REACH_ID)
    assert len(reach['metadata']['geometry_sha256']) == 64
    measured = session.scalar(text('SELECT ST_Length(ST_GeomFromGeoJSON(:geo)::geography)'),
                              {'geo': json.dumps(reach['geometry'])})
    assert measured == pytest.approx(1274.034968, abs=.001)
    sent = request(source(x=0.), source('b', 600., .05, 60.), reach_id=REACH_ID, duration_hours=.1)
    response = await client.post('/api/v1/simulations', json=sent)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['reach_id'] == REACH_ID
    assert result['geometry'] == reach['geometry']
    assert result['diagnostics']['buffer_m'] <= reach['metadata']['verified_downstream_m']
    assert abs(result['diagnostics']['mass_error_kg']) < 1e-8
    assert [s['id'] for s in result['source_coordinates']] == ['a', 'b']
    assert result['source_coordinates'][0]['coordinate'] == reach['geometry']['coordinates'][0]
    assert len(result['segment_geometries']) == 100
    assert all(a['coordinates'][-1] == b['coordinates'][0]
               for a, b in zip(result['segment_geometries'], result['segment_geometries'][1:]))


@pytest.mark.anyio
async def test_new_reach_control_points_library_and_json_roundtrip(client):
    from app.river import prepared_reach
    from test_analysis_storage import document, payload
    sent = copy.deepcopy(document())
    reach, _ = prepared_reach(REACH_ID)
    sent.update(name='Новый региональный участок', reach_id=REACH_ID, reach_name=reach['name'],
                geometry_sha256=reach['metadata']['geometry_sha256'],
                downstream_geometry_sha256=reach['metadata']['downstream_geometry_sha256'])
    sent['conditions'].update(reach_id=REACH_ID, duration_hours=.1)
    sent['conditions']['sources'][1]['source_distance_m'] = 600.
    for source in sent['conditions']['sources']:
        source.update(load_mode='continuous', effluent_mg_l=100., load_duration_hours=None, load_intervals=None)
    checked = await client.post('/api/v1/scenario-files/validate', json=sent)
    assert checked.status_code == 200, checked.text
    assert checked.json()['document'] == sent
    assert checked.json()['compatibility']['compatible']
    saved = await client.post('/api/v1/scenarios', json=payload(sent))
    assert saved.status_code == 201, saved.text
    loaded = (await client.get('/api/v1/scenarios/' + saved.json()['id'])).json()
    assert loaded['conditions'] == sent['conditions']
    assert loaded['analysis_settings'] == sent['analysis_settings']
    assert loaded['compatibility']['compatible']


@pytest.mark.anyio
async def test_new_reach_does_not_accept_buffer_past_verified_tail(client):
    from test_multiple_simulations import request
    from test_multiple_transport import source
    response = await client.post('/api/v1/simulations', json=request(
        source(), reach_id=REACH_ID, dispersion_m2_s=5., velocity_m_s=.1))
    assert response.status_code == 422 and 'буфер' in response.json()['detail']
