"""Measured WGS84 polylines. Distances follow every source vertex downstream."""
from bisect import bisect_left
from copy import deepcopy
from functools import lru_cache
import json
import hashlib
import math
from pathlib import Path

from geographiclib.geodesic import Geodesic


DATA_DIR = Path(__file__).resolve().parents[1] / 'data'


def _coordinate(point):
    if (not isinstance(point, (list, tuple)) or len(point) != 2
            or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in point)
            or not -180 <= point[0] <= 180 or not -90 <= point[1] <= 90):
        raise ValueError('Недопустимая координата WGS84.')


class MeasuredLine:
    def __init__(self, coordinates):
        if not isinstance(coordinates, list) or not 2 <= len(coordinates) <= 10000:
            raise ValueError('Нужна непрерывная линия из 2–10000 вершин.')
        self.coordinates = deepcopy(coordinates)
        self.distances = [0.0]
        self.edges = []
        for point in coordinates:
            _coordinate(point)
        for a, b in zip(coordinates, coordinates[1:]):
            edge = Geodesic.WGS84.Inverse(a[1], a[0], b[1], b[0])
            if not 0.001 <= edge['s12'] <= 1000:
                raise ValueError('Повторная вершина или разрыв русла более 1 км.')
            self.edges.append(edge)
            self.distances.append(self.distances[-1] + edge['s12'])
        self.length_m = self.distances[-1]

    def point_at(self, distance):
        if not math.isfinite(distance) or not 0 <= distance <= self.length_m:
            raise ValueError('Положение источника вне подготовленного участка.')
        right = bisect_left(self.distances, distance)
        if right < len(self.distances) and abs(self.distances[right] - distance) < 1e-8:
            return self.coordinates[right][:]
        left = right - 1
        a = self.coordinates[left]
        point = Geodesic.WGS84.Direct(a[1], a[0], self.edges[left]['azi1'], distance - self.distances[left])
        return [point['lon2'], point['lat2']]

    def slice(self, start, end):
        if end <= start:
            raise ValueError('Длина участка должна быть положительной.')
        # Original bends remain between geodesically interpolated boundaries.
        return [self.point_at(start),
                *[point[:] for point, distance in zip(self.coordinates, self.distances) if start < distance < end],
                self.point_at(end)]

    def segments(self, start, end, count=100):
        boundaries = [start + (end - start) * i / count for i in range(count)] + [end]
        return [{'type': 'LineString', 'coordinates': self.slice(a, b)}
                for a, b in zip(boundaries, boundaries[1:])]

    def project(self, point):
        """Nearest point on the actual WGS84 geodesic segments, in metres.

        Every endpoint is a candidate. Triangle inequality excludes segments
        that cannot improve the best endpoint. Remaining short (<=1 km) edges
        use bounded golden-section minimization. A near-river minimum is refined
        by its first variation (the cosine between the forward tangent and the
        bearing to the click): distances alone become numerically flat near a
        perpendicular minimum. Never project in longitude/latitude degrees.
        """
        _coordinate(point)

        def distance(coordinate):
            return Geodesic.WGS84.Inverse(point[1], point[0], coordinate[1], coordinate[0])['s12']

        endpoint_distances = [distance(coordinate) for coordinate in self.coordinates]
        nearest = min(range(len(endpoint_distances)), key=endpoint_distances.__getitem__)
        best_distance = endpoint_distances[nearest]
        best_chainage = self.distances[nearest]
        best_coordinate = self.coordinates[nearest][:]
        ratio = (math.sqrt(5) - 1) / 2
        for index, edge in enumerate(self.edges):
            if max(endpoint_distances[index], endpoint_distances[index + 1]) - edge['s12'] > best_distance:
                continue
            origin = self.coordinates[index]
            geodesic = Geodesic.WGS84.Line(origin[1], origin[0], edge['azi1'])

            def evaluate(along):
                candidate = geodesic.Position(along)
                coordinate = [candidate['lon2'], candidate['lat2']]
                return distance(coordinate), coordinate

            left, right = 0., edge['s12']
            a, b = right - ratio * (right - left), left + ratio * (right - left)
            da, ca = evaluate(a)
            db, cb = evaluate(b)
            while right - left > 1e-7:
                if da <= db:
                    right, b, db, cb = b, a, da, ca
                    a = right - ratio * (right - left)
                    da, ca = evaluate(a)
                else:
                    left, a, da, ca = a, b, db, cb
                    b = left + ratio * (right - left)
                    db, cb = evaluate(b)
            along, candidate_distance, candidate = (a, da, ca) if da <= db else (b, db, cb)
            if candidate_distance < 1000:
                def derivative(position):
                    current = geodesic.Position(position)
                    to_click = Geodesic.WGS84.Inverse(current['lat2'], current['lon2'], point[1], point[0])
                    return -math.cos(math.radians(to_click['azi1'] - current['azi2']))

                lo, hi = max(0., along - .01), min(edge['s12'], along + .01)
                if derivative(lo) < 0 < derivative(hi):
                    while hi - lo > 1e-7:
                        middle = (lo + hi) / 2
                        if derivative(middle) < 0:
                            lo = middle
                        else:
                            hi = middle
                    along = (lo + hi) / 2
                    candidate_distance, candidate = evaluate(along)
            if candidate_distance < best_distance:
                best_distance = candidate_distance
                best_chainage = self.distances[index] + along
                best_coordinate = candidate
        return dict(source_distance_m=best_chainage, coordinate=best_coordinate,
                    distance_to_river_m=best_distance)


def _read_line(path):
    try:
        document = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f'Не удалось прочитать сохранённое русло: {path.name}.') from error
    if (document.get('type') != 'Feature' or document.get('geometry', {}).get('type') != 'LineString'
            or not isinstance(document.get('properties'), dict)):
        raise ValueError('Неверный формат подготовленного русла.')
    line = MeasuredLine(document['geometry']['coordinates'])
    declared = document['properties'].get('length_m')
    if (isinstance(declared, bool) or not isinstance(declared, (int, float))
            or not math.isfinite(declared) or abs(declared - line.length_m) > .01):
        raise ValueError('Заявленная длина русла не соответствует геодезической геометрии.')
    return document, line


def _load_reach(main_path, downstream_path):
    document, line = _read_line(main_path)
    if not 100 <= line.length_m <= 20000:
        raise ValueError('Длина подготовленного участка вне границ модели.')
    downstream, downstream_line = _read_line(downstream_path)
    if document['geometry']['coordinates'][-1] != downstream['geometry']['coordinates'][0]:
        raise ValueError('Проверенное продолжение должно начинаться в конце выбранного русла.')
    verified = document['properties'].get('verified_downstream_m')
    if (isinstance(verified, bool) or not isinstance(verified, (int, float))
            or not math.isfinite(verified) or abs(verified - downstream_line.length_m) > .01):
        raise ValueError('Длина проверенного продолжения не соответствует геометрии буфера.')
    metadata = {**document['properties'], 'geometry_sha256': hashlib.sha256(
        json.dumps(document['geometry'], sort_keys=True, separators=(',', ':')).encode()).hexdigest()}
    if not isinstance(metadata.get('id'), str) or not metadata['id'] or not metadata.get('name'):
        raise ValueError('Подготовленному руслу нужны идентификатор и название.')
    # Buffer acceptance uses the measured saved tail, never an overstated label.
    metadata['verified_downstream_m'] = downstream_line.length_m
    return dict(id=metadata['id'], name=metadata['name'], length_m=line.length_m,
                geometry=document['geometry'], distances_m=line.distances, metadata=metadata), line


@lru_cache(maxsize=1)
def _prepared_registry():
    pairs = [(DATA_DIR / 'river_reach.geojson', DATA_DIR / 'river_downstream.geojson')]
    pairs.extend((path, path.with_name(path.name.removesuffix('_reach.geojson') + '_downstream.geojson'))
                 for path in sorted((DATA_DIR / 'reaches').glob('*_reach.geojson')))
    registry = {}
    for main_path, downstream_path in pairs:
        reach, line = _load_reach(main_path, downstream_path)
        if reach['id'] in registry:
            raise ValueError('Повторный идентификатор подготовленного русла.')
        registry[reach['id']] = reach, line
    return registry


def prepared_reach(reach_id='don-olkhovets'):
    try:
        return deepcopy(_prepared_registry()[reach_id])
    except KeyError:
        raise ValueError('Неизвестный подготовленный участок реки.') from None


def prepared_reaches():
    return [deepcopy(reach) for reach, _ in _prepared_registry().values()]
