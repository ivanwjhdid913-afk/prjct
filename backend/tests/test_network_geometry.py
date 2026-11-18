"""Pinned real geometry for the first four-reach teaching network."""

import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

BACKEND = Path(__file__).resolve().parents[1]
SCRIPT = BACKEND / "scripts" / "prepare_network.py"
SAVED = BACKEND / "data" / "networks" / "kuzminka-v1.json"


class NetworkGeometryTests(unittest.TestCase):
    def module(self):
        self.assertTrue(SCRIPT.is_file(), "The pinned network builder must exist")
        spec = importlib.util.spec_from_file_location("network_preparation", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_rebuild_is_identical_and_lengths_match_the_four_source_intervals(self):
        module = self.module()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "network.json"
            document = module.prepare(path)
            self.assertEqual(path.read_bytes(), SAVED.read_bytes())
        self.assertEqual(len(document["nodes"]), 5)
        self.assertEqual(len(document["reaches"]), 4)
        for reach, length in zip(document["reaches"], [322.127224196, 422.672333700, 430.380169078, 158.640891585]):
            self.assertAlmostEqual(reach["length_m"], length, places=6)
            self.assertEqual(reach["distances_m"][0], 0)
            self.assertEqual(reach["distances_m"][-1], reach["length_m"])
            self.assertTrue(all(a < b for a, b in zip(reach["distances_m"], reach["distances_m"][1:])))

    def test_exact_osm_vertices_shared_nodes_and_canonical_checksum(self):
        module = self.module()
        document = module.build()
        xml = ET.parse(module.RAW).getroot()
        points = {int(n.get("id")): [float(n.get("lon")), float(n.get("lat"))] for n in xml.findall("node")}
        nodes = {node["id"]: node for node in document["nodes"]}
        for reach in document["reaches"]:
            refs = reach["source_elements"][0]["node_ids"]
            self.assertEqual(reach["geometry"]["coordinates"], [points[ref] for ref in refs])
            self.assertEqual(reach["geometry"]["coordinates"][0], nodes[reach["from_node"]]["coordinate"])
            self.assertEqual(reach["geometry"]["coordinates"][-1], nodes[reach["to_node"]]["coordinate"])
        payload = json.dumps({key: document[key] for key in ("nodes", "reaches")},
                             sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf8")
        self.assertEqual(hashlib.sha256(payload).hexdigest(), document["metadata"]["geometry_sha256"])
        extension = document["metadata"]["verified_extension"]
        self.assertEqual(extension["geometry"]["coordinates"][0], nodes["outlet"]["coordinate"])
        self.assertAlmostEqual(extension["length_m"], 183.061680969, places=6)
        self.assertAlmostEqual(document["metadata"]["bifurcation_distance_from_confluence_m"], 772.082741631, places=6)
        for target, incoming, outgoing in [("confluence", 2, 1), ("section", 1, 1)]:
            self.assertEqual(sum(r["to_node"] == target for r in document["reaches"]), incoming)
            self.assertEqual(sum(r["from_node"] == target for r in document["reaches"]), outgoing)

    def test_tampered_source_is_rejected_before_output_is_created(self):
        module = self.module()
        with tempfile.TemporaryDirectory() as directory:
            raw = Path(directory) / "source.osm"
            raw.write_bytes(module.RAW.read_bytes() + b" ")
            output = Path(directory) / "output.json"
            with patch.object(module, "RAW", raw):
                with self.assertRaisesRegex(ValueError, "checksum"):
                    module.prepare(output)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
