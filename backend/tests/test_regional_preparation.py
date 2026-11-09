"""Offline cartographic preparation tests; may also run directly without a DB."""
from collections import Counter
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'prepare_regional.py'
spec = importlib.util.spec_from_file_location('regional_preparation', SCRIPT)
preparation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preparation)


class RegionalPreparationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = json.loads(preparation.RAW.read_bytes())
        cls.saved = json.loads((preparation.DATA / 'overview.geojson').read_bytes())
        cls.elements = {(e['type'], e['id']): e for e in cls.raw['elements']}

    def test_rebuild_twice_is_byte_identical_to_saved_output(self):
        with tempfile.TemporaryDirectory() as directory:
            a, b = Path(directory) / 'a.json', Path(directory) / 'b.json'
            preparation.prepare(a)
            preparation.prepare(b)
            self.assertEqual(a.read_bytes(), b.read_bytes())
            self.assertEqual(a.read_bytes(), (preparation.DATA / 'overview.geojson').read_bytes())

    def test_source_checksum_and_exact_feature_coverage(self):
        manifest = json.loads(preparation.MANIFEST.read_bytes())
        self.assertEqual(hashlib.sha256(preparation.RAW.read_bytes()).hexdigest(), manifest['raw_sha256'])
        kinds = Counter(f['properties']['kind'] for f in self.saved['features'])
        self.assertEqual(kinds, {'boundary': 1, 'river': 11, 'lake': 4, 'reservoir': 2})
        identifiers = [f['properties']['id'] for f in self.saved['features']]
        self.assertEqual(len(identifiers), len(set(identifiers)))
        self.assertTrue(all(identifier.isascii() for identifier in identifiers))
        for feature in self.saved['features']:
            for ref in feature['properties']['source_elements']:
                self.assertEqual(ref['version'], self.elements[(ref['type'], ref['id'])]['version'])

    def test_every_river_way_is_separate_and_every_vertex_unchanged(self):
        count = 0
        for feature in self.saved['features']:
            if feature['properties']['kind'] != 'river':
                continue
            self.assertEqual(feature['geometry']['type'], 'MultiLineString')
            refs = feature['properties']['source_elements']
            parts = feature['geometry']['coordinates']
            self.assertEqual(len(refs), len(parts))
            for ref, part in zip(refs, parts):
                source = self.elements[(ref['type'], ref['id'])]
                self.assertEqual(part, preparation.coordinates(source))
                self.assertEqual(feature['properties']['name'], source['tags']['name'])
                count += 1
        self.assertEqual(count, 163)

    def test_polygon_edges_are_exact_source_edges_including_holes(self):
        def edges(parts):
            return Counter(tuple(sorted((tuple(a), tuple(b)))) for part in parts for a, b in zip(part, part[1:]))
        for feature in self.saved['features']:
            if feature['properties']['kind'] == 'river':
                continue
            ref = feature['properties']['source_elements'][0]
            source = self.elements[(ref['type'], ref['id'])]
            source_parts = ([preparation.coordinates(source)] if source['type'] == 'way' else
                            [preparation.coordinates(member) for member in source['members']
                             if member['type'] == 'way' and member['role'] in ('outer', 'inner')])
            output_parts = preparation.lines(feature['geometry'])
            self.assertEqual(edges(source_parts), edges(output_parts))
            for ring in output_parts:
                preparation.validate_ring(ring)
            for point in (p for ring in output_parts for p in ring):
                self.assertTrue(36 < point[0] < 42 and 50 < point[1] < 55)

    def test_reach_mapping_and_no_concentration_fields(self):
        rivers = {f['properties']['id']: f for f in self.saved['features']}
        self.assertEqual(rivers['river-don']['properties']['prepared_reach_ids'], ['don-olkhovets'])
        self.assertEqual(rivers['river-voronezh']['properties']['prepared_reach_ids'],
                         ['voronezh-zheltye-peski', 'voronezh-below-kuzminka'])
        for feature in self.saved['features']:
            self.assertNotIn('concentration', feature['properties'])
            if feature['properties']['kind'] in ('lake', 'reservoir'):
                self.assertEqual(feature['properties']['prepared_reach_ids'], [])
                self.assertIn('не подключён', feature['properties']['limitation'])

    def test_bad_coordinate_ring_and_ambiguous_join_are_rejected(self):
        for bad in ([[39, 52], [float('nan'), 52]], [[52, 39], [53, 40]], [[39, 52], [39, 52]]):
            with self.assertRaises(ValueError):
                preparation.coordinates({'geometry': [{'lon': p[0], 'lat': p[1]} for p in bad]})
        with self.assertRaises(ValueError):
            preparation.validate_ring([[39, 52], [39.1, 52.1], [39, 52.1], [39.1, 52], [39, 52]])
        with self.assertRaises(ValueError):
            preparation.rings_from_members([{'type': 'way', 'role': 'outer', 'geometry':
                [{'lon': 39, 'lat': 52}, {'lon': 39.1, 'lat': 52}]}], 'outer')

    def test_checksum_tampering_is_rejected_before_preparation(self):
        with tempfile.TemporaryDirectory() as directory:
            bad = Path(directory) / 'tampered.json'
            bad.write_bytes(preparation.RAW.read_bytes() + b' ')
            with patch.object(preparation, 'RAW', bad), self.assertRaisesRegex(ValueError, 'checksum'):
                preparation.prepare(Path(directory) / 'output.json')

    def test_outside_context_counts_and_prepared_checksum(self):
        context = self.saved['metadata']['preparation']['outside_boundary_context']
        self.assertEqual(context['outside_vertex_count'], 3117)
        self.assertEqual(context['ways_with_outside_vertices'], 10)
        checksum_file = (preparation.DATA / 'overview.sha256').read_text(encoding='ascii')
        self.assertEqual(checksum_file.split()[0], preparation.sha256(preparation.DATA / 'overview.geojson'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
