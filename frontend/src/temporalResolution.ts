export type TemporalResolution = {
  method: 'adaptive-step-states';
  saved_states: number;
  reference_states: number;
  max_states: number;
  interpolation_relative_tolerance: number;
  interpolation_absolute_tolerance_mg_l: number;
  max_relative_interpolation_error: number;
  reference_max_step_seconds: number;
  max_gap_seconds: number;
  memory_limit_bytes: number;
  reference_memory_bytes: number;
  max_response_bytes: number;
};

export function validTimes(times: unknown, duration: number): times is number[] {
  return Number.isFinite(duration) && duration > 0 && Array.isArray(times)
    && times.length >= 2 && times.length <= 2048
    && times[0] === 0 && times[times.length - 1] === duration
    && times.every((time, index) => typeof time === 'number' && Number.isFinite(time) && (index === 0 || time > times[index - 1]));
}

export function validTemporalResolution(value: unknown, states: number): value is TemporalResolution {
  if (!value || typeof value !== 'object') return false;
  const item = value as TemporalResolution;
  const numeric = ['saved_states', 'reference_states', 'max_states', 'interpolation_relative_tolerance', 'interpolation_absolute_tolerance_mg_l', 'max_relative_interpolation_error', 'reference_max_step_seconds', 'max_gap_seconds', 'memory_limit_bytes', 'reference_memory_bytes', 'max_response_bytes'] as const;
  return item.method === 'adaptive-step-states'
    && numeric.every(key => typeof item[key] === 'number' && Number.isFinite(item[key]) && item[key] >= 0)
    && item.saved_states === states && Number.isInteger(item.reference_states) && item.reference_states >= states
    && item.max_states === 2048 && states <= item.max_states
    && item.interpolation_relative_tolerance > 0 && item.reference_max_step_seconds > 0
    && item.max_relative_interpolation_error <= item.interpolation_relative_tolerance
    && item.reference_memory_bytes <= item.memory_limit_bytes;
}
