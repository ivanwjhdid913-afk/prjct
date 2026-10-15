"""Measured WGS84 polylines. Distances follow every source vertex downstream."""
from bisect import bisect_left
from functools import lru_cache
import json
import hashlib
import math
from pathlib import Path

from geographiclib.geodesic import Geodesic


class MeasuredLine:
    def __init__(self, coordinates):
        if not isinstance(coordinates, list) or not 2 <= len(coordinates) <= 10000:
            raise ValueError('Нужна непрерывная линия из 2–10000 вершин.')
        self.coordinates = coordinates
        self.distances = [0.0]
        self.edges = []
        for point in coordinates:
            if (len(point) != 2 or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in point)
                    or not -180 <= point[0] <= 180 or not -90 <= point[1] <= 90):
                raise ValueError('Недопустимая координата WGS84.')
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


@lru_cache(maxsize=1)
def prepared_reach():
    document = json.loads((Path(__file__).resolve().parents[1] / 'data' / 'river_reach.geojson').read_text(encoding='utf-8'))
    if document['type'] != 'Feature' or document['geometry']['type'] != 'LineString':
        raise ValueError('Неверный формат подготовленного русла.')
    line = MeasuredLine(document['geometry']['coordinates'])
    if not 100 <= line.length_m <= 20000:
        raise ValueError('Длина подготовленного участка вне границ модели.')
    metadata = {**document['properties'], 'geometry_sha256': hashlib.sha256(
        json.dumps(document['geometry'], sort_keys=True, separators=(',', ':')).encode()).hexdigest()}
    return dict(id=metadata['id'], name=metadata['name'], length_m=line.length_m,
                geometry=document['geometry'], distances_m=line.distances, metadata=metadata), line
