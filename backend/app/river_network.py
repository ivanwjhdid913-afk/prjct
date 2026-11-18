"""Finite volume transport on a directed, positive-flow river tree."""
from collections import defaultdict, deque
from copy import deepcopy
import hashlib
from math import ceil, fsum, isfinite, ulp
import json
from pathlib import Path
from threading import Lock
from typing import Literal
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator
from app.confluence import _ConfluenceRoute, _MassHistory, SimulationLimit
from app.river import MeasuredLine
MODEL_ID = 'conservative-1d-network-v1'
router = APIRouter(prefix='/api/v1/river-networks', tags=['river networks'], route_class=_ConfluenceRoute)
_slot = Lock()

class StrictInputs(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, allow_inf_nan=False)

class Headwater(StrictInputs):
    node_id: str = Field(min_length=1, max_length=80)
    flow_m3_s: float = Field(ge=0.1, le=100)
    concentration_mg_l: float = Field(ge=0, le=10000)

class Hydraulics(StrictInputs):
    reach_id: str = Field(min_length=1, max_length=80)
    velocity_m_s: float = Field(ge=0.05, le=5)
    dispersion_m2_s: float = Field(ge=0, le=100)

class Source(StrictInputs):
    reach_id: str = Field(min_length=1, max_length=80)
    distance_m: float = Field(ge=0, le=100000)
    flow_m3_s: float = Field(ge=0, le=100)
    concentration_mg_l: float = Field(ge=0, le=10000)
    load_duration_hours: float | None = Field(gt=0, le=24)

class Provenance(StrictInputs):
    hydraulics: Literal['synthetic']
    load: Literal['synthetic']

class Inputs(StrictInputs):
    network_id: str = Field(min_length=1, max_length=80)
    geometry_sha256: str = Field(pattern='^[0-9a-f]{64}$')
    background_mg_l: float = Field(ge=0, le=10000)
    duration_hours: float = Field(gt=0, le=24)
    headwaters: list[Headwater] = Field(min_length=1, max_length=16)
    hydraulics: list[Hydraulics] = Field(min_length=1, max_length=32)
    source: Source
    provenance: Provenance

    @model_validator(mode='after')
    def unique(self):
        if len({h.node_id for h in self.headwaters}) != len(self.headwaters):
            raise ValueError('Повторяется верхняя граница сети.')
        if len({h.reach_id for h in self.hydraulics}) != len(self.hydraulics):
            raise ValueError('Повторяются параметры участка.')
        if self.source.load_duration_hours is not None and self.source.load_duration_hours > self.duration_hours:
            raise ValueError('Длительность нагрузки превышает горизонт расчёта.')
        return self

def load_network(network_id='kuzminka-v1'):
    if network_id != 'kuzminka-v1':
        raise ValueError('Неизвестная речная сеть.')
    path = Path(__file__).resolve().parents[1] / 'data' / 'networks' / 'kuzminka-v1.json'
    network = json.loads(path.read_text(encoding='utf-8'))
    payload = {key: network[key] for key in ('nodes', 'reaches')}
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()).hexdigest()
    if digest != network['metadata']['geometry_sha256']:
        raise ValueError('Контрольная сумма геометрии сети изменилась.')
    network['geometry_sha256'] = network['metadata']['geometry_sha256']
    topology(network)
    return network

def topology(network):
    nodes = {n['id']: n for n in network['nodes']}
    reaches = {r['id']: r for r in network['reaches']}
    if len(nodes) != len(network['nodes']) or len(reaches) != len(network['reaches']):
        raise ValueError('Повторяется идентификатор элемента сети.')
    incoming, outgoing = (defaultdict(list), defaultdict(list))
    for rid, r in reaches.items():
        a, b = (r['from_node'], r['to_node'])
        if a not in nodes or b not in nodes or a == b:
            raise ValueError('Недопустимое направление или узел участка.')
        line = MeasuredLine(r['geometry']['coordinates'])
        if (r['geometry'].get('type') != 'LineString'
                or abs(line.length_m - r['length_m']) > 0.01
                or line.coordinates[0] != nodes[a]['coordinate']
                or line.coordinates[-1] != nodes[b]['coordinate']):
            raise ValueError('Геометрия участка не соответствует узлам или измеренной длине.')
        incoming[b].append(rid)
        outgoing[a].append(rid)
    if any((len(outgoing[n]) > 1 for n in nodes)):
        raise ValueError('Разветвления потока не поддерживаются.')
    degree = {n: len(incoming[n]) for n in nodes}
    if any((not incoming[n] and (not outgoing[n]) for n in nodes)):
        raise ValueError('Изолированные узлы не поддерживаются.')
    queue = deque((n for n in nodes if not degree[n]))
    order = []
    while queue:
        n = queue.popleft()
        order.append(n)
        for rid in outgoing[n]:
            end = reaches[rid]['to_node']
            degree[end] -= 1
            if not degree[end]:
                queue.append(end)
    if len(order) != len(nodes) or sum((not outgoing[n] for n in nodes)) != 1:
        raise ValueError('Нужна связная сеть без циклов с одним выходом.')
    return (nodes, reaches, incoming, outgoing, order)

def pilot_definition():
    network = load_network()
    _, reaches, incoming, outgoing, order = topology(network)
    source_reach = next((r for r in reaches.values() if r['from_node'] == order[0]))
    inputs = dict(
        network_id=network['id'], geometry_sha256=network['geometry_sha256'],
        background_mg_l=10, duration_hours=1.5,
        headwaters=[
            dict(node_id=n, flow_m3_s=8 if i == 0 else 2, concentration_mg_l=10)
            for i, n in enumerate(n for n in order if not incoming[n])
        ],
        hydraulics=[
            dict(reach_id=rid, velocity_m_s=0.4, dispersion_m2_s=1)
            for rid in reaches
        ],
        source=dict(
            reach_id=source_reach['id'], distance_m=source_reach['length_m'] / 2,
            flow_m3_s=0.5, concentration_mg_l=100, load_duration_hours=5 / 60,
        ),
        provenance=dict(hydraulics='synthetic', load='synthetic'),
    )
    return dict(network=network, defaults=inputs)

def solve(inputs: Inputs, *, network=None, target_cell_m=5.0, max_step_seconds=5.0, _max_steps=2500, _max_values=350000):
    network = deepcopy(network if network is not None else load_network(inputs.network_id))
    if network['id'] != inputs.network_id or network['geometry_sha256'] != inputs.geometry_sha256:
        raise ValueError('Геометрия сети изменилась. Загрузите параметры заново.')
    if not all((isfinite(v) and v > 0 for v in (target_cell_m, max_step_seconds))):
        raise ValueError('Шаги сетки и времени должны быть положительными конечными числами.')
    nodes, reaches, incoming, outgoing, order = topology(network)
    heads = {h.node_id: h for h in inputs.headwaters}
    hydraulics = {h.reach_id: h for h in inputs.hydraulics}
    if set(heads) != {n for n in nodes if not incoming[n]} or set(hydraulics) != set(reaches):
        raise ValueError('Задайте каждую верхнюю границу и гидравлику каждого участка ровно один раз.')
    source = inputs.source.model_copy()
    active_source = source.flow_m3_s > 0
    if source.reach_id not in reaches:
        raise ValueError('Участок источника отсутствует в сети.')
    lines = {rid: MeasuredLine(r['geometry']['coordinates']) for rid, r in reaches.items()}
    # Prepared lengths are rounded to micrometres for cross-platform checksums.
    # An explicitly selected advertised endpoint denotes the exact final vertex.
    if source.distance_m == reaches[source.reach_id]['length_m']:
        source.distance_m = lines[source.reach_id].length_m
    if source.distance_m > lines[source.reach_id].length_m:
        raise ValueError('Источник расположен за пределами участка.')
    node_flow = {}
    reach_flow = {}
    for n in order:
        node_flow[n] = heads[n].flow_m3_s if n in heads else fsum((reach_flow[r] for r in incoming[n]))
        for rid in outgoing[n]:
            reach_flow[rid] = node_flow[n] + (source.flow_m3_s if rid == source.reach_id else 0)
    reported_node_flow = dict(node_flow)
    source_start_node = None
    if source.distance_m == 0:
        source_start_node = reaches[source.reach_id]['from_node']
        reported_node_flow[source_start_node] += source.flow_m3_s
    cells = []
    indices = {}
    # The source is a face between two independent water volumes. Its added
    # water flow persists when its concentration returns to the background.
    for n in order:
        for rid in outgoing[n]:
            line = lines[rid]
            cuts = [0.0, line.length_m]
            if active_source and rid == source.reach_id and (0 < source.distance_m < line.length_m):
                cuts.insert(1, source.distance_m)
            ids = []
            for start, end in zip(cuts, cuts[1:]):
                if end - start < 1e-9:
                    raise SimulationLimit('Положение источника создаёт слишком малую ячейку для расчёта.')
                count = max(1, ceil((end - start) / target_cell_m - 1e-10))
                if len(cells) + count > 1200:
                    raise SimulationLimit('Сетка превышает предел 1200 ячеек.')
                dx = (end - start) / count
                for j in range(count):
                    left, right = (start + j * dx, end if j == count - 1 else start + (j + 1) * dx)
                    after = rid == source.reach_id and left >= source.distance_m - 1e-09
                    q = node_flow[n] + (source.flow_m3_s if after else 0)
                    h = hydraulics[rid]
                    ids.append(len(cells))
                    cells.append(dict(
                        reach=rid, left=left, right=right, dx=dx, q=q,
                        v=h.velocity_m_s, d=h.dispersion_m2_s,
                        volume=q / h.velocity_m_s * dx,
                    ))
            indices[rid] = ids
    faces = []

    def add_face(left, right, q, diff=0.0, head=None, source_here=False):
        faces.append(dict(left=left, right=right, q=q, diff=diff, head=head, source=source_here))

    def diffusive_conductance(left, right):
        if not left['d'] or not right['d']:
            return 0.0
        left_resistance = left['dx'] / (2 * left['q'] / left['v'] * left['d'])
        right_resistance = right['dx'] / (2 * right['q'] / right['v'] * right['d'])
        return 1 / (left_resistance + right_resistance)

    for rid, ids in indices.items():
        for left, right in zip(ids, ids[1:]):
            a, b = (cells[left], cells[right])
            at_source = active_source and rid == source.reach_id and (abs(b['left'] - source.distance_m) < 1e-08)
            conductance = 0.0 if at_source else diffusive_conductance(a, b)
            add_face(left, right, a['q'], conductance, source_here=at_source)
    for n in order:
        ins = [indices[r][-1] for r in incoming[n]]
        outs = [indices[r][0] for r in outgoing[n]]
        if not ins:
            right = outs[0]
            at_source = active_source and cells[right]['reach'] == source.reach_id and (source.distance_m == 0)
            add_face(None, right, node_flow[n], head=n, source_here=at_source)
        elif not outs:
            for i in ins:
                at_source = cells[i]['reach'] == source.reach_id and source.distance_m == lines[source.reach_id].length_m
                add_face(i, None, cells[i]['q'], source_here=at_source)
        else:
            right = outs[0]
            at_start = active_source and cells[right]['reach'] == source.reach_id and (source.distance_m == 0)
            at_end = active_source and any((cells[i]['reach'] == source.reach_id and source.distance_m == lines[source.reach_id].length_m for i in ins))
            if len(ins) == 1 and (not at_start) and (not at_end):
                a, b = (cells[ins[0]], cells[right])
                diffusion = diffusive_conductance(a, b)
                add_face(ins[0], right, a['q'], diffusion)
            else:
                for i in ins:
                    add_face(i, right, cells[i]['q'])
                if at_start or at_end:
                    # Shared incoming node fluxes enter once. Attach the one
                    # source contribution to exactly one receiving face.
                    faces[-1]['source'] = True
    rates = [0.0] * len(cells)
    for f in faces:
        if f['left'] is not None:
            rates[f['left']] += (f['q'] + f['diff']) / cells[f['left']]['volume']
        if f['right'] is not None:
            rates[f['right']] += f['diff'] / cells[f['right']]['volume']
    step = min(max_step_seconds, 0.9 / max(rates))
    cutoff = source.load_duration_hours or inputs.duration_hours
    events = sorted({0.0, cutoff, inputs.duration_hours})
    schedule = [(a, b, max(1, ceil((b - a) * 3600 / step))) for a, b in zip(events, events[1:])]
    frames = 1 + sum((k for _, _, k in schedule))
    if frames > _max_steps + 1 or frames * (len(cells) + len(nodes) + 5) > _max_values:
        raise SimulationLimit('Расчёт превышает предел шагов или размера ответа. Уменьшите горизонт расчёта.')
    bg = inputs.background_mg_l

    def absolute(c):
        value = bg + c
        if value < -8 * ulp(bg):
            raise ArithmeticError('Отрицательная полная концентрация превысила допуск округления.')
        return max(0.0, value)
    # Only output concentrations receive the 8-ULP zero-roundoff treatment.
    # Signed cell anomalies remain the source of all fluxes and mass balances.
    state = [0.0] * len(cells)

    def node_concentration(node, time):
        source_active = source.load_duration_hours is None or time < cutoff
        current_source_flux = source.flow_m3_s * (source.concentration_mg_l - bg) if source_active else 0.0
        if node in heads:
            flux = heads[node].flow_m3_s * (heads[node].concentration_mg_l - bg)
        else:
            flux = fsum(
                cells[indices[r][-1]]['q'] * state[indices[r][-1]]
                for r in incoming[node]
            )
            if source.reach_id in incoming[node] and source.distance_m == lines[source.reach_id].length_m:
                flux += current_source_flux
        if node == source_start_node:
            flux += current_source_flux
        return absolute(flux / reported_node_flow[node])

    histories = {rid: [[bg] * len(ids)] for rid, ids in indices.items()}
    node_history = {n: [node_concentration(n, 0.0)] for n in nodes}
    balance = _MassHistory.initialized()
    times = [0.0]
    for start, end, count in schedule:
        source_flux = source.flow_m3_s * (source.concentration_mg_l - bg) if start < cutoff else 0.0
        for j in range(1, count + 1):
            time = end if j == count else start + (end - start) * j / count
            dt = (time - times[-1]) * 3600
            changes = [0.0] * len(cells)
            entry = source_flux
            exit_flux = 0.0
            for face in faces:
                left, right = (face['left'], face['right'])
                upstream = state[left] if left is not None else heads[face['head']].concentration_mg_l - bg
                downstream = state[right] if right is not None else upstream
                flux = face['q'] * upstream + face['diff'] * (upstream - downstream)
                if left is not None:
                    changes[left] -= flux
                else:
                    entry += flux
                if face['source']:
                    flux += source_flux
                if right is not None:
                    changes[right] += flux
                else:
                    exit_flux += flux
            state = [c + dt * change / cell['volume'] for c, change, cell in zip(state, changes, cells)]
            for rid, ids in indices.items():
                histories[rid].append([absolute(state[i]) for i in ids])
            for n in nodes:
                node_history[n].append(node_concentration(n, time))
            stored = fsum(c * cell['volume'] for c, cell in zip(state, cells)) * 0.001
            balance.integrate(entry * dt * 0.001, exit_flux * dt * 0.001, stored)
            times.append(time)
    series = [row for frames in histories.values() for row in frames]
    series.extend(node_history.values())
    scale = [min(map(min, series)), max(map(max, series))]
    reach_results = []
    for rid, ids in indices.items():
        reach_results.append(dict(
            id=rid,
            distances_m=[(cells[i]['left'] + cells[i]['right']) / 2 for i in ids],
            segment_geometries=[
                dict(type='LineString', coordinates=lines[rid].slice(cells[i]['left'], cells[i]['right']))
                for i in ids
            ],
            flows_m3_s=[cells[i]['q'] for i in ids],
            concentrations_mg_l=histories[rid],
        ))
    return dict(
        model_id=MODEL_ID, format_version=1, network=network,
        inputs=inputs.model_dump(), times_hours=times, scale_mg_l=scale,
        source_coordinate=lines[source.reach_id].point_at(source.distance_m),
        reaches=reach_results,
        nodes=[
            dict(id=n, flow_m3_s=reported_node_flow[n], concentrations_mg_l=node_history[n])
            for n in nodes
        ],
        balance_kg=vars(balance),
        diagnostics=dict(
            cells=len(cells), steps=frames - 1, max_step_seconds=step,
            serial_dispersion='shared_flux', confluence_dispersion='zero_flux',
            mass_reference='background',
        ),
    )

@router.get('/pilot')
def get_pilot():
    return pilot_definition()

@router.post('/simulations')
def simulate(inputs: Inputs):
    if not _slot.acquire(blocking=False):
        raise HTTPException(503, 'Решатель сети занят. Повторите запрос.', headers={'Retry-After': '2'})
    try:
        response = JSONResponse(solve(inputs))
        if len(response.body) > 12 * 1024 * 1024:
            raise SimulationLimit('Результат сети превышает предел 12 МиБ.')
        return response
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    finally:
        _slot.release()
