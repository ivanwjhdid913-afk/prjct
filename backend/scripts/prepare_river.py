"""Rebuild the bounded pilot reach from the committed OSM snapshot, offline.

Run from any directory with the backend environment's Python. No snapping,
smoothing, reversing, simplification, or newly invented vertices is performed.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET

from geographiclib.geodesic import Geodesic

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
RAW = DATA / "raw" / "don-way-30428409.osm"
SHA256 = "0893629ecb985d959b1a46c54d08a420dfe6ecac6b5e8f8237ddafe45bcce67a"
START_NODE = "7903804464"
END_NODE = "335793095"
BUFFER_END_NODE = "7903859462"


def line_length(coordinates: list[list[float]]) -> float:
    return sum(
        Geodesic.WGS84.Inverse(a[1], a[0], b[1], b[0])["s12"]
        for a, b in zip(coordinates, coordinates[1:])
    )


def prepare() -> dict:
    raw = RAW.read_bytes()
    if hashlib.sha256(raw).hexdigest() != SHA256:
        raise ValueError("The pinned OSM snapshot has changed; review it before updating the checksum.")
    osm = ET.fromstring(raw)
    way = osm.find("way")
    assert way is not None and way.attrib["id"] == "30428409"
    assert way.attrib["version"] == "32"
    tags = {tag.attrib["k"]: tag.attrib["v"] for tag in way.findall("tag")}
    assert tags["waterway"] == "river" and tags["name"] == "Дон"
    nodes = {node.attrib["id"]: node for node in osm.findall("node")}
    ids = [node.attrib["ref"] for node in way.findall("nd")]
    first, last, tail = map(ids.index, (START_NODE, END_NODE, BUFFER_END_NODE))
    assert first < last < tail

    def coordinates(selected: list[str]) -> list[list[float]]:
        return [[float(nodes[n].attrib["lon"]), float(nodes[n].attrib["lat"])] for n in selected]

    main_ids = ids[first:last + 1]
    tail_ids = ids[last:tail + 1]
    main, continuation = coordinates(main_ids), coordinates(tail_ids)
    assert len(set(main_ids + tail_ids[1:])) == len(main_ids + tail_ids) - 1
    assert all(a != b for a, b in zip(main + continuation[1:], main[1:] + continuation[1:]))
    reach_length, buffer_length = line_length(main), line_length(continuation)
    assert 3000 < reach_length < 3200 and 1300 < buffer_length < 1400

    common = {
        "source": "OpenStreetMap",
        "source_url": "https://www.openstreetmap.org/way/30428409/history/32",
        "attribution": "© OpenStreetMap contributors",
        "license": "ODbL-1.0",
        "license_url": "https://www.openstreetmap.org/copyright",
        "crs": "EPSG:4326",
        "coordinate_order": "longitude, latitude",
        "snapshot_date": "2026-10-15",
        "osm_way_id": 30428409,
        "osm_way_version": 32,
        "osm_way_timestamp": "2025-11-13T10:48:47Z",
        "raw_sha256": SHA256,
        "direction_basis": "Порядок узлов OSM waterway=river соответствует направлению вниз по течению; порядок исходного way 30428409 сохранён.",
        "direction_source_url": "https://wiki.openstreetmap.org/wiki/Tag:waterway%3Driver",
        "length_method": "Сумма обратных геодезических задач GeographicLib на эллипсоиде WGS84 между исходными вершинами.",
        "verification_date": "2026-10-15",
        "verification_basis": "Положение и непрерывность сопоставлены с Esri World Imagery; полевые измерения направления, гидравлики и качества воды отсутствуют.",
        "verification_source_url": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer",
    }
    feature = {
        "type": "Feature",
        "properties": {
            **common,
            "id": "don-olkhovets",
            "name": "Дон ниже Ольховца",
            "location": "Липецкая область, Лебедянский район, ниже моста у Ольховца и выше Нового Ракитина",
            "provenance": "real_geometry",
            "length_m": reach_length,
            "verified_downstream_m": buffer_length,
            "osm_node_ids": [int(n) for n in main_ids],
            "suitability": "Один непрерывный участок ниже моста у Ольховца; маршрут и проверенное продолжение заканчиваются до впадения безымянного ручья у OSM node 1418032921. По снимку и сохранённому OSM-контексту на них не обнаружены плотины, водохранилища и слияния. Это картографическая проверка, не гидравлическое обследование.",
        },
        "geometry": {"type": "LineString", "coordinates": main},
    }
    buffer_feature = {
        "type": "Feature",
        "properties": {
            **common,
            "id": "don-olkhovets-downstream-check",
            "name": "Проверенное продолжение ниже расчётного участка",
            "length_m": buffer_length,
            "osm_node_ids": [int(n) for n in tail_ids],
            "purpose": "Ограничение длины вычислительного буфера; не дополнительный отображаемый расчётный участок.",
        },
        "geometry": {"type": "LineString", "coordinates": continuation},
    }
    for filename, value in (("river_reach.geojson", feature), ("river_downstream.geojson", buffer_feature)):
        (DATA / filename).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"length_m": reach_length, "verified_downstream_m": buffer_length, "vertices": len(main)}


if __name__ == "__main__":
    print(json.dumps(prepare()))
