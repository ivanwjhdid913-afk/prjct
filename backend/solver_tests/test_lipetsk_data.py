"""Pinned Lipetsk geometry, independent of API/database and live map services."""
import importlib.util
import json
from pathlib import Path
import xml.etree.ElementTree as ET

import pytest
from geographiclib.geodesic import Geodesic

ROOT = Path(__file__).resolve().parents[1]
REACH_ID = 'voronezh-zheltye-peski'


def preparation():
    spec = importlib.util.spec_from_file_location('prepare_lipetsk', ROOT / 'scripts' / 'prepare_lipetsk.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_pilot_reproduces_offline_and_keeps_original_vertices(tmp_path):
    module = preparation()
    module.DATA = tmp_path
    module.prepare()
    documents = []
    for suffix in ('reach', 'downstream'):
        filename = f'{REACH_ID}_{suffix}.geojson'
        actual = (tmp_path / 'reaches' / filename).read_bytes()
        assert b'\r' not in actual
        assert actual == (ROOT / 'data' / 'reaches' / filename).read_bytes()
        documents.append(json.loads(actual))
    reach, tail = documents
    assert reach['geometry']['coordinates'][-1] == tail['geometry']['coordinates'][0]
    assert 320 < reach['properties']['length_m'] < 330
    assert 470 < tail['properties']['length_m'] < 490
    assert reach['properties']['verified_downstream_m'] == tail['properties']['length_m']
    points = reach['geometry']['coordinates'] + tail['geometry']['coordinates'][1:]
    assert len(set(map(tuple, points))) == len(points)
    def turn(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    for i, (a, b) in enumerate(zip(points, points[1:])):
        length = Geodesic.WGS84.Inverse(a[1], a[0], b[1], b[0])['s12']
        assert 0 < length <= 250.000001
        for c, d in list(zip(points, points[1:]))[i + 2:]:
            assert not (turn(a, b, c) * turn(a, b, d) < 0 and turn(c, d, a) * turn(c, d, b) < 0)
    assert reach['properties']['osm_node_ids'] == [2145717824, 977751241, 977751376]
    raw = ET.parse(module.RAW).getroot()
    nodes = {int(n.attrib['id']): [float(n.attrib['lon']), float(n.attrib['lat'])] for n in raw.findall('node')}
    assert reach['geometry']['coordinates'] == [nodes[n] for n in reach['properties']['osm_node_ids']]
    tail_points = tail['geometry']['coordinates']
    assert tail_points[:-1] == [nodes[n] for n in tail['properties']['osm_node_ids']]
    assert Geodesic.WGS84.Inverse(*reversed(tail_points[-2]), *reversed(tail_points[-1]))['s12'] == pytest.approx(250, abs=1e-6)
    # Context has no mapped tributary/branch incident on any selected node.
    context = ET.parse(module.CONTEXT).getroot()
    selected = set(reach['properties']['osm_node_ids'] + tail['properties']['osm_node_ids'])
    for way in context.findall('way'):
        tags = {t.attrib['k']: t.attrib['v'] for t in way.findall('tag')}
        if 'waterway' in tags and way.attrib['id'] != '26274036':
            assert not selected.intersection(int(n.attrib['ref']) for n in way.findall('nd'))


def test_pilot_rejects_changed_raw_snapshot(tmp_path):
    module = preparation()
    changed = tmp_path / 'changed.osm'
    changed.write_bytes(module.RAW.read_bytes() + b'\n')
    module.RAW = changed
    module.DATA = tmp_path
    with pytest.raises(ValueError, match='snapshot'):
        module.prepare()
    assert not (tmp_path / 'reaches').exists()
