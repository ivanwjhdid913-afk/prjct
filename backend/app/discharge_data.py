"""Versioned documentary evidence. This router never supplies simulation inputs."""
from datetime import date
import json
from pathlib import Path
import re
from typing import Annotated, Literal
from urllib.parse import urlsplit

from fastapi import APIRouter
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator, model_validator


def nonempty(value: str) -> str:
    if not value.strip() or any(ord(c) < 32 and c not in '\n\t' for c in value):
        raise ValueError('Text must be nonempty and contain no control characters.')
    return value


Text = Annotated[str, AfterValidator(nonempty)]


def iso_date(value: str) -> str:
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise ValueError('Use a complete ISO calendar date, or null for an unknown publication day.')
    date.fromisoformat(value)
    return value


ISODate = Annotated[Text, AfterValidator(iso_date)]
MatrixKey = Literal['outfall_position', 'channel', 'river_flow', 'effluent_flow',
                    'background', 'substance_load', 'time_regime', 'velocity_dispersion', 'observations']
MATRIX_KEYS = set(MatrixKey.__args__)
REACH_IDS = {'don-olkhovets', 'voronezh-zheltye-peski'}
DATA_PATH = Path(__file__).resolve().parents[1] / 'data' / 'discharges' / 'catalog.v1.json'
router = APIRouter(prefix='/api/v1/discharge-data', tags=['discharge evidence'])


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, allow_inf_nan=False)


class Source(StrictModel):
    id: Text
    title: Text
    publisher: Text
    url: Text
    published_on: ISODate | None
    publication_note: Text
    checked_on: ISODate
    document_id: Text
    sha256: str | None = Field(pattern=r'^[0-9a-f]{64}$')
    acquisition: Text
    redistribution: Text

    @field_validator('url')
    @classmethod
    def safe_url(cls, value):
        parsed = urlsplit(value)
        if (parsed.scheme not in {'https', 'http'} or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or any(c.isspace() or ord(c) < 32 for c in value) or '\\' in value):
            raise ValueError('A credential-free HTTP(S) source URL is required.')
        # Accessing port also rejects malformed ports instead of passing them to browsers.
        parsed.port
        return value

    @model_validator(mode='after')
    def chronological(self):
        if self.published_on and self.published_on > self.checked_on:
            raise ValueError('Publication cannot follow source verification.')
        return self


class Coordinate(StrictModel):
    longitude: float = Field(ge=-180, le=180)
    latitude: float = Field(ge=-90, le=90)
    crs: Literal['EPSG:4326']
    kind: Literal['enterprise', 'outfall']
    description: Text
    source_id: Text
    locator: Text


class Quantity(StrictModel):
    parameter: Text
    value: float = Field(ge=0)
    unit: Text
    basis: Literal['actual', 'permitted', 'capacity', 'organisation_total']
    scope: Text


class Evidence(StrictModel):
    source_id: Text
    locator: Text
    statement: Text
    period: Text
    quantity: Quantity | None
    conversion: Text | None

    @field_validator('period')
    @classmethod
    def stated_period(cls, value):
        # Preserve documentary precision: a stated year/month is not January 1.
        years = re.findall(r'(?<!\d)(?:19|20)\d{2}(?!\d)', value)
        if not years:
            raise ValueError('Evidence needs a stated calendar period, not an unknown date.')
        range_pattern = r'((?:19|20)\d{2}(?:-\d{2}(?:-\d{2})?)?)\s*(?:[–—/]|\s-\s)\s*((?:19|20)\d{2}(?:-\d{2}(?:-\d{2})?)?)'
        for start, end in re.findall(range_pattern, value):
            if start > end:
                raise ValueError('Evidence period ends before it starts.')
        for day in re.findall(r'(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)', value):
            date.fromisoformat(day)
        for month in re.findall(r'(?<!\d)\d{4}-(\d{2})(?!\d)', value):
            if not 1 <= int(month) <= 12:
                raise ValueError('Invalid calendar month.')
        return value


class Cell(StrictModel):
    status: Literal['missing', 'partial', 'available', 'not_applicable']
    note: Text
    source_ids: list[Text]

    @model_validator(mode='after')
    def supported(self):
        if len(self.source_ids) != len(set(self.source_ids)):
            raise ValueError('Duplicate matrix references.')
        if self.status in {'available', 'partial'} and not self.source_ids:
            raise ValueError('Available or partial data must identify its source.')
        return self


class PreparedReach(StrictModel):
    status: Literal['not_established', 'outside', 'matched']
    reach_id: Text | None
    explanation: Text

    @model_validator(mode='after')
    def consistent_reference(self):
        if self.status == 'matched':
            if self.reach_id not in REACH_IDS:
                raise ValueError('Matched reach must exist in the prepared registry.')
        elif self.reach_id is not None:
            raise ValueError('Unmatched evidence must not select a substitute reach.')
        return self


class Item(StrictModel):
    id: Text
    name: Text
    kind: Text
    location_description: Text
    receiver: Text | None
    receiver_note: Text
    discharge_summary: Text
    coordinates: Coordinate | None
    evidence: list[Evidence] = Field(min_length=1)
    missing: list[Text]
    readiness: Literal['insufficient', 'assumptions', 'ready']
    readiness_reason: Text
    prepared_reach: PreparedReach
    matrix: dict[MatrixKey, Cell]

    @model_validator(mode='after')
    def sufficient_evidence(self):
        if set(self.matrix) != MATRIX_KEYS:
            raise ValueError('The nine readiness dimensions must all be explicit.')
        is_outfall = self.coordinates is not None and self.coordinates.kind == 'outfall'
        if self.prepared_reach.status == 'matched' and not is_outfall:
            raise ValueError('An enterprise position or absent position cannot establish an outfall match.')
        if self.matrix['outfall_position'].status == 'available' and not is_outfall:
            raise ValueError('Available outfall position requires a documented outfall coordinate.')
        if self.readiness == 'ready':
            if (self.missing or self.prepared_reach.status != 'matched'
                    or any(cell.status not in {'available', 'not_applicable'} for cell in self.matrix.values())):
                raise ValueError('Ready requires complete evidence and a verified prepared reach.')
        return self


class Catalog(StrictModel):
    format_version: Literal[1]
    checked_on: ISODate
    sources: list[Source] = Field(min_length=1)
    items: list[Item] = Field(min_length=1)

    @field_validator('format_version', mode='before')
    @classmethod
    def integer_version(cls, value):
        if type(value) is not int:
            raise ValueError('Version must be an integer.')
        return value

    @model_validator(mode='after')
    def unique_and_resolved(self):
        source_ids = [source.id for source in self.sources]
        item_ids = [item.id for item in self.items]
        if len(source_ids) != len(set(source_ids)) or len(item_ids) != len(set(item_ids)):
            raise ValueError('Catalog source and item IDs must be unique.')
        known = set(source_ids)
        for source in self.sources:
            if source.checked_on > self.checked_on:
                raise ValueError('Source verification cannot follow catalog verification.')
        for item in self.items:
            refs = [e.source_id for e in item.evidence]
            refs.extend(ref for cell in item.matrix.values() for ref in cell.source_ids)
            if item.coordinates:
                refs.append(item.coordinates.source_id)
            if not set(refs) <= known:
                raise ValueError('Every evidence, coordinate and matrix reference must resolve.')
            if any(int(year) > int(self.checked_on[:4]) for evidence in item.evidence
                   for year in re.findall(r'(?<!\d)(?:19|20)\d{2}(?!\d)', evidence.period)):
                raise ValueError('Evidence period cannot follow catalog verification.')
            for evidence in item.evidence:
                for day in re.findall(r'(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)', evidence.period):
                    if day > self.checked_on:
                        raise ValueError('Evidence date cannot follow catalog verification.')
                for month in re.findall(r'(?<!\d)\d{4}-\d{2}(?!\d)', evidence.period):
                    if month > self.checked_on[:7]:
                        raise ValueError('Evidence month cannot follow catalog verification.')
        return self


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON object keys are not allowed.')
        result[key] = value
    return result


def load_catalog() -> Catalog:
    return Catalog.model_validate(json.loads(DATA_PATH.read_text(encoding='utf-8'), object_pairs_hook=unique_object))


@router.get('', response_model=Catalog)
def get_discharge_data() -> Catalog:
    return load_catalog()
