"""Bounded scenarios on synthetic or documented river geometry."""

import json
import math
from threading import Lock
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from starlette.concurrency import run_in_threadpool

from app.transport import simulate
from app.river import prepared_reach


class SimulationInput(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, allow_inf_nan=False)

    river_flow_m3_s: float = Field(ge=0.1, le=1000)
    effluent_flow_m3_s: float = Field(ge=0, le=100)
    background_mg_l: float = Field(ge=0, le=10000)
    effluent_mg_l: float = Field(ge=0, le=10000)
    velocity_m_s: float = Field(ge=0.02, le=2)
    dispersion_m2_s: float = Field(ge=0.1, le=100)
    length_m: float = Field(ge=100, le=20000)
    duration_hours: float = Field(ge=0.1, le=48)


class LineGeometry(BaseModel):
    type: Literal['LineString'] = 'LineString'
    coordinates: list[tuple[float, float]]


class SimulationRequest(SimulationInput):
    length_m: float | None = Field(default=None, ge=100, le=20000)
    reach_id: str | None = Field(default=None, min_length=1, max_length=80)
    source_distance_m: float = Field(default=0, ge=0, le=20000)

    @model_validator(mode='after')
    def geometry_conditions(self):
        if self.reach_id is not None and self.length_m is not None:
            raise ValueError('Для реального русла длина определяется геометрией; не передавайте length_m.')
        if self.reach_id is None and (self.length_m is None or self.source_distance_m != 0):
            raise ValueError('Синтетическому сценарию нужна длина и источник в начале линии.')
        return self


class SimulationResult(BaseModel):
    inputs: SimulationInput
    derived: dict[str, float]
    distances_m: list[float]
    times_hours: list[float]
    concentrations_mg_l: list[list[float]]
    scale_mg_l: tuple[float, float]
    geometry: LineGeometry
    diagnostics: dict
    provenance: Literal['synthetic', 'river_scenario'] = 'synthetic'
    reach_id: str | None = None
    source_distance_m: float = 0
    source_coordinate: tuple[float, float] | None = None
    reach_metadata: dict | None = None
    segment_geometries: list[LineGeometry] | None = None


router = APIRouter()
calculation_lock = Lock()
MAX_BODY_BYTES = 4096


def synthetic_line(length_m: float, segments: int = 100) -> dict:
    """Northward WGS84 meridian, arbitrary anchor (40 E, 52.3 N), NOT a river.

    Integrate the ellipsoid's meridional radius in metres using Simpson's rule,
    then invert this arc length with Newton iterations. A meridian is a geodesic.
    The <=20 km span makes eight integration panels sufficient; PostGIS geography
    independently verifies the entire line and individual segments to <1 cm.
    """
    a, flattening = 6378137.0, 1 / 298.257223563
    eccentricity_squared = flattening * (2 - flattening)
    origin = math.radians(52.3)

    def radius(latitude):
        return a * (1 - eccentricity_squared) / (1 - eccentricity_squared * math.sin(latitude) ** 2) ** 1.5

    def arc(latitude):
        step = (latitude - origin) / 8
        return step / 3 * (radius(origin) + radius(latitude)
                           + sum((4 if i % 2 else 2) * radius(origin + i * step) for i in range(1, 8)))

    coordinates = []
    for i in range(segments + 1):
        distance = length_m * i / segments
        latitude = origin + distance / radius(origin)
        for _ in range(4):
            latitude -= (arc(latitude) - distance) / radius(latitude)
        coordinates.append((40.0, math.degrees(latitude)))
    return {'type': 'LineString', 'coordinates': coordinates}


def calculate(parameters: SimulationRequest) -> SimulationResult:
    # One bounded calculation per server process; no growing job queue or DB writes.
    if not calculation_lock.acquire(blocking=False):
        raise HTTPException(503, 'Другой расчёт ещё выполняется. Повторите попытку через несколько секунд.',
                            headers={'Retry-After': '5'})
    try:
        physics = parameters.model_dump(exclude={'reach_id', 'source_distance_m'})
        if parameters.reach_id is None:
            result = simulate(physics)
            return SimulationResult(**result, geometry=synthetic_line(parameters.length_m))
        reach, line = prepared_reach()
        if parameters.reach_id != reach['id']:
            raise ValueError('Неизвестный подготовленный участок реки.')
        start = parameters.source_distance_m
        length = line.length_m - start
        if length < 100:
            raise ValueError('Ниже сценарного источника должно оставаться не менее 100 м подготовленного русла.')
        physics['length_m'] = length
        u, dispersion = physics['velocity_m_s'], physics['dispersion_m2_s']
        dx = physics['length_m'] / (100 * math.ceil(max(1., physics['length_m'] / 100 * u / (.5 * dispersion))))
        buffer_m = math.ceil(max(.1 * physics['length_m'], 20 * dispersion / u) / dx) * dx
        if buffer_m > reach['metadata']['verified_downstream_m']:
            raise ValueError('Для этих параметров расчётный буфер выходит за проверенное продолжение русла. '
                             'Измените параметры сценария; автоматической подмены нет.')
        result = simulate(physics)
        return SimulationResult(**result, provenance='river_scenario', reach_id=reach['id'],
                                source_distance_m=start, source_coordinate=line.point_at(start),
                                reach_metadata=reach['metadata'],
                                geometry={'type': 'LineString', 'coordinates': line.slice(start, line.length_m)},
                                segment_geometries=line.segments(start, line.length_m))
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    finally:
        calculation_lock.release()


@router.post('/api/v1/simulations', response_model=SimulationResult,
             openapi_extra={'requestBody': {'required': True, 'content': {
                 'application/json': {'schema': SimulationRequest.model_json_schema()}}}})
async def run_simulation(request: Request):
    # Read a bounded stream BEFORE JSON parsing, including chunked requests.
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_BODY_BYTES:
            raise HTTPException(413, 'Слишком большой запрос. Допустимо не более 4096 байт.')
        body.extend(chunk)
    try:
        data = json.loads(body)
        parameters = SimulationRequest.model_validate(data)
    except (ValueError, ValidationError) as error:
        if isinstance(error, ValidationError):
            # Do not echo arbitrary payload values, NaN, or internal validation context.
            detail = [{'loc': ['body', *item['loc']], 'msg': item['msg'], 'type': item['type']}
                      for item in error.errors()]
        else:
            detail = 'Ожидается JSON с числовыми параметрами сценария.'
        raise HTTPException(422, detail) from None
    return await run_in_threadpool(calculate, parameters)


@router.get('/api/v1/river-reaches')
def river_reaches():
    reach, _ = prepared_reach()
    return {'items': [reach]}
