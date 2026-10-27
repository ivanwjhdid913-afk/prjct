"""Small immutable condition snapshots; results and session A/B state are not stored."""
from datetime import datetime
import json
import math
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.db import get_session
from app.models import SavedScenario
from app.river import prepared_reach
from app.simulation import SimulationRequest

FORMAT_VERSION = 1
MODEL_ID = 'conservative-1d-advection-dispersion-v1'
RIVER_VERSION = 'river-wgs84-v1'
SYNTHETIC_VERSION = 'synthetic-wgs84-meridian-v1'
MAX_BODY_BYTES = 8192
router = APIRouter(prefix='/api/v1/scenarios', tags=['saved conditions'])


class ScenarioCreate(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)

    name: str = Field(min_length=1, max_length=120)
    format_version: int
    model_id: str = Field(max_length=80)
    geometry_version: str = Field(max_length=64)
    geometry_sha256: str | None = Field(pattern='^[0-9a-f]{64}$')
    conditions: SimulationRequest

    @field_validator('name', mode='before')
    @classmethod
    def trim_name(cls, value):
        if isinstance(value, str):
            if any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in value):
                raise ValueError('Название не должно содержать управляющие символы.')
            return value.strip()
        return value

    @field_validator('format_version')
    @classmethod
    def supported_format(cls, value):
        if value != FORMAT_VERSION:
            raise ValueError('Не поддерживается версия формата сценария.')
        return value

    @field_validator('model_id')
    @classmethod
    def supported_model(cls, value):
        if value != MODEL_ID:
            raise ValueError('Обозначение модели изменилось. Обновите страницу перед сохранением.')
        return value


class ScenarioSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    name: str
    reach_name: str
    geometry_mode: Literal['river', 'synthetic']
    load_mode: Literal['continuous', 'finite']
    created_at: datetime


class Compatibility(BaseModel):
    compatible: bool
    reasons: list[str]


class ScenarioDetail(ScenarioSummary):
    format_version: int
    model_id: str
    geometry_version: str
    geometry_sha256: str | None
    downstream_geometry_sha256: str | None
    reach_id: str | None
    geometry_source: dict
    conditions: dict
    compatibility: Compatibility


class ScenarioPage(BaseModel):
    items: list[ScenarioSummary]
    total: int
    limit: int
    offset: int


def current_geometry(conditions: SimulationRequest, version: str, checksum: str | None):
    if conditions.reach_id is None:
        if version != SYNTHETIC_VERSION or checksum is not None:
            raise ValueError('Версия синтетической геометрии не поддерживается.')
        return None
    if version != RIVER_VERSION:
        raise ValueError('Версия формата речной геометрии не поддерживается.')
    reach, line = prepared_reach(conditions.reach_id)
    if checksum != reach['metadata']['geometry_sha256']:
        raise ValueError('Геометрия участка изменилась. Сохранение отменено; обновите участок и проверьте источник.')
    if line.length_m - conditions.source_distance_m < 100:
        raise ValueError('Ниже сценарного источника должно оставаться не менее 100 м подготовленного русла.')
    # Same geometric guard as calculation(), without integrating or allocating a trajectory.
    length = line.length_m - conditions.source_distance_m
    velocity, dispersion = conditions.velocity_m_s, conditions.dispersion_m2_s
    dx = length / (100 * math.ceil(max(1., length / 100 * velocity / (.5 * dispersion))))
    buffer_m = math.ceil(max(.1 * length, 20 * dispersion / velocity) / dx) * dx
    if buffer_m > reach['metadata']['verified_downstream_m']:
        raise ValueError('Для этих параметров расчётный буфер выходит за проверенное продолжение русла. '
                         'Проверьте параметры потока; автоматической подмены нет.')
    return reach


def compatibility(row: SavedScenario) -> Compatibility:
    reasons = []
    if row.format_version != FORMAT_VERSION:
        reasons.append('Версия формата сценария не поддерживается; исходная запись сохранена.')
    if row.model_id != MODEL_ID:
        reasons.append('Версия численной модели изменилась; исходная запись сохранена.')
    try:
        conditions = SimulationRequest.model_validate(row.conditions)
        if conditions.reach_id != row.reach_id or (conditions.reach_id is not None) != (row.geometry_mode == 'river'):
            raise ValueError('Сведения о геометрии и условия записи не согласованы.')
        reach = current_geometry(conditions, row.geometry_version, row.geometry_sha256)
        if reach and row.downstream_geometry_sha256 != reach['metadata']['downstream_geometry_sha256']:
            reasons.append('Геометрия проверенного продолжения участка изменилась; источник не перенесён.')
    except ValidationError:
        reasons.append('Сохранённые условия не соответствуют текущим правилам проверки.')
    except ValueError as error:
        reasons.append(str(error))
    return Compatibility(compatible=not reasons, reasons=reasons)


def detail(row: SavedScenario) -> ScenarioDetail:
    return ScenarioDetail(**ScenarioSummary.model_validate(row).model_dump(),
                          format_version=row.format_version, model_id=row.model_id,
                          geometry_version=row.geometry_version, geometry_sha256=row.geometry_sha256,
                          downstream_geometry_sha256=row.downstream_geometry_sha256,
                          reach_id=row.reach_id, geometry_source=row.geometry_source,
                          conditions=row.conditions, compatibility=compatibility(row))


def persist(data: ScenarioCreate, session: Session) -> ScenarioDetail:
    try:
        reach = current_geometry(data.conditions, data.geometry_version, data.geometry_sha256)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    metadata = reach['metadata'] if reach else {}
    source_keys = ('source', 'source_url', 'attribution', 'license', 'crs', 'snapshot_date',
                   'osm_way_id', 'osm_way_version', 'osm_way_timestamp', 'raw_sha256')
    row = SavedScenario(
        name=data.name, format_version=data.format_version, model_id=data.model_id,
        geometry_mode='river' if reach else 'synthetic', geometry_version=data.geometry_version,
        geometry_sha256=data.geometry_sha256,
        downstream_geometry_sha256=metadata.get('downstream_geometry_sha256'),
        reach_id=data.conditions.reach_id, reach_name=reach['name'] if reach else 'Синтетический участок',
        load_mode=data.conditions.load_mode, conditions=data.conditions.model_dump(mode='json'),
        geometry_source={key: metadata[key] for key in source_keys if key in metadata},
    )
    try:
        session.add(row)
        session.flush()
        # Build the complete bounded response before commit, then only acknowledge a successful commit.
        response = detail(row)
        session.commit()
        return response
    except SQLAlchemyError:
        session.rollback()
        raise HTTPException(503, 'База данных временно недоступна. Условия не сохранены.') from None


@router.post('', response_model=ScenarioDetail, status_code=201,
             openapi_extra={'requestBody': {'required': True, 'content': {
                 'application/json': {'schema': ScenarioCreate.model_json_schema()}}}})
async def create_scenario(request: Request, session: Annotated[Session, Depends(get_session)]):
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_BODY_BYTES:
            raise HTTPException(413, 'Слишком большая запись. Допустимо не более 8192 байт.')
        body.extend(chunk)
    try:
        data = ScenarioCreate.model_validate(json.loads(body))
    except (ValueError, ValidationError) as error:
        message = 'Ожидается JSON с названием и полными условиями сценария.'
        if isinstance(error, ValidationError):
            # Bounded user-facing errors, without echoing arbitrary payloads or database details.
            message = '; '.join(f"{'.'.join(map(str, item['loc']))}: {item['msg']}" for item in error.errors()[:5])
        raise HTTPException(422, message) from None
    return await run_in_threadpool(persist, data, session)


@router.get('', response_model=ScenarioPage)
def list_scenarios(session: Annotated[Session, Depends(get_session)],
                   limit: Annotated[int, Query(ge=1, le=50)] = 20,
                   offset: Annotated[int, Query(ge=0, le=1_000_000)] = 0):
    try:
        total = session.scalar(select(func.count()).select_from(SavedScenario))
        rows = session.scalars(select(SavedScenario).order_by(SavedScenario.created_at.desc(), SavedScenario.id)
                               .limit(limit).offset(offset)).all()
        return ScenarioPage(items=[ScenarioSummary.model_validate(row) for row in rows],
                            total=total, limit=limit, offset=offset)
    except SQLAlchemyError:
        raise HTTPException(503, 'База данных временно недоступна.') from None


@router.get('/{scenario_id}', response_model=ScenarioDetail)
def get_scenario(scenario_id: UUID, session: Annotated[Session, Depends(get_session)]):
    try:
        row = session.get(SavedScenario, scenario_id)
        if row is None:
            raise HTTPException(404, 'Сохранённый сценарий не найден.')
        return detail(row)
    except SQLAlchemyError:
        raise HTTPException(503, 'База данных временно недоступна.') from None
