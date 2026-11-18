"""Reproduce the four-reach Kuzminka network from pinned OSM XML, offline."""

import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET

from geographiclib.geodesic import Geodesic

DATA = Path(__file__).resolve().parents[1] / "data"
RAW = DATA / "raw" / "voronezh-kuzminka-context.osm"
VORONEZH = DATA / "raw" / "voronezh-kuzminka-way-35164443.osm"
RAW_SHA256 = "556b9c8048137c736a4902f9c670dfa8dc3da20445e3ee202b27c1e44fc9ebbf"
VORONEZH_SHA256 = "2a5202cd385768e98f58557aa210c71cbe7086ffe8f441b6db8a1a3a6c628fac"
DIRECTION = {
    "method": "Source node order checked against shared OSM node IDs and independent regional geographic descriptions.",
    "sources": ["https://lipkray.ru/dobroe/priroda", "https://lipkray.ru/lipetskr/priroda",
                "https://wiki.openstreetmap.org/wiki/Key:waterway"],
    "limitation": "Общее направление стока по картографическим источникам. Местные скорости, подпор и смешение требуют обследования.",
}


def canonical_geometry_sha256(document):
    payload = {key: document[key] for key in ("nodes", "reaches")}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"),
                                    ensure_ascii=False, allow_nan=False).encode("utf8")).hexdigest()


def build():
    for path, digest in ((RAW, RAW_SHA256), (VORONEZH, VORONEZH_SHA256)):
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError("Pinned OSM source checksum mismatch")
    osm = ET.parse(RAW).getroot()
    points = {int(node.get("id")): [float(node.get("lon")), float(node.get("lat"))]
              for node in osm.findall("node")}
    ways = {int(way.get("id")): way for way in osm.findall("way")}
    source_way = ET.parse(VORONEZH).getroot().find("way")
    expected_ids = [int(node.get("ref")) for node in source_way.findall("nd")]
    if expected_ids != [int(node.get("ref")) for node in ways[35164443].findall("nd")]:
        raise ValueError("Independent Voronezh source node IDs disagree")
    specs = [
        ("voronezh-upstream", "Воронеж выше устья", "main-inlet", "confluence", 35164443, 29, 350, 354),
        ("kuzminka-upstream", "Кузьминка перед устьем", "tributary-inlet", "confluence", 131324032, 16, 333, 338),
        ("voronezh-below", "Воронеж ниже устья", "confluence", "section", 35164443, 29, 354, 358),
        ("voronezh-lower", "Воронеж после створа", "section", "outlet", 35164443, 29, 358, 360),
    ]

    def segment(way_id, version, start, end):
        way = ways[way_id]
        if int(way.get("version")) != version:
            raise ValueError("Unexpected source OSM version")
        ids = [int(node.get("ref")) for node in way.findall("nd")][start:end + 1]
        coordinates = [points[identifier] for identifier in ids]
        distances = [0.0]
        for a, b in zip(coordinates, coordinates[1:]):
            edge = Geodesic.WGS84.Inverse(a[1], a[0], b[1], b[0])["s12"]
            if edge <= 0:
                raise ValueError("Degenerate network edge")
            distances.append(distances[-1] + edge)
        # Canonical micrometre metadata avoids platform-dependent libm tails.
        # Source vertices and the solver's measured geodesics remain untouched.
        distances = [round(distance, 6) for distance in distances]
        return {
            "geometry": {"type": "LineString", "coordinates": coordinates},
            "distances_m": distances, "length_m": distances[-1],
            "source_elements": [{"type": "way", "id": way_id, "version": version,
                                 "node_indices": [start, end], "node_ids": ids}],
        }

    node_specs = [
        ("main-inlet", 10758837678, "headwater"),
        ("tributary-inlet", 1482937686, "headwater"),
        ("confluence", 2106156604, "junction"),
        ("section", 412452064, "connection"),
        ("outlet", 412452058, "outlet"),
    ]
    nodes = [{"id": identifier, "coordinate": points[osm_id], "kind": kind, "osm_node_id": osm_id}
             for identifier, osm_id, kind in node_specs]
    reaches = []
    for identifier, name, upstream, downstream, way_id, version, start, end in specs:
        reaches.append({"id": identifier, "name": name, "from_node": upstream, "to_node": downstream,
                        **segment(way_id, version, start, end), "direction_basis": DIRECTION})
    extension = segment(35164443, 29, 360, 361)
    extension.update({
        "from_osm_node": 412452058, "to_osm_node": 412452057,
        "boundary_note": "Заканчивается в узле начала боковой протоки. Применение требует анализа чувствительности нижней границы.",
    })
    document = {
        "id": "kuzminka-v1", "name": "Воронеж и Кузьминка у Большой Кузьминки",
        "nodes": nodes, "reaches": reaches,
        "metadata": {
            "format_version": 1, "source": "OpenStreetMap",
            "source_url": "https://api.openstreetmap.org/api/0.6/map?bbox=39.72,52.728,39.76,52.77",
            "license": "ODbL-1.0", "license_url": "https://opendatacommons.org/licenses/odbl/1-0/",
            "attribution": "© OpenStreetMap contributors", "snapshot_date": "2026-11-02",
            "coordinate_order": "longitude, latitude", "crs": "EPSG:4326",
            "geometry_method": "Exact OSM vertices, no interpolation, snapping, smoothing or simplification; cumulative GeographicLib WGS84 distances canonicalized to 0.000001 m for portable metadata.",
            "geometry_checksum_method": "SHA-256 of UTF-8 JSON {nodes,reaches}, sort_keys=True, separators=(',',':'), ensure_ascii=False, allow_nan=False.",
            "source_files": [{"path": "raw/" + RAW.name, "sha256": RAW_SHA256},
                             {"path": "raw/" + VORONEZH.name, "sha256": VORONEZH_SHA256}],
            "boundary_note": "Короткая картографическая сеть до боковой протоки. Расходы, скорость, дисперсия и полное смешение задаются сценарием; полевой валидации нет.",
            "node_kind_note": "headwater обозначает вход расчётной области на срезе реки.",
            "verified_extension": extension,
            "bifurcation_distance_from_confluence_m": round(reaches[2]["length_m"] + reaches[3]["length_m"] + extension["length_m"], 6),
            "preparation_script": "backend/scripts/prepare_network.py",
        },
    }
    document["metadata"]["geometry_sha256"] = canonical_geometry_sha256(document)
    return document


def prepare(destination=DATA / "networks" / "kuzminka-v1.json"):
    document = build()
    encoded = (json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf8")
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(encoded)
    return document


if __name__ == "__main__":
    result = prepare()
    print(result["metadata"]["geometry_sha256"])
