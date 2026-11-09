"""Prepare the saved regional cartographic selection, entirely offline.

OSM river ways remain separate LineStrings; no routing, snapping, or inferred
hydraulic joins are performed. Polygon members are stitched only at identical
endpoints of an explicitly identified OSM multipolygon relation.
"""
from __future__ import annotations

from collections import defaultdict
import hashlib
import json
import math
from pathlib import Path

from geographiclib.geodesic import Geodesic

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data' / 'regional'
RAW = DATA / 'raw' / 'overview-osm.json'
MANIFEST = DATA / 'manifest.json'


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def coordinates(element):
    points = [[p['lon'], p['lat']] for p in element['geometry']]
    for point in points:
        if not all(isinstance(x, (int, float)) and math.isfinite(x) for x in point):
            raise ValueError('Non-finite coordinate')
        if not (36 < point[0] < 42 and 50 < point[1] < 55):
            raise ValueError(f'Unexpected regional WGS84 longitude/latitude: {point}')
    if len(points) < 2 or any(a == b for a, b in zip(points, points[1:])):
        raise ValueError('Degenerate geometry')
    return points


def signed_area(ring):
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:])) / 2


def validate_ring(ring):
    """Reject degenerate and self-intersecting rings using indexed segments.

    GeoJSON edges are straight segments in longitude/latitude (RFC 7946).
    The spatial bins only prune comparisons; they do not change geometry.
    """
    if ring[0] != ring[-1] or len(ring) < 4 or abs(signed_area(ring)) < 1e-12:
        raise ValueError('Degenerate or unclosed polygon ring')
    if len({tuple(p) for p in ring[:-1]}) != len(ring) - 1:
        raise ValueError('Self-touching polygon ring')
    grid = defaultdict(list)
    segments = list(zip(ring, ring[1:]))

    def side(a, b, p):
        return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])

    def on_segment(a, b, p):
        return abs(side(a, b, p)) < 1e-14 and all(min(a[k], b[k]) <= p[k] <= max(a[k], b[k]) for k in (0, 1))

    def intersects(a, b, c, d):
        return ((side(a, b, c) * side(a, b, d) < 0 and side(c, d, a) * side(c, d, b) < 0)
                or on_segment(a, b, c) or on_segment(a, b, d)
                or on_segment(c, d, a) or on_segment(c, d, b))

    for i, (a, b) in enumerate(segments):
        cells = [(x, y) for x in range(math.floor(min(a[0], b[0]) * 40), math.floor(max(a[0], b[0]) * 40) + 1)
                 for y in range(math.floor(min(a[1], b[1]) * 40), math.floor(max(a[1], b[1]) * 40) + 1)]
        candidates = {j for cell in cells for j in grid[cell]}
        for j in candidates:
            if i - j == 1 or (j == 0 and i == len(segments) - 1):
                continue
            if intersects(a, b, *segments[j]):
                raise ValueError(f'Self-intersecting polygon segments {i}, {j}')
        for cell in cells:
            grid[cell].append(i)


def rings_from_members(members, role):
    """Assemble declared polygon members, never near endpoints or river ways."""
    parts = [coordinates(m) for m in members if m['type'] == 'way' and m.get('role') == role]
    rings = []
    while parts:
        ring = parts.pop(0)
        while ring[-1] != ring[0]:
            matches = [(i, p[0] == ring[-1]) for i, p in enumerate(parts)
                       if p[0] == ring[-1] or p[-1] == ring[-1]]
            if len(matches) != 1:
                raise ValueError(f'Open or ambiguous multipolygon {role} endpoint {ring[-1]}')
            i, forward = matches[0]
            part = parts.pop(i)
            ring.extend((part if forward else part[::-1])[1:])
        validate_ring(ring)
        # RFC 7946 exterior counterclockwise, interior clockwise.
        if (signed_area(ring) > 0) != (role == 'outer'):
            ring.reverse()
        rings.append(ring)
    return rings


def point_in_ring(point, ring):
    x, y = point
    inside = False
    for a, b in zip(ring, ring[1:]):
        if (a[1] > y) != (b[1] > y) and x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
            inside = not inside
    return inside


def polygon_geometry(element):
    if element['type'] == 'way':
        ring = coordinates(element)
        validate_ring(ring)
        if signed_area(ring) < 0:
            ring.reverse()
        return {'type': 'Polygon', 'coordinates': [ring]}
    outers = rings_from_members(element['members'], 'outer')
    polygons = [[ring] for ring in outers]
    for hole in rings_from_members(element['members'], 'inner'):
        owners = [p for p in polygons if point_in_ring(hole[0], p[0])]
        if len(owners) != 1:
            raise ValueError('Unassigned or ambiguous polygon hole')
        owners[0].append(hole)
    if not polygons:
        raise ValueError('No exterior polygon ring')
    return {'type': 'Polygon', 'coordinates': polygons[0]} if len(polygons) == 1 else {
        'type': 'MultiPolygon', 'coordinates': polygons}


def lines(geometry):
    if geometry['type'] == 'LineString':
        return [geometry['coordinates']]
    if geometry['type'] in ('MultiLineString', 'Polygon'):
        return geometry['coordinates']
    return [ring for polygon in geometry['coordinates'] for ring in polygon]


def element_ref(element):
    return {k: element[k] for k in ('type', 'id', 'version')}


def outside_context(features):
    """Measure retained source-vertex context without clipping or inferring joins."""
    boundary = features[0]['geometry']
    assert boundary['type'] == 'Polygon' and len(boundary['coordinates']) == 1
    ring = boundary['coordinates'][0]
    bands = defaultdict(list)
    for a, b in zip(ring, ring[1:]):
        for band in range(math.floor(min(a[1], b[1]) * 100), math.floor(max(a[1], b[1]) * 100) + 1):
            bands[band].append((a, b))

    def covered(point):
        x, y = point
        inside = False
        for a, b in bands[math.floor(y * 100)]:
            cross = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])
            if abs(cross) < 1e-14 and min(a[0], b[0]) <= x <= max(a[0], b[0]) and min(a[1], b[1]) <= y <= max(a[1], b[1]):
                return True
            if (a[1] > y) != (b[1] > y) and x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
                inside = not inside
        return inside

    counts = {}
    for feature in features:
        if feature['properties']['kind'] != 'river':
            continue
        counts[feature['properties']['id']] = [sum(not covered(p) for p in part)
                                               for part in feature['geometry']['coordinates']]
    return {'method': 'Original river vertices tested against the saved region polygon (boundary included); not a clipped-length estimate.',
            'outside_vertex_count': sum(sum(values) for values in counts.values()),
            'ways_with_outside_vertices': sum(sum(value > 0 for value in values) for values in counts.values()),
            'per_river': {name: {'outside_vertex_count': sum(values),
                                 'ways_with_outside_vertices': sum(value > 0 for value in values)}
                          for name, values in counts.items()},
            'boundary_bbox': [min(p[0] for p in ring), min(p[1] for p in ring),
                              max(p[0] for p in ring), max(p[1] for p in ring)]}


def prepare(destination=DATA / 'overview.geojson'):
    manifest = json.loads(MANIFEST.read_text(encoding='utf8'))
    if sha256(RAW) != manifest['raw_sha256']:
        raise ValueError('Pinned raw snapshot checksum mismatch')
    if sha256(DATA / 'raw' / 'overview.overpassql') != manifest['query_sha256']:
        raise ValueError('Pinned query checksum mismatch')
    raw = json.loads(RAW.read_text(encoding='utf8'))
    if raw.get('remark'):
        raise ValueError('Overpass reported an incomplete response')
    elements = {(e['type'], e['id']): e for e in raw['elements']}
    boundary = elements[('relation', 72169)]
    if boundary['tags']['name'] != 'Липецкая область' or boundary['tags']['ISO3166-2'] != 'RU-LIP':
        raise ValueError('Unexpected administrative boundary identity')
    features = []

    def feature(identifier, name, kind, geometry, source_elements, prepared=()):
        limitation = ('Обзорная картографическая граница OSM; не юридическое описание границ.' if kind == 'boundary' else
                      'Текущий одномерный речной решатель не подключён к озёрам и водохранилищам.' if kind in ('lake', 'reservoir') else
                      'Обзорная линия не является проверенной расчётной сетью. Расчёт доступен только на отдельно подготовленных участках; связи, подпор и гидравлика остальной реки не проверены.')
        features.append({'type': 'Feature', 'properties': {
            'id': identifier, 'name': name, 'kind': kind, 'source_id': 'osm-regional-20261102',
            'source_elements': source_elements, 'prepared_reach_ids': list(prepared),
            'limitation': limitation}, 'geometry': geometry})

    feature('lipetsk-oblast', boundary['tags']['name'], 'boundary', polygon_geometry(boundary), [element_ref(boundary)])
    grouped = defaultdict(list)
    for element in elements.values():
        if element.get('tags', {}).get('waterway') == 'river':
            grouped[element['tags']['name']].append(element)
    for entry in manifest['rivers']:
        ways = sorted(grouped[entry['name']], key=lambda e: e['id'])
        if not ways:
            raise ValueError(f'Missing named river {entry["name"]}')
        parts = [coordinates(way) for way in ways]
        feature(entry['id'], entry['name'], 'river', {
            'type': 'MultiLineString', 'coordinates': parts},
            [element_ref(way) for way in ways], entry.get('prepared_reach_ids', []))
    for entry in manifest['waterbodies']:
        element = elements[(entry['type'], entry['osm_id'])]
        if element['tags']['name'] != entry['name'] or element['tags']['water'] != entry['kind']:
            raise ValueError('Unexpected selected waterbody identity')
        feature(entry['id'], entry['name'], entry['kind'], polygon_geometry(element), [element_ref(element)])
    all_points = [p for f in features for line in lines(f['geometry']) for p in line]
    lengths = {f['properties']['id']: round(sum(
        Geodesic.WGS84.Inverse(a[1], a[0], b[1], b[0])['s12']
        for line in lines(f['geometry']) for a, b in zip(line, line[1:])), 3)
        for f in features if f['properties']['kind'] == 'river'}
    # The identity transformation retains every source vertex. Its measured
    # source/output vertex displacement and continuous Hausdorff distance are 0.
    result = {'type': 'FeatureCollection', 'metadata': {
        'format_version': 1, 'name': 'Поверхностные воды Липецкой области',
        'obtained_on': manifest['obtained_on'], 'crs': 'EPSG:4326',
        'coordinate_order': 'longitude, latitude', 'coverage_note': manifest['coverage_note'],
        'sources': [{'id': 'osm-regional-20261102', 'name': 'OpenStreetMap / Overpass regional selection',
                     'url': manifest['download_url'], 'license': 'ODbL-1.0',
                     'license_url': 'https://opendatacommons.org/licenses/odbl/1-0/',
                     'attribution': '© OpenStreetMap contributors', 'obtained_on': manifest['obtained_on'],
                     'raw_sha256': manifest['raw_sha256'], 'raw_path': 'regional/raw/overview-osm.json'}],
        'preparation': {'script': 'backend/scripts/prepare_regional.py',
                        'raw_sha256': manifest['raw_sha256'], 'query_sha256': manifest['query_sha256'],
                        'osm_base_timestamp': raw['osm3s']['timestamp_osm_base'],
                        'simplification': {'method': 'none; every source vertex retained',
                                           'max_vertex_displacement_m': 0.0,
                                           'hausdorff_error_m': 0.0,
                                           'error_basis': 'identity geometry; polygon member ordering/orientation only'},
                        'river_way_policy': 'Each source way remains an independent MultiLineString member; no proximity joins, clipping or routing.',
                        'validation': 'Finite regional longitude/latitude; no zero edges; closed nonzero simple rings (spatially indexed segment intersection); unique hole containment; pinned IDs/tags/checksums.',
                        'outside_boundary_context': outside_context(features),
                        'coordinate_count': len(all_points), 'river_lengths_m': lengths}},
        'bbox': [min(p[0] for p in all_points), min(p[1] for p in all_points),
                 max(p[0] for p in all_points), max(p[1] for p in all_points)], 'features': features}
    encoded = (json.dumps(result, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n').encode('utf8')
    Path(destination).write_bytes(encoded)
    checksum = hashlib.sha256(encoded).hexdigest()
    Path(destination).with_suffix('.sha256').write_text(
        f'{checksum}  {Path(destination).name}\n', encoding='ascii', newline='\n')
    return {'feature_count': len(features), 'coordinate_count': len(all_points), 'bytes': len(encoded),
            'sha256': checksum, 'bbox': result['bbox']}


if __name__ == '__main__':
    print(json.dumps(prepare()))
