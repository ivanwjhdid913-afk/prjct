"""Versioned request/result for point inflows; no implicit migration of v1 physics."""
from typing import Literal
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from starlette.responses import JSONResponse
from app.multiple_transport import (simulate_multiple, validate_sources, build_grid,
    MULTIPLE_FORMAT_VERSION, MULTIPLE_MODEL_ID)
from app.river import prepared_reach
from app.transport import MAX_RESPONSE_BYTES, _resolution_limit

class SourceInterval(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True,allow_inf_nan=False)
    start_hours:float=Field(ge=0,le=48)
    end_hours:float=Field(gt=0,le=48)
    effluent_mg_l:float=Field(ge=0,le=10000)

class PydanticSource(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True,allow_inf_nan=False)
    id:str=Field(min_length=1,max_length=64,pattern='^[A-Za-z0-9_-]+$')
    name:str=Field(min_length=1,max_length=80)
    source_distance_m:float=Field(ge=0,le=20000)
    effluent_flow_m3_s:float=Field(ge=0,le=100)
    effluent_mg_l:float|None=Field(ge=0,le=10000)
    load_mode:Literal['continuous','finite','profile']
    load_duration_hours:float|None=Field(gt=0,le=48)
    load_intervals:list[SourceInterval]|None=Field(max_length=12)
    @field_validator('name',mode='before')
    @classmethod
    def trim_name(cls,value):
        if isinstance(value,str):
            if any(ord(c)<32 or 127<=ord(c)<=159 for c in value):
                raise ValueError('Название не должно содержать управляющих знаков.')
            return value.strip()
        return value

class MultipleSimulationRequest(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True,allow_inf_nan=False)
    river_flow_m3_s:float=Field(ge=.1,le=1000)
    background_mg_l:float=Field(ge=0,le=10000)
    velocity_m_s:float=Field(ge=.02,le=2)
    dispersion_m2_s:float=Field(ge=.1,le=100)
    duration_hours:float=Field(ge=.1,le=48)
    reach_id:str=Field(min_length=1,max_length=80)
    sources:list[PydanticSource]=Field(min_length=1,max_length=3)
    @model_validator(mode='after')
    def source_conditions(self):
        data=self.model_dump(exclude={'reach_id'})
        validate_sources(data|dict(length_m=20000.))
        return self

class MultipleSimulationResult(BaseModel):
    format_version:Literal[3]=MULTIPLE_FORMAT_VERSION
    model_id:Literal['conservative-1d-lateral-inflow-v2']=MULTIPLE_MODEL_ID
    inputs:dict
    derived:dict
    distances_m:list[float]
    times_hours:list[float]
    concentrations_mg_l:list[list[float]]
    scale_mg_l:list[float]
    geometry:dict
    diagnostics:dict
    temporal_resolution:dict
    provenance:Literal['river_scenario']='river_scenario'
    reach_id:str
    source_distance_m:float=0.
    source_coordinate:tuple[float,float]
    source_coordinates:list[dict]
    reach_metadata:dict
    segment_geometries:list[dict]

def validate_multiple_geometry(parameters:MultipleSimulationRequest):
    reach,line=prepared_reach(parameters.reach_id)
    physics=parameters.model_dump(exclude={'reach_id'})|dict(length_m=line.length_m)
    p=validate_sources(physics)
    grid=build_grid(p)
    if grid['buffer_m']>reach['metadata']['verified_downstream_m']:
        raise ValueError('Для этих параметров расчётный буфер выходит за проверенное продолжение русла. '
                         'Проверьте параметры потока; автоматической подмены нет.')
    return reach,line

def calculate_multiple(parameters:MultipleSimulationRequest)->JSONResponse:
    # Shared non-growing calculation gate with the legacy endpoint.
    from app.simulation import calculation_lock
    if not calculation_lock.acquire(blocking=False):
        raise HTTPException(503,'Другой расчёт ещё выполняется. Повторите попытку через несколько секунд.',headers={'Retry-After':'5'})
    try:
        reach,line=validate_multiple_geometry(parameters)
        physics=parameters.model_dump(exclude={'reach_id'})|dict(length_m=line.length_m)
        result=simulate_multiple(physics)
        result['inputs']['reach_id']=parameters.reach_id
        result.update(provenance='river_scenario',reach_id=reach['id'],source_distance_m=0.,source_coordinate=line.point_at(0.),
            source_coordinates=[dict(id=s.id,source_distance_m=s.source_distance_m,coordinate=line.point_at(s.source_distance_m)) for s in parameters.sources],
            reach_metadata=reach['metadata'],geometry=dict(type='LineString',coordinates=line.slice(0.,line.length_m)),
            segment_geometries=line.segments(0.,line.length_m))
        response=JSONResponse(MultipleSimulationResult(**result).model_dump(mode='json'))
        if len(response.body)>MAX_RESPONSE_BYTES:raise _resolution_limit(f'ответ превышает {MAX_RESPONSE_BYTES} байт.')
        return response
    except ValueError as error:
        raise HTTPException(422,str(error)) from None
    finally:calculation_lock.release()
