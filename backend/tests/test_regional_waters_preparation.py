"""Offline checks for whole-oblast OSM provenance and grouping."""

from collections import Counter
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest


BACKEND = Path(__file__).resolve().parents[1]
DATA = BACKEND / "data" / "regional"
SCRIPT = BACKEND / "scripts" / "prepare_regional_waters.py"


def preparation():
    if not SCRIPT.is_file():
        raise AssertionError("Whole-oblast OSM preparation is not implemented")
    spec = importlib.util.spec_from_file_location("prepare_regional_waters", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(SCRIPT.parent))
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.pop(0)
    return module


def way(identifier, nodes, name=None):
    tags = {"waterway": "river"}
    if name is not None:
        tags["name"] = name
    return {"type": "way", "id": identifier, "nodes": nodes, "version": 1, "tags": tags}


def relation(identifier, name, members):
    return {
        "type": "relation", "id": identifier, "version": 1,
        "tags": {"type": "waterway", "waterway": "river", "name": name},
        "members": [{"type": "way", "role": role, "ref": ref} for ref, role in members],
    }


def grouped_ways(groups):
    return {frozenset(way["id"] for way in group["ways"]) for group in groups}


class WholeOblastPreparationTests(unittest.TestCase):
    def test_shared_nodes_group_a_named_river_without_merging_a_homonym(self):
        ways = [way(11, [1, 2, 3], "Река"), way(12, [2, 4], "Река"),
                way(13, [5, 6], "Река"), way(14, [3, 7], "Приток")]
        groups = preparation().group_waterways(ways, [])
        self.assertEqual(grouped_ways(groups), {frozenset(x) for x in ((11, 12), (13,), (14,))})

    def test_explicit_main_stream_can_group_disconnected_members_but_not_tributaries(self):
        ways = [way(11, [1, 2], "Река"), way(12, [3, 4]),
                way(13, [5, 6], "Приток"), way(14, [7, 8], "Река")]
        membership = [(11, "main_stream"), (12, "main_stream"), (13, "tributary")]
        groups = preparation().group_waterways(ways, [relation(91, "Река", membership)])
        self.assertEqual(grouped_ways(groups), {frozenset(x) for x in ((11, 12), (13,), (14,))})
        combined = next(group for group in groups if len(group["ways"]) == 2)
        self.assertEqual(combined["name"], "Река")
        self.assertEqual([r["id"] for r in combined["relations"]], [91])

    def test_unnamed_connected_ways_remain_an_unnamed_component(self):
        ways = [way(11, [1, 2]), way(12, [2, 3]), way(13, [4, 5])]
        groups = preparation().group_waterways(ways, [])
        self.assertEqual(grouped_ways(groups), {frozenset((11, 12)), frozenset((13,))})
        self.assertTrue(all(group["name"] is None for group in groups))

    def test_water_polygon_uses_specific_tags_and_keeps_other_explicit_subtypes_generic(self):
        classify = preparation().water_kind
        self.assertEqual(classify({"natural": "water", "water": "pond"}), "pond")
        self.assertEqual(classify({"landuse": "reservoir"}), "reservoir")
        self.assertEqual(classify({"water": "lake"}), "lake")
        self.assertEqual(classify({"natural": "water", "water": "oxbow"}), "water")
        self.assertEqual(classify({"natural": "water"}), "water")
        self.assertIsNone(classify({"natural": "wetland"}))

    def test_saved_shapes_use_uniquely_referenced_source_groups_and_approved_reaches(self):
        source = json.loads(gzip.decompress((DATA / "raw" / "whole-area-osm.json.gz").read_bytes()))
        by_ref = {(row["type"], row["id"]): row for row in source["elements"]}
        member_refs = {(member["type"], member["ref"]) for row in source["elements"]
                       for member in row.get("members", [])}
        saved = json.loads((DATA / "whole-area.geojson").read_bytes())
        features = saved["features"]
        by_id = {f["properties"]["id"]: f for f in features}
        self.assertEqual(len(by_id), len(features))
        self.assertEqual(by_id["lipetsk-oblast"]["properties"]["kind"], "boundary")
        self.assertEqual(by_id["river-don"]["properties"]["prepared_reach_ids"], ["don-olkhovets"])
        self.assertEqual(by_id["river-voronezh"]["properties"]["prepared_reach_ids"],
                         ["voronezh-zheltye-peski", "voronezh-below-kuzminka"])
        self.assertEqual({f["properties"]["kind"] for f in features},
                         {"boundary", "river", "stream", "lake", "pond", "reservoir", "water"})
        line_kinds = {"river", "stream"}
        source_ways = Counter(row["id"] for row in source["elements"] if row["type"] == "way"
                              and row.get("tags", {}).get("waterway") in line_kinds)
        displayed_ways = Counter(ref["id"] for feature in features
                                 if feature["properties"]["kind"] in line_kinds
                                 for ref in feature["properties"]["source_elements"] if ref["type"] == "way")
        self.assertEqual(displayed_ways, source_ways)
        expected_counts = Counter(f["properties"]["kind"] for f in features)
        self.assertEqual(saved["metadata"]["preparation"]["feature_counts"], expected_counts)
        for feature in features:
            properties = feature["properties"]
            self.assertIs(type(properties["named"]), bool)
            for ref in properties["source_elements"]:
                key = ref["type"], ref["id"]
                if key in by_ref:
                    self.assertEqual(ref["version"], by_ref[key]["version"])
                else:
                    self.assertIn(key, member_refs)
                    self.assertNotIn("version", ref)

    def test_single_closed_blank_role_multipolygon_retains_its_polygon_and_member(self):
        saved = json.loads((DATA / "whole-area.geojson").read_bytes())
        by_id = {f["properties"]["id"]: f for f in saved["features"]}
        feature = by_id["water-osm-relation-8502377"]
        self.assertEqual(feature["geometry"]["type"], "Polygon")
        self.assertIn({"type": "way", "id": 613892455}, feature["properties"]["source_elements"])

    @unittest.skipUnless(importlib.util.find_spec("shapely"), "Optional offline Shapely builder dependency")
    def test_clipping_preserves_the_hole_and_never_turns_a_touch_into_a_line(self):
        from shapely.geometry import LineString, Polygon

        module = preparation()
        box = Polygon([(39, 52), (40, 52), (40, 53), (39, 53)])
        water = Polygon([(38.9, 52.1), (39.8, 52.1), (39.8, 52.8), (38.9, 52.8)],
                        holes=[[(39.1, 52.2), (39.2, 52.2), (39.2, 52.3), (39.1, 52.3)]])
        projected = module.clipped_geometry(water, box, "Polygon")
        self.assertEqual(len(projected), 1)
        self.assertEqual(len(projected[0].interiors), 1)
        self.assertTrue(box.covers(projected[0]))
        self.assertEqual(module.clipped_geometry(LineString([(38.9, 51.9), (39, 52)]),
                                                 box, "LineString"), [])

    @unittest.skipUnless(importlib.util.find_spec("shapely"), "Optional offline Shapely builder dependency")
    def test_offline_rebuild_matches_published_bytes_and_sha256(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "whole-area.geojson"
            result = preparation().prepare(output)
            raw = output.read_bytes()
            self.assertEqual(raw, (DATA / "whole-area.geojson").read_bytes())
            self.assertEqual(hashlib.sha256(raw).hexdigest(), result["sha256"])

    @unittest.skipUnless(importlib.util.find_spec("shapely"), "Optional offline Shapely builder dependency")
    def test_all_published_geometries_are_valid_and_inside_the_oblast(self):
        import shapely
        from shapely.geometry import shape

        features = json.loads((DATA / "whole-area.geojson").read_bytes())["features"]
        # Allow the numerical rounding of GEOS intersection at the polygon edge.
        boundary = shape(features[0]["geometry"]).buffer(1e-11)
        shapely.prepare(boundary)
        for feature in features:
            geometry = shape(feature["geometry"])
            self.assertTrue(geometry.is_valid, feature["properties"]["id"])
            self.assertTrue(boundary.covers(geometry), feature["properties"]["id"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
