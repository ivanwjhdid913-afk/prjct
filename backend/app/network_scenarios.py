"""Immutable network conditions with the exact reviewed geometry snapshot."""
from uuid import UUID
import json
from fastapi import Depends, HTTPException, Query
from pydantic import Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from app.db import get_session
from app.models import NetworkScenario
from app.river_network import Inputs, MODEL_ID, StrictInputs, load_network, router, topology

class ScenarioCreate(StrictInputs):
    name: str = Field(min_length=1, max_length=120)
    model_id: str
    format_version: int
    conditions: Inputs

    @field_validator('name')
    @classmethod
    def clean_name(cls, value):
        if not value.strip() or any((ord(c) < 32 or 127 <= ord(c) <= 159 for c in value)):
            raise ValueError('Введите непустое название без управляющих символов.')
        return value.strip()

    @field_validator('model_id')
    @classmethod
    def model(cls, value):
        if value != MODEL_ID:
            raise ValueError('Неподдерживаемая модель речной сети.')
        return value

    @field_validator('format_version')
    @classmethod
    def version(cls, value):
        if value != 1:
            raise ValueError('Неподдерживаемая версия сетевого сценария.')
        return value

def view(record):
    try:
        current = load_network(record.conditions['network_id'])
    except ValueError as exc:
        raise HTTPException(409, 'Сохранённая сеть отсутствует в текущем каталоге.') from exc
    if current != record.network_snapshot:
        raise HTTPException(409, 'Геометрия или происхождение сохранённой сети изменились.')
    try:
        inputs = Inputs.model_validate(record.conditions)
        nodes, reaches, incoming, _, _ = topology(current)
        if (record.model_id != MODEL_ID or record.format_version != 1
                or inputs.geometry_sha256 != current['geometry_sha256']
                or {h.node_id for h in inputs.headwaters} != {n for n in nodes if not incoming[n]}
                or {h.reach_id for h in inputs.hydraulics} != set(reaches)
                or inputs.source.reach_id not in reaches
                or inputs.source.distance_m > reaches[inputs.source.reach_id]['length_m']):
            raise ValueError('Incompatible saved network conditions')
    except ValueError as exc:
        raise HTTPException(409, 'Сохранённые условия сети несовместимы.') from exc
    return dict(
        id=record.id, name=record.name, model_id=record.model_id,
        format_version=record.format_version, conditions=record.conditions,
        network_snapshot=record.network_snapshot, created_at=record.created_at,
    )

@router.post('/scenarios', status_code=201)
def create_scenario(body: ScenarioCreate, session: Session=Depends(get_session)):
    try:
        network = load_network(body.conditions.network_id)
        if network['geometry_sha256'] != body.conditions.geometry_sha256:
            raise HTTPException(409, 'Геометрия сети изменилась. Обновите параметры.')
        nodes, reaches, incoming, _, _ = topology(network)
        conditions = body.conditions
        if ({h.node_id for h in conditions.headwaters} != {n for n in nodes if not incoming[n]}
                or {h.reach_id for h in conditions.hydraulics} != set(reaches)
                or conditions.source.reach_id not in reaches):
            raise HTTPException(422, 'Условия ссылаются на отсутствующие элементы сети.')
        if conditions.source.distance_m > reaches[conditions.source.reach_id]['length_m']:
            raise HTTPException(422, 'Источник расположен за пределами участка.')
        record = NetworkScenario(
            name=body.name, model_id=body.model_id, format_version=body.format_version,
            conditions=conditions.model_dump(), network_snapshot=network,
        )
        if len(json.dumps(record.conditions).encode()) > 8192 or len(json.dumps(network).encode()) > 131072:
            raise HTTPException(422, 'Снимок условий или сети превышает допустимый размер.')
        session.add(record)
        session.flush()
        result = view(record)
        session.commit()
        return result
    except SQLAlchemyError as exc:
        session.rollback()
        raise HTTPException(503, 'Хранилище сетевых сценариев временно недоступно.') from exc
    except HTTPException:
        session.rollback()
        raise
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc

@router.get('/scenarios')
def list_scenarios(limit: int=Query(50, ge=1, le=100), offset: int=Query(0, ge=0), session: Session=Depends(get_session)):
    try:
        records = session.scalars(select(NetworkScenario).order_by(NetworkScenario.created_at.desc(), NetworkScenario.id).limit(limit).offset(offset)).all()
        items = []
        for record in records:
            try:
                items.append(view(record))
            except HTTPException as exc:
                if exc.status_code != 409:
                    raise
                items.append(dict(
                    id=record.id, name=record.name, created_at=record.created_at,
                    conditions=record.conditions, model_id=record.model_id,
                    format_version=record.format_version,
                    compatible=False, incompatibility=exc.detail,
                ))
        return dict(items=items, total=session.scalar(select(func.count()).select_from(NetworkScenario)))
    except SQLAlchemyError as exc:
        raise HTTPException(503, 'Хранилище сетевых сценариев временно недоступно.') from exc

@router.get('/scenarios/{scenario_id}')
def get_scenario(scenario_id: UUID, session: Session=Depends(get_session)):
    try:
        record = session.get(NetworkScenario, scenario_id)
        if record is None:
            raise HTTPException(404, 'Сетевой сценарий не найден.')
        return view(record)
    except SQLAlchemyError as exc:
        raise HTTPException(503, 'Хранилище сетевых сценариев временно недоступно.') from exc
