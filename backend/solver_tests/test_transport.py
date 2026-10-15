"""Numerical checks independent of the API, database and map."""
import importlib.util
import math

import pytest


DEMO = dict(river_flow_m3_s=10., effluent_flow_m3_s=.1, background_mg_l=10.,
            effluent_mg_l=100., velocity_m_s=.25, dispersion_m2_s=5.,
            length_m=10000., duration_hours=24.)


def core():
    assert importlib.util.find_spec('app.transport'), 'Independent transport solver is missing'
    from app import transport
    return transport


@pytest.fixture(scope='module')
def demo():
    return core().simulate(DEMO)


def test_units_shape_and_steady_limit(demo):
    d = demo['derived']
    assert d['total_flow_m3_s'] == pytest.approx(10.1)
    assert d['area_m2'] == pytest.approx(40.4)
    assert d['load_kg_s'] == pytest.approx(.01)
    assert d['excess_load_kg_s'] == pytest.approx(.009)
    assert d['steady_mg_l'] == pytest.approx(110 / 10.1)
    assert d['travel_hours'] == pytest.approx(10000 / .25 / 3600)
    assert len(demo['times_hours']) == 49
    assert demo['times_hours'][0] == 0 and demo['times_hours'][-1] == 24
    assert demo['distances_m'] == [50 + 100 * i for i in range(100)]
    assert all(len(row) == 100 for row in demo['concentrations_mg_l'])
    assert max(abs(c - d['steady_mg_l']) for c in demo['concentrations_mg_l'][-1]) < 1e-6
    assert demo['scale_mg_l'] == pytest.approx([10, d['steady_mg_l']])


def test_total_and_excess_mass_balance(demo):
    diag = demo['diagnostics']
    assert diag['relative_mass_error'] < 1e-9
    assert diag['relative_excess_mass_error'] < 1e-9
    assert diag['cell_peclet'] <= .5 + 1e-12
    assert diag['cell_updates'] <= 20_000_000


@pytest.mark.parametrize('change', [{'effluent_flow_m3_s': 0}, {'effluent_mg_l': 10}])
def test_no_source_preserves_background(change):
    r = core().simulate(DEMO | change | {'duration_hours': 1})
    assert all(c == 10 for row in r['concentrations_mg_l'] for c in row)


@pytest.mark.parametrize('field,value', [('river_flow_m3_s', 0), ('effluent_flow_m3_s', -1),
    ('background_mg_l', -1), ('effluent_mg_l', math.inf), ('velocity_m_s', math.nan),
    ('dispersion_m2_s', 0), ('length_m', 20001), ('duration_hours', 49),
    ('river_flow_m3_s', True), ('length_m', '1000')])
def test_invalid_inputs(field, value):
    with pytest.raises(ValueError):
        core().simulate(DEMO | {field: value})


def test_cost_limit_precedes_solving():
    with pytest.raises(ValueError, match='размер|вычислен|шаг|сетка'):
        core().simulate(DEMO | dict(velocity_m_s=2, dispersion_m2_s=.1, length_m=20000))


def test_missing_and_unknown_parameters():
    with pytest.raises(ValueError):
        core().simulate({})
    with pytest.raises(ValueError):
        core().simulate(DEMO | {'surprise': 1})


def test_unrepresentable_integer_is_a_validation_error():
    with pytest.raises(ValueError):
        core().simulate(DEMO | {'river_flow_m3_s': 10**1000})


def test_clean_effluent_stays_nonnegative():
    r = core().simulate(DEMO | dict(background_mg_l=1, effluent_mg_l=0,
                                   effluent_flow_m3_s=10, duration_hours=2))
    assert all(.5 - 1e-12 <= c <= 1 + 1e-12 for row in r['concentrations_mg_l'] for c in row)
