import { useId, useLayoutEffect, useRef } from 'react';
import { intervalDrafts, validateIntervalDraft, type IntervalDraft } from './loadProfileDraft';
import './loadProfileEditor.css';

type Props = { rows: IntervalDraft[]; onChange: (rows: IntervalDraft[]) => void; duration: number };

export default function LoadProfileEditor({ rows, onChange, duration }: Props) {
  const id = useId();
  const details = useRef<HTMLDetailsElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const startFields = useRef(new Map<string, HTMLInputElement>());
  const pendingFocus = useRef<string | 'add' | null>(null);
  const { errors } = validateIntervalDraft(rows, duration);
  const errorCount = Object.keys(errors).length;
  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    if (pendingFocus.current === 'add') addButton.current?.focus();
    else startFields.current.get(pendingFocus.current)?.focus();
    pendingFocus.current = null;
  }, [rows]);

  function add() {
    if (rows.length >= 12) return;
    const draft = intervalDrafts([{ start_hours: 0, end_hours: 0, effluent_mg_l: 0 }])[0];
    draft.start_hours = rows.at(-1)?.end_hours ?? '0';
    draft.end_hours = '';
    draft.effluent_mg_l = '';
    if (details.current) details.current.open = true;
    pendingFocus.current = draft.id;
    onChange([...rows, draft]);
  }
  function remove(index: number) {
    pendingFocus.current = rows[index + 1]?.id ?? rows[index - 1]?.id ?? 'add';
    onChange(rows.filter((_, rowIndex) => rowIndex !== index));
  }
  function update(rowId: string, field: keyof Omit<IntervalDraft, 'id'>, value: string) {
    onChange(rows.map(row => row.id === rowId ? { ...row, [field]: value } : row));
  }

  return <div className="load-profile-control">
    <details className="load-profile-editor" ref={details}>
      <summary>Интервалы нагрузки · {rows.length} /12{errorCount > 0 && <span className="load-profile-error-count"> · Ошибок: {errorCount}</span>}</summary>
      <p className="load-profile-help" id={`${id}-range`}>Время: от 0 до {String(duration).replace('.', ',')} ч. Концентрация: 0–10 000 мг/л. На общей границе начинается следующий период.</p>
      {rows.length === 0 && <p className="load-profile-empty">Нет периодов: концентрация входящей воды равна фону.</p>}
      <div className="load-profile-rows">
        {rows.map((row, index) => {
          const number = index + 1;
          const errorId = `${id}-${row.id}-error`;
          const fields = [
            { key: 'start_hours', label: `Начало периода ${number}, ч`, min: 0, max: duration },
            { key: 'end_hours', label: `Конец периода ${number}, ч`, min: 0, max: duration },
            { key: 'effluent_mg_l', label: `Концентрация периода ${number}, мг/л`, min: 0, max: 10000 },
          ] as const;
          return <fieldset key={row.id} className="load-profile-row">
            <legend>Период {number}</legend>
            <button type="button" className="load-profile-remove" aria-label={`Удалить период ${number}`} onClick={() => remove(index)}>Удалить</button>
            <div className="load-profile-row-fields">{fields.map(field => {
              const fieldId = `${id}-${row.id}-${field.key}`;
              return <div key={field.key}>
                <label htmlFor={fieldId}>{field.label}</label>
                <input id={fieldId} type="number" step="any" min={field.min} max={field.max}
                  value={row[field.key]} aria-invalid={Boolean(errors[row.id])}
                  aria-describedby={`${id}-range${errors[row.id] ? ` ${errorId}` : ''}`}
                  ref={field.key === 'start_hours' ? element => {
                    if (element) startFields.current.set(row.id, element);
                    else startFields.current.delete(row.id);
                  } : undefined}
                  onChange={event => update(row.id, field.key, event.target.value)} />
              </div>;
            })}</div>
            {errors[row.id] && <p className="load-profile-error" id={errorId}>{errors[row.id]}</p>}
          </fieldset>;
        })}
      </div>
    </details>
    {errors._list && <p className="load-profile-error">{errors._list}</p>}
    <p className="load-profile-validation" role="status" aria-live="polite">{errorCount > 0 ? `Проверьте интервалы нагрузки. Ошибок: ${errorCount}.` : ''}</p>
    <button type="button" className="load-profile-add" ref={addButton} disabled={rows.length >= 12} onClick={add}>Добавить период</button>
  </div>;
}
