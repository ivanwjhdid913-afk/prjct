"""Rebuild the short Voronezh pilot from pinned OSM data, entirely offline.

No invented route, smoothing or snapping: the only derived vertex is a buffer
boundary 250 m along an existing WGS84 source edge, before an oxbow connection.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET

from geographiclib.geodesic import Geodesic

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data'
RAW = DATA / 'raw' / 'voronezh-way-26274036.osm'
CONTEXT = DATA / 'raw' / 'voronezh-zheltye-peski-context.osm'
SHA256 = '71c7a7900c25ca48c58c5e7578d169191ab2aceceb70146255a2cfa905f3955c'
CONTEXT_SHA256 = '8102ddc9844537090ea78678637414f79db0397bd410a4105e5557381966cb15'
REACH_ID = 'voronezh-zheltye-peski'
START_NODE, END_NODE, LAST_FULL_NODE = '2145717824', '977751376', '2104712829'
EDGE_END_NODE = '393120802'
TAIL_EDGE_DISTANCE_M = 250.0


def line_length(coordinates):
    return sum(Geodesic.WGS84.Inverse(a[1], a[0], b[1], b[0])['s12']
               for a, b in zip(coordinates, coordinates[1:]))


def prepare():
    for path, checksum in ((RAW, SHA256), (CONTEXT, CONTEXT_SHA256)):
        if hashlib.sha256(path.read_bytes()).hexdigest() != checksum:
            raise ValueError('Pinned OSM snapshot changed; review geometry before updating checksums.')
    osm = ET.fromstring(RAW.read_bytes())
    way = osm.find('way')
    assert way is not None and way.attrib['id'] == '26274036' and way.attrib['version'] == '57'
    tags = {t.attrib['k']: t.attrib['v'] for t in way.findall('tag')}
    assert tags['name'] == 'Воронеж' and tags['waterway'] == 'river'
    nodes = {n.attrib['id']: [float(n.attrib['lon']), float(n.attrib['lat'])] for n in osm.findall('node')}
    ids = [n.attrib['ref'] for n in way.findall('nd')]
    start, end, last, edge_end = map(ids.index, (START_NODE, END_NODE, LAST_FULL_NODE, EDGE_END_NODE))
    assert start < end < last and edge_end == last + 1
    main_ids, tail_ids = ids[start:end + 1], ids[end:last + 1]
    main, tail = [nodes[n] for n in main_ids], [nodes[n] for n in tail_ids]
    a, b = nodes[LAST_FULL_NODE], nodes[EDGE_END_NODE]
    edge = Geodesic.WGS84.Inverse(a[1], a[0], b[1], b[0])
    assert TAIL_EDGE_DISTANCE_M < edge['s12']
    boundary = Geodesic.WGS84.Direct(a[1], a[0], edge['azi1'], TAIL_EDGE_DISTANCE_M)
    tail.append([boundary['lon2'], boundary['lat2']])
    main_length, tail_length = round(line_length(main), 6), round(line_length(tail), 6)
    assert 320 < main_length < 330 and 470 < tail_length < 490
    common = {
        'source': 'OpenStreetMap',
        'source_url': 'https://www.openstreetmap.org/way/26274036/history/57',
        'attribution': '© OpenStreetMap contributors',
        'license': 'ODbL-1.0',
        'license_url': 'https://www.openstreetmap.org/copyright',
        'crs': 'EPSG:4326', 'coordinate_order': 'longitude, latitude',
        'snapshot_date': '2026-10-24',
        'osm_way_id': 26274036, 'osm_way_version': 57,
        'osm_way_timestamp': '2026-07-05T11:48:06Z', 'osm_changeset_id': 185135849,
        'raw_sha256': SHA256, 'context_sha256': CONTEXT_SHA256,
        'context_source_url': 'https://api.openstreetmap.org/api/0.6/map?bbox=39.67,52.67,39.81,52.81',
        'direction_basis': 'Направление на юг независимо описано Липецкой областной научной библиотекой. Сохранённая сеть подтверждает: устья Кузьминки и Босолука находятся выше пилота; непрерывная цепочка Воронежа продолжается к югу в сторону Липецка и устья Матыры. Порядок узлов согласован с этими основаниями, но сам по себе не принят за доказательство. Локальное течение в межень и во время паводка не измерялось.',
        'direction_source_url': 'https://lipkray.ru/dobroe/priroda',
        'direction_source_urls': ['https://lipkray.ru/dobroe/priroda', 'https://natural-sciences.ru/article/view?id=36435'],
        'length_method': 'Сумма геодезических расстояний WGS84 GeographicLib; без сглаживания и упрощения.',
        'verification_date': '2026-10-24',
        'verification_basis': 'Исходная линия, основной участок и отдельное продолжение сопоставлены с Esri World Imagery; выбран короткий западный изгиб между видимыми связями со старицами. Дата съёмки мозаики не установлена. Нет полевых наблюдений или гидравлической валидации.',
        'verification_source_url': 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
    }
    suitability = ('Короткий картографический пилот у Жёлтых Песков на северной окраине Липецка. '
        'Основной участок и буфер ограничены до видимого нижнего соединения со старицей и начинаются ниже верхнего. '
        'По сохранённому контексту и снимку на них не обнаружены плотины, пересекающие мосты, притоки и разветвления. '
        'Городское Липецкое озеро с подпорным порогом исключено; до него более 8 км по прямой. '
        'Пригодность относится к демонстрации одномерного переноса при принятых постоянных параметрах, '
        'в пределах русла в межень; затопленная пойма, паводковые связи стариц и влияние подпора не рассчитаны. '
        'Отсутствие подпора во всех режимах не доказано; требуется обследование для инженерного применения.')
    reach = {'type': 'Feature', 'properties': {**common,
        'id': REACH_ID, 'name': 'Воронеж у Жёлтых Песков',
        'location': 'Северная окраина Липецка, западный изгиб у Жёлтых Песков',
        'provenance': 'real_geometry', 'length_m': main_length,
        'verified_downstream_m': tail_length, 'osm_node_ids': [int(n) for n in main_ids],
        'suitability': suitability}, 'geometry': {'type': 'LineString', 'coordinates': main}}
    continuation = {'type': 'Feature', 'properties': {**common,
        'id': REACH_ID + '-downstream-check', 'name': 'Проверенное продолжение у Жёлтых Песков',
        'length_m': tail_length, 'osm_node_ids': [int(n) for n in tail_ids],
        'boundary_interpolation': {'from_osm_node_id': int(LAST_FULL_NODE), 'toward_osm_node_id': int(EDGE_END_NODE),
            'distance_m': TAIL_EDGE_DISTANCE_M, 'source_edge_length_m': round(edge['s12'], 6),
            'fraction': TAIL_EDGE_DISTANCE_M / edge['s12'], 'method': 'WGS84 geodesic Direct'},
        'suitability': suitability,
        'purpose': 'Граница вычислительного буфера до соединения со старицей; не дополнительный расчётный участок.'},
        'geometry': {'type': 'LineString', 'coordinates': tail}}
    destination = DATA / 'reaches'
    destination.mkdir(parents=True, exist_ok=True)
    for suffix, value in (('reach', reach), ('downstream', continuation)):
        (destination / f'{REACH_ID}_{suffix}.geojson').write_text(
            json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    return {'id': REACH_ID, 'length_m': main_length, 'verified_downstream_m': tail_length,
            'buffer_endpoint': tail[-1]}


if __name__ == '__main__':
    print(json.dumps(prepare()))
