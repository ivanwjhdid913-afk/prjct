"""Geometry invariants independent of API and database."""
import importlib.util

import pytest


def river_module():
    assert importlib.util.find_spec('app.river') is not None, 'Missing measured river geometry module'
    from app import river
    return river


def test_bends_and_shared_boundaries_survive_segmentation():
    river = river_module()
    coordinates = [[39.1, 53.0], [39.102, 53.001], [39.103, 53.0], [39.105, 52.999]]
    route = river.MeasuredLine(coordinates)
    segments = route.segments(0, route.length_m, 2)
    assert len(segments) == 2
    assert segments[0]['coordinates'][-1] == segments[1]['coordinates'][0]
    all_points = [p for segment in segments for p in segment['coordinates']]
    assert all(point in all_points for point in coordinates)
    assert sum(river.MeasuredLine(s['coordinates']).length_m for s in segments) == pytest.approx(route.length_m, abs=1e-5)
    assert route.point_at(0) == coordinates[0]
    assert route.point_at(route.length_m) == coordinates[-1]


def test_cut_keeps_downstream_vertices_and_exact_length():
    river = river_module()
    route = river.MeasuredLine([[39, 53], [39.01, 53.002], [39.02, 53], [39.03, 52.998]])
    start = route.length_m / 2
    cut = route.slice(start, route.length_m)
    assert river.MeasuredLine(cut).length_m == pytest.approx(route.length_m - start, abs=1e-5)
    assert cut[-1] == route.coordinates[-1]
    assert route.coordinates[-2] in cut


@pytest.mark.parametrize('coordinates', [[], [[39,53]], [[39,53],[39,53]], [[39,53],[190,53]], [[39,53],[39,float('nan')]], [[39,53],[39,54]]])
def test_rejects_empty_degenerate_invalid_or_disconnected_line(coordinates):
    river = river_module()
    with pytest.raises(ValueError):
        river.MeasuredLine(coordinates)


def test_distances_outside_line_are_not_clamped():
    river = river_module()
    route = river.MeasuredLine([[39,53],[39.01,53]])
    for distance in (-1, route.length_m + 1, float('nan')):
        with pytest.raises(ValueError):
            route.point_at(distance)
