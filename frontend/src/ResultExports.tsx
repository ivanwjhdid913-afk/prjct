import { useState } from 'react';
import { buildResultCsv, downloadText, type ExportResult } from './resultExport';
type Props = { result: ExportResult | null; a: ExportResult | null; b: ExportResult | null; hour: number; selected: number };
export default function ResultExports({ result, a, b, hour, selected }: Props) {
  const [message, setMessage] = useState('');
  function save(kind: 'space' | 'time') {
    if (!result) return;
    try {
      const csv = buildResultCsv({ result, a, b, hour, selected, kind });
      const reach = String((a && b ? a : result).reach_id ?? 'synthetic').replace(/[^a-zA-Z0-9_-]/g, '-');
      downloadText(csv, `${a && b ? 'comparison' : 'scenario'}-${kind === 'space' ? `cx-${hour}h` : `ct-segment-${selected + 1}`}-${reach}.csv`, 'text/csv;charset=utf-8');
      setMessage('Выгружен завершённый расчёт. Условия формы не использованы.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Не удалось подготовить CSV.'); }
  }
  return <details className="result-exports"><summary>Экспорт численных результатов</summary>
    <p>{result ? 'Завершённый расчёт: средние концентрации сегментов. C(x) — выбранное время, C(t) — вся сохранённая история. Сведения об условиях и версиях включены в строку metadata JSON.' : 'Выгрузка CSV доступна после завершения расчёта.'}</p>
    <div><button type="button" disabled={!result} onClick={() => save('space')}>Скачать C(x) CSV</button><button type="button" disabled={!result} onClick={() => save('time')}>Скачать C(t) CSV</button></div>
    {a && b && <p>А, Б и Б−А; история — объединение времён обеих сеток с независимой интерполяцией. Выгрузка не зависит от выбранной страницы таблицы.</p>}
    <p role="status">{message}</p>
  </details>;
}
