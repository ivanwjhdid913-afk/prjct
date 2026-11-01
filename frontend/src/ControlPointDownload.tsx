import { useState } from "react";
import type { AnalysisSettings } from "./analysisSettings";
import type { MultipleResult } from "./multipleSources";
import { buildControlPointCsv } from "./controlPointExport";
import { downloadText } from "./resultExport";

export default function ControlPointDownload({
  result,
  a,
  b,
  settings,
  hour,
}: {
  result: MultipleResult | null;
  a: MultipleResult | null;
  b: MultipleResult | null;
  settings: AnalysisSettings;
  hour: number;
}) {
  const [message, setMessage] = useState("");
  function download() {
    if (!result) return;
    try {
      const csv = buildControlPointCsv({ result, a, b, settings, hour });
      downloadText(csv, "control-points.csv", "text/csv;charset=utf-8");
      setMessage(
        "Выгружен завершённый расчёт и применённые настройки анализа. Черновики не использованы.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Не удалось подготовить CSV.",
      );
    }
  }
  return (
    <div className="control-point-download">
      <button
        type="button"
        disabled={!result || !settings.points.length}
        onClick={download}
      >
        Скачать итоги контрольных точек CSV
      </button>
      <p role="status">{message}</p>
    </div>
  );
}
