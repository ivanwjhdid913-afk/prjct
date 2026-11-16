"""Evidence supplied with the synthetic single-discharge teaching scenario."""
import json
from decimal import Decimal
from typing import Annotated, Generic, Literal, TypeVar

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator


INPUT_PROVENANCE_MAX_BYTES = 4096
Value = TypeVar('Value')


def nonblank_text(value: str) -> str:
    if not value.strip() or any(ord(char) < 32 or 127 <= ord(char) <= 159 or 0xD800 <= ord(char) <= 0xDFFF for char in value):
        raise ValueError('Текст происхождения должен содержать видимые символы без управляющих знаков.')
    return value


def longitude_latitude(value: list[float]) -> list[float]:
    lon, lat = value
    if not -180 <= lon <= 180 or not -90 <= lat <= 90:
        raise ValueError('Ожидаются долгота и широта WGS84.')
    return value


SourceText = Annotated[str, Field(min_length=1, max_length=240), AfterValidator(nonblank_text)]
ReceiverText = Annotated[str, Field(min_length=1, max_length=160), AfterValidator(nonblank_text)]
Coordinates = Annotated[list[float], Field(min_length=2, max_length=2), AfterValidator(longitude_latitude)]


class ProvenanceField(BaseModel, Generic[Value]):
    model_config = ConfigDict(extra='forbid', strict=True, allow_inf_nan=False)

    basis: Literal['prepared_geometry', 'synthetic']
    source: SourceText
    value: Value


class ProvenanceFields(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)

    discharge_coordinates: ProvenanceField[Coordinates]
    receiver: ProvenanceField[ReceiverText]
    source_distance_m: ProvenanceField[float]
    effluent_flow_m3_s: ProvenanceField[float]
    effluent_mg_l: ProvenanceField[float]
    river_flow_m3_s: ProvenanceField[float]
    background_mg_l: ProvenanceField[float]
    velocity_m_s: ProvenanceField[float]
    dispersion_m2_s: ProvenanceField[float]
    duration_hours: ProvenanceField[float]
    load_mode: ProvenanceField[Literal['continuous']]

    @model_validator(mode='after')
    def matching_basis(self):
        if self.receiver.basis != 'prepared_geometry':
            raise ValueError('Принимающий участок должен быть взят из реестра подготовленной геометрии.')
        geometry_fields = {'receiver', 'discharge_coordinates', 'source_distance_m'}
        if any(getattr(self, key).basis != 'synthetic' for key in type(self).model_fields.keys() - geometry_fields):
            raise ValueError('Расходы, концентрации, гидрология, горизонт и режим учебного паспорта должны быть помечены как синтетические.')
        return self


class InputProvenance(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)

    schema_version: int = Field(ge=1, le=1)
    passport_id: str = Field(min_length=1, max_length=80, pattern=r'^[a-z0-9]+(?:-[a-z0-9]+)*$')
    kind: Literal['synthetic']
    fields: ProvenanceFields

    @model_validator(mode='after')
    def bounded_bytes(self):
        document = self.model_dump(mode='json')
        size = len(json.dumps(document, ensure_ascii=False).encode('utf-8'))
        # JSONB expands exponent notation in its text form, unlike json.dumps.
        for field in document['fields'].values():
            value = field['value']
            for number in value if isinstance(value, list) else [value]:
                if isinstance(number, float):
                    encoded = str(number)
                    size += max(0, len(format(Decimal(encoded), 'f')) - len(encoded))
        if size > INPUT_PROVENANCE_MAX_BYTES:
            raise ValueError(f'Сведения о происхождении условий превышают {INPUT_PROVENANCE_MAX_BYTES} байт.')
        return self
