"""Prepare a separately bounded Voronezh reach from pinned OSM, offline.

The main line and its verified tail are contiguous slices of ONE OSM way.
No snapping, joining, simplification, interpolation or inferred connections.
Satellite inspection is documented in docs/reaches/voronezh-below-kuzminka.md;
these checks establish saved cartographic topology, not observed hydraulics.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import xml.etree.ElementTree as ET

from geographiclib.geodesic import Geodesic

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data'
RAW = DATA / 'raw/voronezh-kuzminka-way-35164443.osm'
CONTEXT = DATA / 'raw/voronezh-kuzminka-context.osm'
SHA256 = '2a5202cd385768e98f58557aa210c71cbe7086ffe8f441b6db8a1a3a6c628fac'
CONTEXT_SHA256 = '556b9c8048137c736a4902f9c670dfa8dc3da20445e3ee202b27c1e44fc9ebbf'
REACH_ID = 'voronezh-below-kuzminka'
START_NODE, END_NODE, TAIL_END_NODE = '412452043', '412452084', '3699021520'


def line_length(coordinates):
    return sum(Geodesic.WGS84.Inverse(a[1], a[0], b[1], b[0])['s12']
               for a, b in zip(coordinates, coordinates[1:]))


def _intersects(a, b, c, d):
    """Topological test in this small lon/lat box; no metric claims in degrees."""
    def orient(p, q, r):
        value = (q[0]-p[0])*(r[1]-p[1]) - (q[1]-p[1])*(r[0]-p[0])
        return 0 if abs(value) < 1e-14 else (1 if value > 0 else -1)
    def on(p, q, r):
        return (min(p[0], r[0])-1e-12 <= q[0] <= max(p[0], r[0])+1e-12
                and min(p[1], r[1])-1e-12 <= q[1] <= max(p[1], r[1])+1e-12)
    x, y, z, w = orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b)
    return ((x*y < 0 and z*w < 0) or (x == 0 and on(a, c, b))
            or (y == 0 and on(a, d, b)) or (z == 0 and on(c, a, d))
            or (w == 0 and on(c, b, d)))


def _context_checks(context, ids, coordinates):
    nodes = {n.attrib['id']: [float(n.attrib['lon']), float(n.attrib['lat'])]
             for n in context.findall('node')}
    if any(nodes.get(node_id) != coordinate for node_id, coordinate in zip(ids, coordinates)):
        raise ValueError('Context and source node coordinates differ.')
    shared, crossings = [], []
    selected = set(ids)
    edges = list(zip(coordinates, coordinates[1:]))
    for way in context.findall('way'):
        tags = {t.attrib['k']: t.attrib['v'] for t in way.findall('tag')}
        if way.attrib['id'] == '35164443':
            continue
        refs = [n.attrib['ref'] for n in way.findall('nd')]
        waterway = tags.get('waterway') in {'river', 'stream', 'canal', 'drain', 'ditch', 'tidal_channel'}
        obstacle = (tags.get('bridge') not in (None, 'no')
                    or tags.get('waterway') in {'dam', 'weir'}
                    or tags.get('man_made') in {'dam', 'weir'})
        if waterway and selected.intersection(refs):
            shared.append({'way_id': int(way.attrib['id']), 'nodes': sorted(selected.intersection(refs))})
        if waterway or obstacle:
            points = [nodes[i] for i in refs]
            if any(_intersects(a, b, c, d) for a, b in edges for c, d in zip(points, points[1:])):
                crossings.append(int(way.attrib['id']))
    for node in context.findall('node'):
        tags = {t.attrib['k']: t.attrib['v'] for t in node.findall('tag')}
        if node.attrib['id'] in selected and tags.get('waterway') in {'dam', 'weir'}:
            raise ValueError('Mapped node obstacle inside candidate.')
    if shared or crossings:
        raise ValueError(f'Candidate crosses mapped waterway/obstacle: {shared}, {crossings}')
    return {'other_shared_waterway_nodes': shared, 'crossing_obstacle_ways': crossings,
            'context_bbox': [39.72, 52.728, 39.76, 52.77],
            'self_intersections': 0, 'unique_vertices': len(coordinates),
            'max_edge_m': round(max(line_length([a, b]) for a, b in edges), 6)}


def prepare(destination=None):
    for path, checksum in ((RAW, SHA256), (CONTEXT, CONTEXT_SHA256)):
        if hashlib.sha256(path.read_bytes()).hexdigest() != checksum:
            raise ValueError('Pinned OSM snapshot changed; review before updating checksums.')
    osm = ET.fromstring(RAW.read_bytes())
    way = osm.find('way')
    if way is None or way.attrib['id'] != '35164443' or way.attrib['version'] != '29':
        raise ValueError('Wrong source way/version.')
    tags = {t.attrib['k']: t.attrib['v'] for t in way.findall('tag')}
    if tags.get('name') != 'Воронеж' or tags.get('waterway') != 'river':
        raise ValueError('Wrong named waterway.')
    nodes = {n.attrib['id']: [float(n.attrib['lon']), float(n.attrib['lat'])] for n in osm.findall('node')}
    ids = [n.attrib['ref'] for n in way.findall('nd')]
    start, end, tail_end = map(ids.index, (START_NODE, END_NODE, TAIL_END_NODE))
    if (start, end, tail_end) != (392, 403, 413):
        raise ValueError('Source boundaries changed.')
    main_ids, tail_ids = ids[start:end+1], ids[end:tail_end+1]
    main, tail = [nodes[i] for i in main_ids], [nodes[i] for i in tail_ids]
    combined = main + tail[1:]
    if len(set(map(tuple, combined))) != len(combined):
        raise ValueError('Repeated vertex in candidate.')
    if any(not (math.isfinite(x) and math.isfinite(y) and 39.72 < x < 39.76 and 52.728 < y < 52.77)
           for x, y in combined):
        raise ValueError('Invalid WGS84 coordinate or coordinate order.')
    edges = list(zip(combined, combined[1:]))
    if any(_intersects(a, b, c, d) for i, (a, b) in enumerate(edges)
           for c, d in edges[i+2:]):
        raise ValueError('Self-intersecting candidate.')
    checks = _context_checks(ET.fromstring(CONTEXT.read_bytes()), ids[start:tail_end+1], combined)
    main_length, tail_length = round(line_length(main), 6), round(line_length(tail), 6)
    if not (1274 < main_length < 1275 and 789 < tail_length < 791 and checks['max_edge_m'] < 300):
        raise ValueError('Unexpected lengths or source gap.')
    suitability = (
        'Отдельный картографически проверенный участок Воронежа ниже Большой Кузьминки, '
        'между верхней видимой боковой связью и нижней системой стариц. Основная линия и '
        'проверенное продолжение не пересекают обнаруженные на снимках открытые притоки, '
        'разветвления, мосты, плотины или водохранилища. Пригоден для демонстрации '
        'одномерного переноса с постоянными сценарными параметрами в основном русле в межень. '
        'Полевые расходы, уровни и скорости не измерены; отсутствие сезонных связей и подпора '
        'во всех режимах не доказано. Для инженерного прогноза нужны обследование и валидация.')
    common = {
        'source': 'OpenStreetMap',
        'source_url': 'https://www.openstreetmap.org/way/35164443/history/29',
        'raw_source_url': 'https://api.openstreetmap.org/api/0.6/way/35164443/full',
        'attribution': '© OpenStreetMap contributors', 'license': 'ODbL-1.0',
        'license_url': 'https://www.openstreetmap.org/copyright',
        'crs': 'EPSG:4326', 'coordinate_order': 'longitude, latitude',
        'snapshot_date': '2026-11-02', 'osm_way_id': 35164443, 'osm_way_version': 29,
        'osm_way_timestamp': way.attrib['timestamp'], 'osm_changeset_id': int(way.attrib['changeset']),
        'raw_sha256': SHA256, 'context_sha256': CONTEXT_SHA256,
        'context_source_url': 'https://api.openstreetmap.org/api/0.6/map?bbox=39.72,52.728,39.76,52.77',
        'direction_basis': 'Независимое описание Липецкой областной научной библиотеки: Воронеж течёт с севера на юг. Сохранённая сеть согласуется с этим: устье Кузьминки (узел 2106156604) выше начала; ниже буфера way 35164443 идёт к устью Босолука в узле 412452091, далее через общий узел продолжается на юг way 122109734. Локальные северные повороты внутри меандров сохранены, порядок узлов сам по себе не считается доказательством направления. Измерений местного течения нет.',
        'direction_source_url': 'https://lipkray.ru/dobroe/priroda',
        'length_method': 'Сумма геодезических расстояний GeographicLib WGS84; точные исходные вершины без упрощения.',
        'verification_date': '2026-11-02',
        'verification_basis': 'Независимый визуальный просмотр Esri World Imagery: обзор [39.725,52.73,39.762,52.769] и крупный план [39.728,52.729,39.744,52.745]. Проверены отдельно основная линия и весь буфер; верхняя боковая связь и нижние старицы исключены. Дата съёмки мозаики не установлена. Картографическая проверка не заменяет гидравлические наблюдения.',
        'verification_source_url': 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
        'context_checks': checks, 'suitability': suitability,
    }
    reach = {'type': 'Feature', 'properties': {**common, 'id': REACH_ID,
        'name': 'Воронеж ниже Большой Кузьминки', 'location': 'Липецкая область, севернее Жёлтых Песков',
        'provenance': 'real_geometry', 'length_m': main_length, 'verified_downstream_m': tail_length,
        'osm_node_ids': list(map(int, main_ids))},
        'geometry': {'type': 'LineString', 'coordinates': main}}
    downstream = {'type': 'Feature', 'properties': {**common, 'id': REACH_ID+'-downstream-check',
        'name': 'Проверенное продолжение ниже Большой Кузьминки', 'length_m': tail_length,
        'osm_node_ids': list(map(int, tail_ids)),
        'purpose': 'Только проверенное продолжение для вычислительного буфера до следующей боковой связи.'},
        'geometry': {'type': 'LineString', 'coordinates': tail}}
    destination = Path(destination) if destination is not None else DATA / 'reaches'
    destination.mkdir(parents=True, exist_ok=True)
    for suffix, document in (('reach', reach), ('downstream', downstream)):
        (destination / f'{REACH_ID}_{suffix}.geojson').write_text(
            json.dumps(document, ensure_ascii=False, indent=2)+'\n', encoding='utf-8', newline='\n')
    return {'id': REACH_ID, 'length_m': main_length, 'verified_downstream_m': tail_length,
            'context_checks': checks}


if __name__ == '__main__':
    print(json.dumps(prepare(), ensure_ascii=False))
