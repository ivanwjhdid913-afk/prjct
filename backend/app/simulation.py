"""Bounded scenarios on synthetic or documented river geometry."""

import json
import math
from threading import Lock
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator, model_serializer
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse

from app.transport import MAX_RESPONSE_BYTES, _resolution_limit, simulate
from app.river import prepared_reach, prepared_reaches
from app.scenario_versions import FORMAT_VERSION, MODEL_ID


class LoadInterval(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, allow_inf_nan=False)
    start_hours: float = Field(ge=0, le=48)
    end_hours: float = Field(gt=0, le=48)
    effluent_mg_l: float = Field(ge=0, le=10000)


class SimulationInput(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, allow_inf_nan=False)

    river_flow_m3_s: float = Field(ge=0.1, le=1000)
    effluent_flow_m3_s: float = Field(ge=0, le=100)
    background_mg_l: float = Field(ge=0, le=10000)
    effluent_mg_l: float | None = Field(ge=0, le=10000)
    velocity_m_s: float = Field(ge=0.02, le=2)
    dispersion_m2_s: float = Field(ge=0.1, le=100)
    length_m: float = Field(ge=100, le=20000)
    duration_hours: float = Field(ge=0.1, le=48)
    load_mode: Literal['continuous', 'finite', 'profile'] = 'continuous'
    load_duration_hours: float | None = Field(default=None, gt=0)
    load_intervals: list[LoadInterval] | None = Field(default=None, max_length=12)

    @model_serializer(mode='wrap')
    def serialize_load(self, handler):
        result = handler(self)
        if self.load_mode != 'profile':
            result.pop('load_intervals', None)
        return result

    @model_validator(mode='after')
    def load_conditions(self):
        if self.load_mode != 'profile' and self.effluent_mg_l is None:
            raise ValueError('Для постоянной и конечной нагрузки нужна концентрация стоков ce.')
        if self.load_mode != 'profile' and self.load_intervals is not None:
            raise ValueError('Интервалы допустимы только в режиме профиля.')
        if self.load_mode == 'profile':
            if self.load_intervals is None:
                raise ValueError('Профилю нужен явный список интервалов, включая пустой список.')
            if self.load_duration_hours is not None:
                raise ValueError('Для профиля load_duration_hours должен быть null.')
            errors = []
            previous_end = 0.
            for index, row in enumerate(self.load_intervals):
                message = None
                field = 'start_hours'
                if row.start_hours >= row.end_hours:
                    message, field = 'Конец интервала должен быть позже начала.', 'end_hours'
                elif row.end_hours > self.duration_hours:
                    message, field = 'Интервал выходит за горизонт расчёта.', 'end_hours'
                elif row.start_hours < previous_end:
                    message = 'Нарушен порядок или есть перекрытие с предыдущим интервалом.'
                if message:
                    errors.append(dict(type='value_error', loc=('load_intervals', index, field),
                                       input=getattr(row, field), ctx={'error': ValueError(message)}))
                previous_end = row.end_hours
            if errors:
                raise ValidationError.from_exception_data(type(self).__name__, errors)
        if self.load_mode == 'continuous' and self.load_duration_hours is not None:
            raise ValueError('Для непрерывной нагрузки load_duration_hours должен быть null.')
        if self.load_mode == 'finite' and (self.load_duration_hours is None
                                           or self.load_duration_hours > self.duration_hours):
            raise ValueError('Конечной нагрузке нужна длительность не больше длительности расчёта.')
        return self


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
    format_version: int = FORMAT_VERSION
    model_id: str = MODEL_ID
    inputs: SimulationInput
    derived: dict[str, float | None]
    distances_m: list[float]
    times_hours: list[float]
    concentrations_mg_l: list[list[float]]
    scale_mg_l: tuple[float, float]
    geometry: LineGeometry
    diagnostics: dict
    temporal_resolution: dict
    provenance: Literal['synthetic', 'river_scenario'] = 'synthetic'
    reach_id: str | None = None
    source_distance_m: float = 0
    source_coordinate: tuple[float, float] | None = None
    reach_metadata: dict | None = None
    segment_geometries: list[LineGeometry] | None = None

    @model_serializer(mode='wrap')
    def serialize_versioned_inputs(self, handler):
        result = handler(self)
        if self.format_version >= 2 and self.inputs.load_mode != 'profile':
            result['inputs']['load_intervals'] = None
        return result


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


def bounded_response(result: SimulationResult) -> JSONResponse:
    """Measure the exact UTF-8 body that is returned, including river geometry."""
    response = JSONResponse(result.model_dump(mode='json'))
    if len(response.body) > MAX_RESPONSE_BYTES:
        raise _resolution_limit(f'ответ превышает {MAX_RESPONSE_BYTES} байт.')
    return response


def calculate(parameters: SimulationRequest) -> JSONResponse:
    # One bounded calculation per server process; no growing job queue or DB writes.
    if not calculation_lock.acquire(blocking=False):
        raise HTTPException(503, 'Другой расчёт ещё выполняется. Повторите попытку через несколько секунд.',
                            headers={'Retry-After': '5'})
    try:
        physics = parameters.model_dump(exclude={'reach_id', 'source_distance_m'})
        if parameters.reach_id is None:
            result = simulate(physics)
            return bounded_response(SimulationResult(**result, geometry=synthetic_line(parameters.length_m)))
        reach, line = prepared_reach(parameters.reach_id)
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
        return bounded_response(SimulationResult(**result, provenance='river_scenario', reach_id=reach['id'],
                                source_distance_m=start, source_coordinate=line.point_at(start),
                                reach_metadata=reach['metadata'],
                                geometry={'type': 'LineString', 'coordinates': line.slice(start, line.length_m)},
                                segment_geometries=line.segments(start, line.length_m)))
    except ValueError as error:
        if parameters.reach_id and str(error).startswith('Слишком большой размер вычислений'):
            raise HTTPException(422, 'Слишком большой размер вычислений: длина определяется руслом. '
                                'Сократите длительность или задайте другую комбинацию параметров потока; '
                                'значения не изменены автоматически. Сетка:' + str(error).split('Сетка:')[-1]) from None
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
    return {'items': prepared_reaches()}


@router.get('/api/v1/river-reaches/{reach_id}/source-snap')
def source_snap(reach_id: str, longitude: float = Query(ge=-180, le=180, allow_inf_nan=False),
                latitude: float = Query(ge=-90, le=90, allow_inf_nan=False)):
    try:
        reach, line = prepared_reach(reach_id)
        projected = line.project([longitude, latitude])
        if projected['distance_to_river_m'] > 75 + 1e-6:
            raise ValueError('Нажмите не дальше 75 м от выбранного русла. Источник не перемещён.')
        if projected['distance_to_river_m'] > 75:
            projected['distance_to_river_m'] = 75.
        maximum = line.length_m - 100
        # GeographicLib and the bounded minimizer can differ by fractions of a
        # millimetre at an exactly selected boundary. This is numerical equality,
        # not an extension of the usable 100 m remainder or a user-value clamp.
        if projected['source_distance_m'] > maximum + 1e-6:
            raise ValueError('Ниже сценарного источника должно оставаться не менее 100 м '
                             'подготовленного русла. Выберите точку выше по течению.')
        if projected['source_distance_m'] > maximum:
            projected['source_distance_m'] = maximum
            projected['coordinate'] = line.point_at(maximum)
        return dict(reach_id=reach['id'], **projected, max_distance_m=75)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
