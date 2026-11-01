import fs from 'node:fs';
import assert from 'node:assert/strict';
import { analyzeSeries } from '../src/controlPointAnalysis.ts';

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const report = input.indices.map((index, column) => {
  const reference = analyzeSeries(input.reference.map(row => row[0]), input.reference.map(row => row[column + 1]), input.threshold_mg_l);
  const saved = analyzeSeries(input.saved_times, input.saved_values.map(row => row[column]), input.threshold_mg_l);
  assert.equal(saved.maximum_mg_l, reference.maximum_mg_l, 'Extrema are mandatory real saved states');
  assert.equal(saved.first_maximum_hours, reference.first_maximum_hours);
  assert.equal(saved.exceedance_intervals.length, reference.exceedance_intervals.length);
  const intervals = saved.exceedance_intervals.map((period, i) => ({
    saved_start_hours: period.start_hours, reference_start_hours: reference.exceedance_intervals[i].start_hours,
    saved_end_hours: period.end_hours, reference_end_hours: reference.exceedance_intervals[i].end_hours,
    start_error_seconds: (period.start_hours - reference.exceedance_intervals[i].start_hours) * 3600,
    end_error_seconds: (period.end_hours - reference.exceedance_intervals[i].end_hours) * 3600,
  }));
  return { segment_number: index + 1, reference, saved, intervals,
    peak_amplitude_error_mg_l: saved.maximum_mg_l - reference.maximum_mg_l,
    peak_time_error_seconds: (saved.first_maximum_hours - reference.first_maximum_hours) * 3600,
    first_crossing_error_seconds: saved.first_crossing_hours === null || reference.first_crossing_hours === null ? null
      : (saved.first_crossing_hours - reference.first_crossing_hours) * 3600,
    total_duration_error_seconds: (saved.exceedance_duration_hours - reference.exceedance_duration_hours) * 3600 };
});
const output = { saved_states: input.saved_times.length, reference_states: input.reference.length,
  threshold_mg_l: input.threshold_mg_l, points: report };
if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify(output, null, 2));
