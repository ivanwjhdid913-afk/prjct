import { summarizeControlPoints, valueAtTime } from "./controlPointAnalysis";
import {
  validAnalysisSettings,
  type AnalysisSettings,
} from "./analysisSettings";
import type { ExportResult } from "./resultExport";

type Selection = {
  result: ExportResult;
  a?: ExportResult | null;
  b?: ExportResult | null;
  settings: AnalysisSettings;
  hour: number;
};
function cell(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("Неконечное число в аналитике.");
  // User-controlled strings must remain text in spreadsheet software.
  const raw = String(value);
  const text =
    typeof value === "string" && /^\s*[=+@-]/.test(raw) ? `'${raw}` : raw;
  return /[,"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function buildControlPointCsv({
  result,
  a,
  b,
  settings,
  hour,
}: Selection): string {
  if (!validAnalysisSettings(settings))
    throw new Error("Примените допустимые настройки анализа.");
  const scenarios =
    a && b
      ? [
          { label: "A", result: a },
          { label: "B", result: b },
        ]
      : [{ label: "result", result }];
  if (!Number.isFinite(hour) || hour < 0 || hour > result.inputs.duration_hours)
    throw new Error("Некорректное время.");
  if (
    a &&
    b &&
    (a.model_id !== b.model_id ||
      a.reach_id !== b.reach_id ||
      a.inputs.length_m !== b.inputs.length_m ||
      a.inputs.duration_hours !== b.inputs.duration_hours ||
      a.reach_metadata?.geometry_sha256 !== b.reach_metadata?.geometry_sha256 ||
      a.reach_metadata?.downstream_geometry_sha256 !== b.reach_metadata?.downstream_geometry_sha256 ||
      JSON.stringify(a.distances_m) !== JSON.stringify(b.distances_m))
  ) {
    throw new Error(
      "Анализ А/Б требует одинаковую геометрию, модель и горизонт.",
    );
  }
  const columns = [
    "record_type",
    "scenario",
    "point_id",
    "point_name",
    "segment_number",
    "segment_start_m",
    "segment_center_m",
    "segment_end_m",
    "threshold_mg_l",
    "current_time_hours",
    "current_mg_l",
    "maximum_mg_l",
    "minimum_mg_l",
    "first_maximum_hours",
    "first_crossing_hours",
    "initially_exceeding",
    "total_exceedance_hours",
    "interval_start_hours",
    "interval_end_hours",
    "start_inclusive",
    "end_inclusive",
    "continues_at_end",
    "metadata_json",
  ];
  const metadata = {
    analysis_csv_version: 1,
    threshold_rule: "C(t) > threshold_mg_l",
    interpolation: "linear_between_actual_saved_states",
    concentration: "calculated_segment_mean_not_observation",
    time_unit: "hours",
    distance_unit: "m_from_reach_start",
    concentration_unit: "mg/l",
    analysis_settings: settings,
    limitations:
      "Storage tolerance does not bound crossing-time error. No extrapolation or field validation.",
    scenarios: scenarios.map(({ label, result: snapshot }) => ({
      label,
      model_id: snapshot.model_id,
      format_version: snapshot.format_version,
      reach_id: snapshot.reach_id,
      reach_metadata: snapshot.reach_metadata,
      inputs: snapshot.inputs,
      temporal_resolution: snapshot.temporal_resolution,
    })),
  };
  const rows: unknown[][] = [
    columns,
    [
      "metadata",
      ...Array(columns.length - 2).fill(""),
      JSON.stringify(metadata),
    ],
  ];
  for (const { label, result: snapshot } of scenarios) {
    for (const summary of summarizeControlPoints(snapshot, settings)) {
      const { point, metrics } = summary;
      const common = [
        label,
        point.id,
        point.name,
        summary.segment_number,
        summary.segment_start_m,
        summary.segment_center_m,
        summary.segment_end_m,
        settings.threshold_mg_l,
      ];
      const current = valueAtTime(
        snapshot.times_hours,
        snapshot.concentrations_mg_l.map((row) => row[point.segment_index]),
        hour,
      );
      rows.push([
        "summary",
        ...common,
        hour,
        current,
        metrics.maximum_mg_l,
        metrics.minimum_mg_l,
        metrics.first_maximum_hours,
        metrics.first_crossing_hours,
        metrics.initially_exceeding,
        metrics.exceedance_duration_hours,
        "",
        "",
        "",
        "",
        "",
        "",
      ]);
      for (const interval of metrics.exceedance_intervals) {
        rows.push([
          "interval",
          ...common,
          ...Array(8).fill(""),
          interval.start_hours,
          interval.end_hours,
          interval.start_inclusive,
          interval.end_inclusive,
          interval.continues_at_end,
          "",
        ]);
      }
    }
  }
  return rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
