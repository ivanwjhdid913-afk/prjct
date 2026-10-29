"""Read-only, bounded validation of portable scenario conditions."""
import json
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from app.scenarios import Compatibility, ScenarioCreate, conditions_compatibility
from app.simulation import SimulationRequest

MAX_FILE_BYTES = 8192
router = APIRouter(prefix='/api/v1/scenario-files', tags=['condition files'])


class ConditionsDocument(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, allow_inf_nan=False)

    name: str = Field(min_length=1, max_length=120)
    format_version: int = Field(ge=1)
    model_id: str = Field(min_length=1, max_length=80)
    geometry_mode: Literal['river', 'synthetic']
    geometry_version: str = Field(min_length=1, max_length=64)
    geometry_sha256: str | None = Field(pattern='^[0-9a-f]{64}$')
    downstream_geometry_sha256: str | None = Field(pattern='^[0-9a-f]{64}$')
    reach_id: str | None = Field(min_length=1, max_length=80)
    reach_name: str = Field(min_length=1, max_length=200)
    geometry_source: dict[str, str | int | float | bool | None]
    conditions: SimulationRequest

    @field_validator('name', mode='before')
    @classmethod
    def trim_name(cls, value):
        return ScenarioCreate.trim_name(value)

    @field_validator('geometry_source')
    @classmethod
    def bounded_source(cls, value):
        if len(json.dumps(value, ensure_ascii=False).encode('utf-8')) > 2048:
            raise ValueError('Сведения о происхождении геометрии превышают 2048 байт.')
        return value

    @field_validator('conditions', mode='before')
    @classmethod
    def complete_conditions(cls, value):
        # API defaults remain backwards compatible, while a portable snapshot
        # must state every condition explicitly rather than silently invent it.
        if isinstance(value, dict):
            missing = set(SimulationRequest.model_fields) - value.keys()
            if missing:
                raise ValueError('Неполные условия файла: отсутствуют ' + ', '.join(sorted(missing)) + '.')
        return value


class FileValidation(BaseModel):
    document: ConditionsDocument
    compatibility: Compatibility


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Повторяющиеся ключи в JSON не допускаются.')
        result[key] = value
    return result


@router.post('/validate', response_model=FileValidation,
             openapi_extra={'requestBody': {'required': True, 'content': {
                 'application/json': {'schema': ConditionsDocument.model_json_schema()}}}})
async def validate_condition_file(request: Request):
    if request.headers.get('content-type', '').split(';', 1)[0].strip().lower() != 'application/json':
        raise HTTPException(415, 'Для проверки условий требуется Content-Type: application/json.')
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_FILE_BYTES:
            raise HTTPException(413, 'Файл условий превышает 8192 байта. Выберите файл без результатов расчёта.')
        body.extend(chunk)
    try:
        data = json.loads(body, object_pairs_hook=unique_object)
        document = ConditionsDocument.model_validate(data)
    except (ValueError, RecursionError) as error:
        message = 'Ожидается корректный JSON-файл с полными условиями сценария.'
        if isinstance(error, ValidationError):
            message = '; '.join(f"{'.'.join(map(str, item['loc']))}: {item['msg']}" for item in error.errors()[:5])
        elif str(error).startswith('Повторяющиеся ключи'):
            message = str(error)
        raise HTTPException(422, message) from None
    compatible = conditions_compatibility(**document.model_dump(exclude={'name', 'reach_name', 'geometry_source'}))
    return FileValidation(document=document, compatibility=compatible)
