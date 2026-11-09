"""Bounded, cached cartography; never a river-routing or simulation service."""
from datetime import date
from functools import lru_cache
import hashlib
import json
import math
from pathlib import Path
import re
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request, Response
from app.river import prepared_reaches

DATA_PATH = Path(__file__).resolve().parents[1] / 'data' / 'regional' / 'overview.geojson'
MAX_BYTES = 16 * 1024 * 1024
router = APIRouter(prefix='/api/v1/regional-overview', tags=['regional cartography'])


def _text(value, maximum=4000):
    return isinstance(value, str) and 0 < len(value) <= maximum and bool(value.strip()) and not any(ord(c) < 32 for c in value)


def _identifier(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value) is not None


def _date(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        return False
    try:
        date.fromisoformat(value)
        return True
    except ValueError:
        return False


def _url(value):
    if not _text(value, 4000) or any(c.isspace() for c in value) or '\\' in value:
        return False
    try:
        parsed = urlsplit(value)
        parsed.port
        return parsed.scheme in ('https', 'http') and bool(parsed.hostname) and parsed.username is None and parsed.password is None
    except ValueError:
        return False


def validate_overview(document, reach_ids):
    """Check the published contract once. Disconnected lines remain disconnected."""
    def require(condition):
        if not condition:
            raise ValueError('Неверные геометрия, происхождение или ссылки обзорного набора.')

    require(isinstance(document, dict) and document.get('type') == 'FeatureCollection')
    metadata = document.get('metadata')
    require(isinstance(metadata, dict))
    require(metadata.get('format_version') == 1 and metadata.get('crs') == 'EPSG:4326'
            and metadata.get('coordinate_order') == 'longitude, latitude'
            and _text(metadata.get('name')) and _text(metadata.get('coverage_note'))
            and _date(metadata.get('obtained_on')) and isinstance(metadata.get('preparation'), dict))
    sources = metadata.get('sources')
    require(isinstance(sources, list) and 1 <= len(sources) <= 100)
    source_ids = set()
    for source in sources:
        require(isinstance(source, dict) and _identifier(source.get('id')) and source['id'] not in source_ids)
        require(all(_text(source.get(key)) for key in ('name', 'license', 'attribution'))
                and _url(source.get('url')) and _date(source.get('obtained_on'))
                and isinstance(source.get('raw_sha256'), str) and re.fullmatch(r'[0-9a-f]{64}', source['raw_sha256']))
        source_ids.add(source['id'])
    features = document.get('features')
    require(isinstance(features, list) and 1 <= len(features) <= 10000)
    vertices = 0

    def coordinate(point):
        nonlocal vertices
        vertices += 1
        require(vertices <= 250000 and isinstance(point, list) and len(point) == 2)
        require(all(not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v) for v in point))
        require(-180 <= point[0] <= 180 and -90 <= point[1] <= 90)

    def line(points, ring=False):
        require(isinstance(points, list) and len(points) >= (4 if ring else 2))
        for point in points:
            coordinate(point)
        require(not ring or points[0] == points[-1])

    def polygon(rings):
        require(isinstance(rings, list) and len(rings) > 0)
        for ring in rings:
            line(ring, True)

    ids, mapped_reaches, boundaries = set(), set(), 0
    for feature in features:
        require(isinstance(feature, dict) and feature.get('type') == 'Feature')
        p, geometry = feature.get('properties'), feature.get('geometry')
        require(isinstance(p, dict) and isinstance(geometry, dict))
        require(_identifier(p.get('id')) and p['id'] not in ids and _text(p.get('name'), 300)
                and p.get('source_id') in source_ids and _text(p.get('limitation')))
        ids.add(p['id'])
        kind = p.get('kind')
        require(kind in ('boundary', 'river', 'lake', 'reservoir'))
        boundaries += kind == 'boundary'
        elements = p.get('source_elements')
        require(isinstance(elements, list) and 1 <= len(elements) <= 10000)
        for element in elements:
            require(isinstance(element, dict) and _text(element.get('type'), 40))
            element_id = element.get('id')
            require(not isinstance(element_id, bool) and (isinstance(element_id, int) and element_id > 0
                    or isinstance(element_id, str) and _identifier(element_id)))
        prepared = p.get('prepared_reach_ids')
        require(isinstance(prepared, list) and len(prepared) <= 100 and all(_identifier(id) for id in prepared))
        require(len(set(prepared)) == len(prepared) and set(prepared) <= reach_ids
                and not (set(prepared) & mapped_reaches) and (kind == 'river' or not prepared))
        mapped_reaches.update(prepared)
        shape, coordinates = geometry.get('type'), geometry.get('coordinates')
        if kind == 'river':
            require(shape in ('LineString', 'MultiLineString'))
            if shape == 'LineString':
                line(coordinates)
            else:
                require(isinstance(coordinates, list) and len(coordinates) > 0)
                for part in coordinates:
                    line(part)
        else:
            require(shape in ('Polygon', 'MultiPolygon'))
            if shape == 'Polygon':
                polygon(coordinates)
            else:
                require(isinstance(coordinates, list) and len(coordinates) > 0)
                for part in coordinates:
                    polygon(part)
    require(boundaries == 1)
    # Includes preparation metadata: NaN must not leak through an otherwise valid feature.
    require(len(json.dumps(document, ensure_ascii=False, allow_nan=False).encode('utf-8')) <= MAX_BYTES)
    return document


@lru_cache(maxsize=1)
def saved_overview():
    with DATA_PATH.open('rb') as stream:
        raw = stream.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError('Слишком большой обзорный набор.')
    document = json.loads(raw)
    validate_overview(document, {reach['id'] for reach in prepared_reaches()})
    return raw, '"' + hashlib.sha256(raw).hexdigest() + '"'


@router.get('')
def regional_overview(request: Request):
    try:
        raw, etag = saved_overview()
    except (OSError, ValueError, TypeError, RecursionError):
        raise HTTPException(503, 'Сохранённый обзор области временно недоступен. Повторите загрузку.') from None
    headers = {'ETag': etag, 'Cache-Control': 'public, max-age=3600'}
    if request.headers.get('if-none-match') == etag:
        return Response(status_code=304, headers=headers)
    return Response(content=raw, media_type='application/json', headers=headers)
