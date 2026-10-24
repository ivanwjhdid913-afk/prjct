"""Selected river identity, offline registry validation and ellipsoidal snapping."""
from copy import deepcopy
import json
import math
from pathlib import Path
import shutil

from fastapi import FastAPI
from geographiclib.geodesic import Geodesic
import httpx
import pytest

from app import river, simulation


PARAMS = dict(river_flow_m3_s=10., effluent_flow_m3_s=.1, background_mg_l=10.,
              effluent_mg_l=100., velocity_m_s=.25, dispersion_m2_s=5., duration_hours=.1)


def north(point, distance, bearing=180):
    result = Geodesic.WGS84.Direct(point[1], point[0], bearing, distance)
    return [result['lon2'], result['lat2']]


def write_pair(directory, reach_id='fixture-lipetsk', origin=None, length=600, tail=500):
    origin = origin or [39.6, 52.6]
    count = max(3, math.ceil(length / 900))
    coordinates = [north(origin, length * i / count) for i in range(count + 1)]
    end = coordinates[-1]
    downstream = [end, north(end, tail)]
    actual = river.MeasuredLine(coordinates).length_m
    tail_actual = river.MeasuredLine(downstream).length_m
    metadata = dict(id=reach_id, name='Fixture river', length_m=actual,
                    verified_downstream_m=tail_actual, provenance='real_geometry',
                    direction_basis='Fixture downstream direction', attribution='Fixture source')
    feature = dict(type='Feature', properties=metadata,
                   geometry=dict(type='LineString', coordinates=coordinates))
    directory.mkdir(exist_ok=True)
    path = directory / f'{reach_id}_reach.geojson'
    path.write_text(json.dumps(feature), encoding='utf-8')
    feature['properties'] = dict(id=f'{reach_id}-downstream', length_m=tail_actual)
    feature['geometry']['coordinates'] = downstream
    (directory / f'{reach_id}_downstream.geojson').write_text(json.dumps(feature), encoding='utf-8')
    return path


def clear_registry():
    river.prepared_reach.cache_clear() if hasattr(river.prepared_reach, 'cache_clear') else None
    if hasattr(river, '_prepared_registry'):
        river._prepared_registry.cache_clear()


@pytest.fixture
def catalog(tmp_path, monkeypatch):
    data = Path(river.__file__).resolve().parents[1] / 'data'
    for name in ('river_reach.geojson', 'river_downstream.geojson'):
        shutil.copyfile(data / name, tmp_path / name)
    path = write_pair(tmp_path / 'reaches')
    monkeypatch.setattr(river, 'DATA_DIR', tmp_path, raising=False)
    clear_registry()
    yield tmp_path, path
    clear_registry()


@pytest.fixture
def anyio_backend():
    return 'asyncio'


@pytest.fixture
async def api(catalog):
    app = FastAPI()
    app.include_router(simulation.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        yield client


def test_registry_keeps_default_and_selected_identities_and_copies(catalog):
    default, line = river.prepared_reach()
    assert default['id'] == 'don-olkhovets'
    assert default['length_m'] == pytest.approx(3126.042754, abs=1e-6)
    items = river.prepared_reaches()
    assert [item['id'] for item in items] == ['don-olkhovets', 'fixture-lipetsk']
    selected, selected_line = river.prepared_reach('fixture-lipetsk')
    assert selected['geometry'] != default['geometry']
    assert selected_line.length_m == pytest.approx(600, abs=1e-6)
    assert selected['metadata']['provenance'] == 'real_geometry'
    assert len(selected['metadata']['geometry_sha256']) == 64
    selected['metadata']['name'] = 'mutated'
    selected['geometry']['coordinates'][0][0] = 0
    assert river.prepared_reach('fixture-lipetsk')[0]['metadata']['name'] == 'Fixture river'
    assert river.prepared_reach('fixture-lipetsk')[0]['geometry']['coordinates'][0][0] != 0
    with pytest.raises(ValueError, match='Неизвестный'):
        river.prepared_reach('missing')


@pytest.mark.parametrize('defect', ['tail_gap', 'main_length', 'tail_length', 'buffer_length', 'short', 'long', 'duplicate', 'missing_tail'])
def test_registry_rejects_invalid_pairs(catalog, defect):
    directory, main = catalog
    path = main
    if defect == 'duplicate':
        shutil.copyfile(main, main.parent / 'duplicate_reach.geojson')
        shutil.copyfile(main.parent / 'fixture-lipetsk_downstream.geojson', main.parent / 'duplicate_downstream.geojson')
    elif defect == 'missing_tail':
        (main.parent / 'fixture-lipetsk_downstream.geojson').unlink()
    elif defect in ('short', 'long'):
        write_pair(main.parent, length=99 if defect == 'short' else 20001)
    else:
        if defect in ('tail_gap', 'tail_length'):
            path = main.parent / 'fixture-lipetsk_downstream.geojson'
        document = json.loads(path.read_text())
        if defect == 'tail_gap':
            document['geometry']['coordinates'][0][0] += .001
        else:
            key = 'verified_downstream_m' if defect == 'buffer_length' else 'length_m'
            document['properties'][key] += 5
        path.write_text(json.dumps(document))
    clear_registry()
    with pytest.raises(ValueError):
        river.prepared_reaches()


@pytest.mark.parametrize('fraction', [0, .2, .5, 1])
def test_projection_uses_geodesic_chainage_and_endpoints(fraction):
    origin = [39.6, 52.6]
    coordinates = [origin, north(origin, 300), north(north(origin, 300), 250, 110)]
    line = river.MeasuredLine(coordinates)
    start = line.length_m * fraction
    expected = line.point_at(start)
    projected = line.project(expected)
    assert projected['source_distance_m'] == pytest.approx(start, abs=1e-4)
    assert projected['coordinate'] == pytest.approx(expected, abs=1e-9)
    assert projected['distance_to_river_m'] == pytest.approx(0, abs=1e-4)
    assert coordinates == [origin, north(origin, 300), north(north(origin, 300), 250, 110)]


def test_projection_perpendicular_distance_is_ellipsoidal():
    origin = [39.6, 52.6]
    line = river.MeasuredLine([origin, north(origin, 600)])
    middle = line.point_at(300)
    click = north(middle, 35, 90)
    projected = line.project(click)
    assert projected['source_distance_m'] == pytest.approx(300, abs=.001)
    assert projected['distance_to_river_m'] == pytest.approx(35, abs=.001)


@pytest.mark.parametrize('point', [[float('nan'), 52], [39, float('inf')], [181, 52], [39, 91], [True, 52], [39]])
def test_projection_validates_coordinates(point):
    line = river.MeasuredLine([[39.6, 52.6], north([39.6, 52.6], 600)])
    with pytest.raises(ValueError, match='WGS84'):
        line.project(point)


def test_projection_at_high_latitude_across_longitude_wrap():
    origin = [179.999, 80]
    end = north(origin, 800, 90)
    line = river.MeasuredLine([origin, end])
    assert end[0] < 0
    point = line.point_at(325)
    projected = line.project(north(point, 30, 0))
    assert projected['source_distance_m'] == pytest.approx(325, abs=.05)
    assert projected['distance_to_river_m'] == pytest.approx(30, abs=.001)


@pytest.mark.anyio
async def test_selected_api_calculation_preserves_request_result_mass_and_segments(api):
    items = (await api.get('/api/v1/river-reaches')).json()['items']
    assert [item['id'] for item in items] == ['don-olkhovets', 'fixture-lipetsk']
    params = PARAMS | dict(reach_id='fixture-lipetsk', source_distance_m=250.)
    original = deepcopy(params)
    response = await api.post('/api/v1/simulations', json=params)
    assert response.status_code == 200, response.text
    result = response.json()
    saved = deepcopy(result)
    assert result['reach_id'] == result['reach_metadata']['id'] == 'fixture-lipetsk'
    assert result['inputs']['length_m'] == pytest.approx(350, abs=1e-6)
    assert result['geometry']['coordinates'][-1] == items[1]['geometry']['coordinates'][-1]
    assert result['source_coordinate'] == result['geometry']['coordinates'][0]
    assert result['diagnostics']['relative_mass_error'] < 1e-9
    assert result['diagnostics']['relative_excess_mass_error'] < 1e-9
    segments = result['segment_geometries']
    assert len(segments) == 100
    assert all(a['coordinates'][-1] == b['coordinates'][0] for a, b in zip(segments, segments[1:]))
    assert all(river.MeasuredLine(segment['coordinates']).length_m == pytest.approx(3.5, abs=1e-5) for segment in segments)
    assert params == original
    assert (await api.post('/api/v1/simulations', json=PARAMS | dict(reach_id='don-olkhovets'))).status_code == 200
    assert result == saved


@pytest.mark.anyio
@pytest.mark.parametrize('distance', [0., 300., 500.])
async def test_source_snap_accepted_start_middle_exact_last_allowed(api, distance):
    reach, line = river.prepared_reach('fixture-lipetsk')
    distance = line.length_m - 100 if distance == 500 else distance
    point = line.point_at(distance)
    click = north(point, 25, 90)
    response = await api.get('/api/v1/river-reaches/fixture-lipetsk/source-snap', params=dict(longitude=click[0], latitude=click[1]))
    assert response.status_code == 200, response.text
    snapped = response.json()
    assert snapped['reach_id'] == reach['id']
    assert snapped['max_distance_m'] == 75
    assert snapped['source_distance_m'] == pytest.approx(distance, abs=.001)
    assert snapped['coordinate'] == pytest.approx(point, abs=1e-8)
    assert snapped['distance_to_river_m'] == pytest.approx(25, abs=.001)


@pytest.mark.anyio
async def test_source_snap_exact_75_metre_boundary(api):
    _, line = river.prepared_reach('fixture-lipetsk')
    point = line.point_at(300)
    click = north(point, 75, 90)
    response = await api.get('/api/v1/river-reaches/fixture-lipetsk/source-snap', params=dict(longitude=click[0], latitude=click[1]))
    assert response.status_code == 200, response.text
    assert response.json()['distance_to_river_m'] == pytest.approx(75, abs=1e-6)


@pytest.mark.anyio
@pytest.mark.parametrize('side', [-1, 1])
@pytest.mark.parametrize('offset', [25, 75])
async def test_don_exact_last_allowed_chainage_with_perpendicular_click(api, side, offset):
    _, line = river.prepared_reach()
    maximum = line.length_m - 100
    point = line.point_at(maximum)
    endpoint = line.point_at(line.length_m)
    bearing = Geodesic.WGS84.Inverse(point[1], point[0], endpoint[1], endpoint[0])['azi1']
    click = north(point, offset, bearing + side * 90)
    response = await api.get('/api/v1/river-reaches/don-olkhovets/source-snap', params=dict(longitude=click[0], latitude=click[1]))
    assert response.status_code == 200, response.text
    assert response.json()['source_distance_m'] == pytest.approx(maximum, abs=1e-6)


@pytest.mark.anyio
@pytest.mark.parametrize('kind', ['far', 'beyond_75', 'end', 'last_99', 'last_99_99', 'other_reach', 'unknown'])
async def test_source_snap_rejects_without_fallback_or_clamp(api, kind):
    _, line = river.prepared_reach('fixture-lipetsk')
    point = line.point_at(300)
    reach_id = 'fixture-lipetsk'
    if kind in ('far', 'beyond_75'):
        point = north(point, 76 if kind == 'far' else 75.01, 90)
    elif kind in ('end', 'last_99', 'last_99_99'):
        point = line.point_at(line.length_m - {'end': 0, 'last_99': 99, 'last_99_99': 99.99}[kind])
    elif kind == 'other_reach':
        point = river.prepared_reach()[1].point_at(100)
    else:
        reach_id = 'missing'
    response = await api.get(f'/api/v1/river-reaches/{reach_id}/source-snap', params=dict(longitude=point[0], latitude=point[1]))
    assert response.status_code == 422, response.text
    if kind in ('end', 'last_99', 'last_99_99'):
        assert '100' in response.text


@pytest.mark.anyio
@pytest.mark.parametrize('values', [dict(longitude='NaN', latitude=52), dict(longitude=39, latitude='inf'),
                                  dict(longitude=181, latitude=52), dict(longitude=39, latitude=91),
                                  dict(longitude='true', latitude=52), dict(latitude=52)])
async def test_source_snap_rejects_invalid_query(api, values):
    response = await api.get('/api/v1/river-reaches/fixture-lipetsk/source-snap', params=values)
    assert response.status_code == 422


@pytest.mark.anyio
async def test_selected_tail_buffer_and_remainder_are_checked_before_solver(api, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError('Invalid input reached solver')
    monkeypatch.setattr(simulation, 'simulate', forbidden)
    for change, explanation in [(dict(source_distance_m=501), '100'),
                                (dict(velocity_m_s=.02, dispersion_m2_s=100), 'буфер'),
                                (dict(reach_id='missing'), 'Неизвестный')]:
        response = await api.post('/api/v1/simulations', json=PARAMS | dict(reach_id='fixture-lipetsk') | change)
        assert response.status_code == 422 and explanation in response.text


@pytest.mark.anyio
async def test_buffer_guard_uses_selected_tail_not_default_don(api):
    # 800 m of advective buffer fits Don's 1370 m tail, exceeds this 500 m tail.
    params = PARAMS | dict(dispersion_m2_s=10.)
    rejected = await api.post('/api/v1/simulations', json=params | dict(reach_id='fixture-lipetsk'))
    assert rejected.status_code == 422 and 'буфер' in rejected.text
    accepted = await api.post('/api/v1/simulations', json=params | dict(reach_id='don-olkhovets'))
    assert accepted.status_code == 200, accepted.text


@pytest.mark.anyio
async def test_snap_on_exact_hundred_metre_reach_can_only_use_start(api, catalog):
    directory, _ = catalog
    write_pair(directory / 'reaches', reach_id='minimum', length=100.)
    clear_registry()
    _, line = river.prepared_reach('minimum')
    assert line.length_m == pytest.approx(100, abs=1e-6)
    start = line.point_at(0)
    accepted = await api.get('/api/v1/river-reaches/minimum/source-snap', params=dict(longitude=start[0], latitude=start[1]))
    assert accepted.status_code == 200, accepted.text
    after_start = line.point_at(.01)
    rejected = await api.get('/api/v1/river-reaches/minimum/source-snap', params=dict(longitude=after_start[0], latitude=after_start[1]))
    assert rejected.status_code == 422 and '100' in rejected.text
