import math

import pytest

from app.transport import _profile_steps, simulate, validate_parameters


BASE = dict(river_flow_m3_s=10., effluent_flow_m3_s=.1, background_mg_l=10.,
            effluent_mg_l=100., velocity_m_s=.25, dispersion_m2_s=5.,
            length_m=10000., duration_hours=6.)


def interval(start, end, concentration):
    return dict(start_hours=start, end_hours=end, effluent_mg_l=concentration)


def profile(*rows, **changes):
    return BASE | dict(load_mode='profile', load_intervals=list(rows)) | changes


@pytest.mark.parametrize('rows,legacy', [
    ([interval(0., 6., 100.)], {}),
    ([interval(0., .513579, 100.)], dict(load_mode='finite', load_duration_hours=.513579)),
])
def test_single_interval_reproduces_legacy_states_bit_for_bit(rows, legacy):
    expected = simulate(BASE | legacy)
    actual = simulate(profile(*rows))
    for field in ('times_hours', 'concentrations_mg_l', 'scale_mg_l'):
        assert actual[field] == expected[field]
    assert actual['inputs']['load_intervals'] == rows
    assert all(actual['derived'][key] is None for key in ('load_kg_s', 'excess_load_kg_s', 'steady_mg_l'))


@pytest.mark.parametrize('rows', [
    [interval(.123456789, .512345678, 100.), interval(2.123456789, 2.512345678, 60.)],
    [interval(0., .5, 100.), interval(.5, 1., 60.)],
    [interval(0., .5, 0.), interval(2., 2.5, 20.)],
    [],
])
def test_exact_events_signed_mass_positivity_and_full_profile(rows):
    result = simulate(profile(*rows))
    times = result['times_hours']
    assert times[0] == 0 and times[-1] == 6
    assert all(0 <= a < b <= 6 for a, b in zip(times, times[1:]))
    assert {v for row in rows for v in (row['start_hours'], row['end_hours'])} <= set(times)
    expected = .1 / 1000 * math.fsum((r['effluent_mg_l'] - 10) * (r['end_hours'] - r['start_hours']) * 3600 for r in rows)
    diagnostic = result['diagnostics']
    assert diagnostic['excess_incoming_kg'] == pytest.approx(expected, abs=1e-12)
    assert diagnostic['relative_excess_mass_error'] < 1e-10
    assert abs(diagnostic['excess_mass_error_kg']) < 1e-9
    assert min(map(min, result['concentrations_mg_l'])) >= 0
    assert result['inputs']['load_intervals'] == rows


@pytest.mark.parametrize('change', [dict(effluent_flow_m3_s=0.), dict(background_mg_l=100., effluent_mg_l=5.)])
def test_zero_flow_and_background_profile(change):
    cb = change.get('background_mg_l', 10.)
    result = simulate(profile(interval(.1, 1., cb), **change))
    assert result['concentrations_mg_l'] == [[cb] * 100] * len(result['times_hours'])
    assert result['diagnostics']['excess_incoming_kg'] == 0


@pytest.mark.parametrize('rows', [
    [interval(1., 2., 20.), interval(.5, .8, 30.)],
    [interval(0., 2., 20.), interval(1., 3., 30.)],
    [interval(-.1, 1., 20.)], [interval(0., 7., 20.)], [interval(1., 1., 20.)],
    [interval(0., 1., 10001.)], [interval(0., 1., math.inf)],
    [interval(i / 10, (i + .5) / 10, 20.) for i in range(13)],
])
def test_invalid_profiles_rejected_by_pure_solver(rows):
    with pytest.raises(ValueError):
        validate_parameters(profile(*rows))


@pytest.mark.parametrize('mode,rows', [('profile', None), ('continuous', []), ('finite', [])])
def test_mode_requires_explicit_profile_only(mode, rows):
    with pytest.raises(ValueError):
        validate_parameters(BASE | dict(load_mode=mode, load_intervals=rows, load_duration_hours=.5 if mode == 'finite' else None))


def test_twelve_intervals_and_resource_budget(monkeypatch):
    import app.transport as transport
    rows = [interval(i * .4, i * .4 + .1, 20. + i) for i in range(12)]
    result = simulate(profile(*rows))
    assert result['diagnostics']['steps'] + 1 == result['temporal_resolution']['reference_states']
    assert result['diagnostics']['cell_updates'] == result['diagnostics']['steps'] * result['diagnostics']['cells']
    monkeypatch.setattr(transport, 'MAX_STEPS', result['diagnostics']['steps'] - 1)
    with pytest.raises(ValueError, match='Слишком большой'):
        simulate(profile(*rows))


def test_nominal_cost_is_rejected_before_allocating_profile_schedule(monkeypatch):
    import app.transport as transport
    def forbidden(*args):
        pytest.fail('Profile schedule must not be allocated for an already over-budget grid')
    monkeypatch.setattr(transport, '_profile_steps', forbidden)
    with pytest.raises(ValueError, match='Слишком большой'):
        simulate(profile(interval(0., .5, 100.), length_m=20000., velocity_m_s=2.,
                         dispersion_m2_s=.1, duration_hours=48.))


def test_every_resolved_local_extremum_is_a_saved_solver_state():
    reference = []
    result = simulate(profile(interval(0., .5, 100.), interval(2., 2.5, 60.)),
                      reference_callback=lambda t, v: reference.append((t, v.copy())))
    saved = dict(zip(result['times_hours'], result['concentrations_mg_l']))
    count = 0
    for j in range(100):
        direction = 0
        previous_change = None
        for i in range(1, len(reference)):
            delta = reference[i][1][j] - reference[i - 1][1][j]
            sign = (delta > 0) - (delta < 0)
            if sign and direction and sign != direction:
                t, row = reference[i - 1]
                assert t in saved
                assert saved[t] == row
                count += 1
            if sign:
                direction = sign
    assert count > 100
    assert len(saved) <= 2048


@pytest.mark.anyio
async def test_api_profile_row_location_and_result(client):
    body = profile(interval(0., 2., 20.), interval(1., 3., 30.))
    response = await client.post('/api/v1/simulations', json=body)
    assert response.status_code == 422
    assert any(error['loc'][:3] == ['body', 'load_intervals', 1] for error in response.json()['detail'])
    response = await client.post('/api/v1/simulations', json=profile(interval(0., .5, 100.), interval(2., 2.5, 60.)))
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['inputs']['load_intervals'] == profile(interval(0., .5, 100.), interval(2., 2.5, 60.))['load_intervals']
    assert result['derived']['steady_mg_l'] is None


@pytest.mark.anyio
@pytest.mark.parametrize('mode', ['continuous', 'finite'])
async def test_version_two_api_explicit_null_profile_for_legacy_modes(client, mode):
    body = BASE | dict(load_mode=mode, load_duration_hours=.5 if mode == 'finite' else None)
    response = await client.post('/api/v1/simulations', json=body)
    assert response.status_code == 200, response.text
    assert response.json()['format_version'] == 2
    assert 'load_intervals' in response.json()['inputs']
    assert response.json()['inputs']['load_intervals'] is None

@pytest.mark.parametrize('event', [math.nextafter(.125, 0), math.nextafter(.125, 1), .12345678901234567])
def test_near_cadence_fractional_boundaries_are_exact_and_strict(event):
    result = simulate(profile(interval(0., event, 100.), interval(.5, .7, 60.)))
    assert event in result['times_hours']
    assert all(a < b for a, b in zip(result['times_hours'], result['times_hours'][1:]))


def test_profile_ignores_scalar_and_scale_includes_every_inlet():
    rows = [interval(0., .5, 0.), interval(2., 2.5, 60.)]
    a = simulate(profile(*rows, effluent_mg_l=0.))
    b = simulate(profile(*rows, effluent_mg_l=10000.))
    assert a['concentrations_mg_l'] == b['concentrations_mg_l']
    assert a['scale_mg_l'] == pytest.approx([(10 * 10 + .1 * 0) / 10.1, (10 * 10 + .1 * 60) / 10.1])


@pytest.mark.parametrize('limit', ['MAX_REFERENCE_BYTES', 'MAX_OUTPUT_STATES', 'MAX_COMPRESSION_CHECKS'])
def test_profile_does_not_relax_output_resource_limits(monkeypatch, limit):
    import app.transport as transport
    monkeypatch.setattr(transport, limit, 1)
    with pytest.raises(ValueError, match='Недостаточное временное разрешение'):
        simulate(profile(interval(0., .5, 100.), interval(2., 2.5, 60.)))


def test_distinct_events_that_collapse_in_seconds_are_rejected_without_losing_a_pulse():
    start = .6455244639537675
    end = math.nextafter(start, math.inf)
    assert start < end and start * 3600 == end * 3600
    with pytest.raises(ValueError, match='машинной точностью'):
        simulate(profile(interval(start, end, 100.)))


def test_multiple_events_inside_one_nominal_step_and_touching_next_row_wins():
    assert _profile_steps(10., 2, [(1., 2., 3.), (2., 3., -4.), (4., 5., 6.)]) == [
        (1., 1., 0.), (1., 2., 3.), (1., 3., -4.), (1., 4., 0.),
        (1., 5., 6.), (5., 10., 0.), (10., 20., 0.)]


def test_prepared_don_demo_retains_both_peaks_at_every_segment():
    from app.river import prepared_reach
    length = prepared_reach()[0]['length_m']
    reference = []
    result = simulate(profile(interval(0., .5, 100.), interval(2., 2.5, 60.), length_m=length),
                      reference_callback=lambda t, row: reference.append((t, row.copy())))
    saved = dict(zip(result['times_hours'], result['concentrations_mg_l']))
    for j in range(100):
        peaks, direction = [], 0
        for i in range(1, len(reference)):
            delta = reference[i][1][j] - reference[i - 1][1][j]
            sign = (delta > 0) - (delta < 0)
            if sign < 0 and direction > 0 and reference[i - 1][1][j] - BASE['background_mg_l'] > 1e-6:
                peaks.append((reference[i - 1][0], reference[i - 1][1][j]))
            if sign:
                direction = sign
        assert len(peaks) == 2
        for time, amplitude in peaks:
            assert time in saved
            assert saved[time][j] == amplitude  # Zero loss, stronger than 2%.
