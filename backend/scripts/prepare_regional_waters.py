"""Build the whole-oblast map from the pinned OSM response, without network access."""

from collections import Counter, defaultdict
import gzip
import hashlib
import json
from pathlib import Path

if __package__:
    from .prepare_regional import coordinates, element_ref, lines, polygon_geometry
else:
    from prepare_regional import coordinates, element_ref, lines, polygon_geometry


DATA = Path(__file__).resolve().parents[1] / "data" / "regional"
MANIFEST = DATA / "whole-area-manifest.json"
RAW = DATA / "raw" / "whole-area-osm.json.gz"
QUERY = DATA / "raw" / "whole-area.overpassql"
SOURCE_ID = "osm-lipetsk-20261116"
LINE_KINDS = {"river", "stream"}
POLYGON_KINDS = {"lake", "pond", "reservoir"}
KINDS = ("boundary", "river", "stream", "lake", "pond", "reservoir", "water")
TOLERANCE_DEGREES = 0.00006
REACH_ANCHORS = {
    "river-don": ({30428409}, ["don-olkhovets"]),
    "river-voronezh": ({26274036, 35164443}, ["voronezh-zheltye-peski", "voronezh-below-kuzminka"]),
}
LABELS = {
    "river": "Река", "stream": "Ручей", "lake": "Озеро", "pond": "Пруд",
    "reservoir": "Водохранилище", "water": "Водная поверхность",
}
LIMITATIONS = {
    "boundary": "Административная граница по OpenStreetMap.",
    "line": "Обзорная ось из OpenStreetMap. Расчёт доступен только для отдельно подготовленных участков.",
    "polygon": "Водная поверхность по OpenStreetMap. Геометрия предназначена для просмотра.",
}


def name_of(element):
    tags = element.get("tags", {})
    for key in ("name", "name:ru"):
        if tags.get(key):
            name = " ".join(tags[key].split())
            if name:
                return name
    return None


def water_kind(tags):
    water_type = tags.get("water")
    if water_type in POLYGON_KINDS:
        return water_type
    if tags.get("landuse") == "reservoir":
        return "reservoir"
    return "water" if tags.get("natural") == "water" else None


def group_waterways(ways, relations):
    """Use named OSM memberships and shared vertex IDs; never use proximity."""
    by_id = {way["id"]: way for way in ways}
    parent = {identifier: identifier for identifier in by_id}
    component_names = {identifier: name_of(way) for identifier, way in by_id.items()}
    inherited_names = defaultdict(set)
    memberships = []

    def root(identifier):
        while parent[identifier] != identifier:
            parent[identifier] = parent[parent[identifier]]
            identifier = parent[identifier]
        return identifier

    def join(a, b):
        a, b = sorted((root(a), root(b)))
        parent[b] = a

    for relation in sorted(relations, key=lambda entry: entry["id"]):
        name = name_of(relation)
        kind = relation["tags"].get("waterway")
        if name is None or kind not in LINE_KINDS:
            continue
        members = []
        for member in relation["members"]:
            identifier = member["ref"]
            candidate = by_id.get(identifier)
            if (member["type"] != "way" or member["role"] not in {"main_stream", "side_stream", ""}
                    or candidate is None or candidate["tags"]["waterway"] != kind):
                continue
            explicit_name = component_names[identifier]
            if explicit_name == name or (explicit_name is None and member["role"] == "main_stream"):
                members.append(identifier)
                if explicit_name is None:
                    inherited_names[identifier].add(name)
        memberships.append((relation, name, members))

    for identifier, candidates in inherited_names.items():
        if len(candidates) == 1:
            component_names[identifier] = next(iter(candidates))

    node_owners = {}
    for identifier, way in by_id.items():
        kind = way["tags"]["waterway"]
        for node in way["nodes"]:
            key = kind, component_names[identifier], node
            join(identifier, node_owners.setdefault(key, identifier))

    for _, name, members in memberships:
        compatible = [identifier for identifier in members if component_names[identifier] == name]
        for identifier in compatible[1:]:
            join(compatible[0], identifier)

    groups = {}
    for identifier, way in sorted(by_id.items()):
        group = groups.setdefault(root(identifier), {
            "kind": way["tags"]["waterway"], "name": component_names[identifier], "ways": [], "relations": [],
        })
        group["ways"].append(way)
    for relation, name, members in memberships:
        included = {root(identifier) for identifier in members if component_names[identifier] == name}
        for identifier in included:
            groups[identifier]["relations"].append(relation)
    return list(groups.values())


def geometry_parts(geometry, target):
    if geometry.is_empty:
        return []
    if geometry.geom_type == target:
        return [geometry]
    return [part for member in getattr(geometry, "geoms", ()) for part in geometry_parts(member, target)]


def clipped_geometry(geometry, boundary, target):
    if boundary.covers(geometry):
        return geometry_parts(geometry, target)
    return geometry_parts(geometry.intersection(boundary), target)


def polygon_member_roles(row):
    members = row["members"]
    if len(members) == 1 and members[0]["type"] == "way" and members[0]["role"] == "":
        points = coordinates(members[0])
        if len(points) >= 4 and points[0] == points[-1]:
            return {**row, "members": [{**members[0], "role": "outer"}]}
    return row


def line_chunks(way, shared):
    """Preserve interior nodes that other regional waterway ways reference."""
    points = coordinates(way)
    nodes = way["nodes"]
    if len(nodes) != len(points):
        raise ValueError("Inconsistent OSM node and coordinate arrays")
    cuts = [0, *[i for i, node in enumerate(nodes[1:-1], 1) if node in shared], len(nodes) - 1]
    return [points[a:b + 1] for a, b in zip(cuts, cuts[1:])]


def build(raw, manifest):
    import shapely
    from shapely.geometry import LineString, MultiLineString, MultiPolygon, Polygon, mapping, shape
    from shapely.geometry.polygon import orient

    if raw.get("remark"):
        raise ValueError("Incomplete Overpass response")
    rows = raw["elements"]
    by_ref = {(row["type"], row["id"]): row for row in rows}
    if len(by_ref) != len(rows):
        raise ValueError("Duplicate OSM elements in saved extraction")
    boundary_row = by_ref[("relation", 72169)]
    if boundary_row["tags"].get("ISO3166-2") != "RU-LIP":
        raise ValueError("Unexpected administrative boundary")
    boundary_geometry = polygon_geometry(boundary_row)
    boundary = shape(boundary_geometry)
    if not boundary.is_valid:
        raise ValueError("Invalid regional boundary")
    shapely.prepare(boundary)
    features = []
    clipped = Counter()
    excluded = Counter()
    repaired = Counter()
    named_counts = Counter()
    counts = Counter()

    def publish(identifier, kind, name, geometry, refs, reach_ids=(), tags=None):
        primary = refs[0]
        properties = {
            "id": identifier, "kind": kind, "named": name is not None,
            "name": name or f"{LABELS[kind]} OSM {primary['id']}",
            "source_id": SOURCE_ID, "source_elements": refs,
            "prepared_reach_ids": list(reach_ids),
            "limitation": LIMITATIONS["line" if kind in LINE_KINDS else "boundary" if kind == "boundary" else "polygon"],
        }
        if tags and "water" in tags:
            properties["osm_water_type"] = tags["water"]
        if tags and tags.get("landuse") == "reservoir":
            properties["osm_landuse"] = tags["landuse"]
        counts[kind] += 1
        named_counts[kind] += name is not None
        features.append({"type": "Feature", "properties": properties, "geometry": geometry})

    def simplify(parts):
        for part in parts:
            simplified = part.simplify(TOLERANCE_DEGREES, preserve_topology=True)
            # Keep clipped endpoints and avoid creating shortcuts outside the oblast.
            if simplified.is_valid and not simplified.is_empty and boundary.covers(simplified):
                yield simplified
            else:
                yield part

    def provenance(row):
        refs = [element_ref(row)]
        if row["type"] == "relation":
            seen = set()
            for member in row["members"]:
                ref = member["type"], member["ref"]
                if ref[0] == "way" and member["role"] in {"outer", "inner"} and ref not in seen:
                    seen.add(ref)
                    refs.append(element_ref(by_ref[ref]) if ref in by_ref else {"type": ref[0], "id": ref[1]})
        return refs

    publish("lipetsk-oblast", "boundary", name_of(boundary_row), boundary_geometry, provenance(boundary_row))
    waterways = [row for row in rows if row["type"] == "way" and row.get("tags", {}).get("waterway") in LINE_KINDS]
    waterway_relations = [row for row in rows if row["type"] == "relation" and row.get("tags", {}).get("type") == "waterway"]
    visits = Counter(node for way in waterways for node in set(way["nodes"]))
    shared = {node for node, count in visits.items() if count > 1}
    anchors_used = set()
    for group in group_waterways(waterways, waterway_relations):
        kind, name = group["kind"], group["name"]
        parts, ways = [], []
        for way in group["ways"]:
            try:
                chunks = [LineString(points) for points in line_chunks(way, shared)]
            except ValueError:
                excluded["invalid_waterway"] += 1
                continue
            received = [part for chunk in chunks for part in clipped_geometry(chunk, boundary, "LineString")]
            if not received:
                excluded["waterway_outside_or_boundary_touch"] += 1
                continue
            clipped[kind] += any(not boundary.covers(chunk) for chunk in chunks)
            parts.extend(simplify(received))
            ways.append(way)
        if not ways:
            continue
        osm_ids = {way["id"] for way in ways}
        named_anchor = next(((key, ids) for key, (required, ids) in REACH_ANCHORS.items() if required <= osm_ids), None)
        relations = group["relations"]
        refs = [element_ref(way) for way in ways] + [element_ref(relation) for relation in relations]
        if named_anchor:
            identifier, reach_ids = named_anchor
            anchors_used.add(identifier)
        else:
            identifier, reach_ids = f"{kind}-osm-way-{ways[0]['id']}", ()
        geometry = mapping(parts[0] if len(parts) == 1 else MultiLineString(parts))
        publish(identifier, kind, name, geometry, refs, reach_ids)
    if anchors_used != REACH_ANCHORS.keys():
        raise ValueError("Required prepared-reach OSM references are missing or split")

    polygon_rows = [row for row in rows if water_kind(row.get("tags", {}))]
    candidate_counts = Counter(water_kind(row["tags"]) for row in polygon_rows)
    retained_outer_ways = set()
    for row in sorted(polygon_rows, key=lambda row: (row["type"] != "relation", row["id"])):
        tags = row["tags"]
        kind = water_kind(tags)
        if row["type"] == "way" and row["id"] in retained_outer_ways:
            excluded["duplicate_polygon_outer_way"] += 1
            continue
        try:
            if row["type"] == "way":
                geometry = Polygon(coordinates(row))
            else:
                row = polygon_member_roles(row)
                geometry = shape(polygon_geometry(row))
        except (KeyError, ValueError):
            excluded[f"invalid_polygon_{row['type']}"] += 1
            continue
        if not geometry.is_valid:
            geometry = shapely.make_valid(geometry)
            repaired[kind] += 1
        received = clipped_geometry(geometry, boundary, "Polygon")
        if not received:
            excluded["polygon_outside_or_boundary_touch"] += 1
            continue
        clipped[kind] += not boundary.covers(geometry)
        parts = [orient(part, sign=1.0) for part in simplify(received)]
        final = parts[0] if len(parts) == 1 else MultiPolygon(parts)
        if not final.is_valid:
            final = geometry if boundary.covers(geometry) else geometry.intersection(boundary)
            parts = [orient(part, sign=1.0) for part in geometry_parts(final, "Polygon")]
            final = parts[0] if len(parts) == 1 else MultiPolygon(parts)
            if not final.is_valid:
                excluded["invalid_clipped_multipolygon"] += 1
                continue
        if row["type"] == "relation":
            retained_outer_ways.update(member["ref"] for member in row["members"]
                                       if member["type"] == "way" and member["role"] == "outer")
        identifier = f"{kind}-osm-{row['type']}-{row['id']}"
        publish(identifier, kind, name_of(row), mapping(final), provenance(row), tags=tags)

    vertices = sum(len(part) for feature in features for part in lines(feature["geometry"]))
    return {
        "type": "FeatureCollection",
        "metadata": {
            "format_version": 1, "name": "Водные объекты Липецкой области",
            "crs": "EPSG:4326", "coordinate_order": "longitude, latitude",
            "obtained_on": manifest["obtained_on"], "coverage_note": manifest["coverage_note"],
            "sources": [{
                "id": SOURCE_ID, "name": "OpenStreetMap / Overpass, Липецкая область",
                "url": manifest["download_url"], "license": "ODbL-1.0",
                "license_url": "https://opendatacommons.org/licenses/odbl/1-0/",
                "attribution": "© OpenStreetMap contributors", "obtained_on": manifest["obtained_on"],
                "raw_sha256": manifest["raw_sha256"], "raw_path": "regional/raw/whole-area-osm.json.gz",
            }],
            "preparation": {
                "script": "backend/scripts/prepare_regional_waters.py",
                "osm_base_timestamp": raw["osm3s"]["timestamp_osm_base"],
                "area_base_timestamp": raw["osm3s"]["timestamp_areas_base"],
                "query_sha256": manifest["query_sha256"], "archive_sha256": manifest["archive_sha256"],
                "boundary_osm_relation": 72169, "boundary_version": boundary_row["version"],
                "feature_counts": {kind: counts[kind] for kind in KINDS},
                "named_feature_counts": {kind: named_counts[kind] for kind in KINDS},
                "source_waterway_counts": dict(sorted(Counter(way["tags"]["waterway"] for way in waterways).items())),
                "source_polygon_counts": dict(sorted(candidate_counts.items())),
                "clipped_counts": dict(sorted(clipped.items())), "repaired_polygon_counts": dict(sorted(repaired.items())),
                "excluded_counts": dict(sorted(excluded.items())), "coordinate_count": vertices,
                "simplification": {"method": "GEOS topology-preserving simplification of clipped parts",
                                   "tolerance_degrees": TOLERANCE_DEGREES},
            },
        },
        "bbox": list(boundary.bounds),
        "features": features,
    }


def prepare(destination=DATA / "whole-area.geojson"):
    manifest = json.loads(MANIFEST.read_bytes())
    archive = RAW.read_bytes()
    if hashlib.sha256(archive).hexdigest() != manifest["archive_sha256"]:
        raise ValueError("Pinned OSM archive checksum mismatch")
    raw = gzip.decompress(archive)
    if hashlib.sha256(raw).hexdigest() != manifest["raw_sha256"]:
        raise ValueError("Pinned OSM response checksum mismatch")
    if hashlib.sha256(QUERY.read_bytes()).hexdigest() != manifest["query_sha256"]:
        raise ValueError("Pinned OSM query checksum mismatch")
    document = build(json.loads(raw), manifest)
    encoded = (json.dumps(document, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n").encode("utf8")
    checksum = hashlib.sha256(encoded).hexdigest()
    destination = Path(destination)
    destination.write_bytes(encoded)
    destination.with_suffix(".sha256").write_text(f"{checksum}  {destination.name}\n", encoding="ascii", newline="\n")
    return {"bytes": len(encoded), "sha256": checksum, **document["metadata"]["preparation"]}


if __name__ == "__main__":
    print(json.dumps(prepare()))
