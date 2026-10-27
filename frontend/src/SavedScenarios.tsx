import { useEffect, useRef, useState } from 'react';
import { responseData, validCompatibility, validPage, validSaved, type SavePayload, type SavedScenario, type ScenarioPage } from './scenarioStorage';
import './savedScenarios.css';

type Props = { draftKey: string; getConditions: () => SavePayload; onOpen: (scenario: SavedScenario) => void };
export default function SavedScenarios({ draftKey, getConditions, onOpen }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState('');
  const [page, setPage] = useState<ScenarioPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<'save' | 'open' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const key = useRef(draftKey); key.current = draftKey;
  const open = useRef(onOpen); open.current = onOpen;
  const action = useRef(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { action.current++; controller.current?.abort(); }, []);

  useEffect(() => {
    if (!expanded) return;
    const abort = new AbortController(); let active = true;
    setLoading(true);
    const timer = window.setTimeout(() => abort.abort(), 10_000);
    fetch(`/api/v1/scenarios?limit=20&offset=${offset}`, { signal: abort.signal })
      .then(responseData).then(data => {
        if (!active) return;
        if (!validPage(data, offset)) throw new Error('Сервер вернул некорректный список условий.');
        setPage(data);
      }).catch(reason => { if (active) setError(abort.signal.aborted ? 'Истекло время загрузки списка. Повторите запрос.' : reason instanceof Error ? reason.message : 'Не удалось загрузить список.'); })
      .finally(() => { window.clearTimeout(timer); if (active) setLoading(false); });
    return () => { active = false; window.clearTimeout(timer); abort.abort(); };
  }, [expanded, offset, revision]);

  function cancel() {
    action.current++; controller.current?.abort(); setBusy(null);
    setNotice('Ожидание отменено. Если сохраняли условия, обновите список: запись могла сохраниться на сервере.');
  }
  async function perform(kind: 'save' | 'open', id?: string) {
    setError(''); setNotice('');
    let payload: SavePayload | undefined;
    const title = name.trim();
    if (kind === 'save') {
      if (!title || title.length > 120 || /[\u0000-\u001f\u007f]/.test(title)) { setError('Введите название от 1 до 120 символов без управляющих знаков.'); return; }
      try { payload = getConditions(); }
      catch (reason) { setError(reason instanceof Error ? reason.message : 'Заполните корректные условия расчёта.'); return; }
    }
    const token = ++action.current, before = key.current;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    const timer = window.setTimeout(() => { abort.abort(); }, 10_000);
    setBusy(kind);
    try {
      const response = await fetch(kind === 'save' ? '/api/v1/scenarios' : `/api/v1/scenarios/${id}`, {
        method: kind === 'save' ? 'POST' : 'GET', signal: abort.signal,
        ...(kind === 'save' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: title, ...payload }) } : {}),
      });
      const data = await responseData(response);
      if (token !== action.current || abort.signal.aborted) return;
      if (!validCompatibility(data)) throw new Error('Сервер вернул некорректную запись условий.');
      if (!data.compatibility.compatible) throw new Error(`Условия недоступны для этой версии: ${data.compatibility.reasons.join(' ')} Исходная запись сохранена.`);
      if (!validSaved(data)) throw new Error('Версия или содержимое условий не поддерживаются. Исходная запись сохранена.');
      if (kind === 'save') {
        setNotice(`Сохранены условия «${data.name}».${before !== key.current ? ' После отправки форма изменилась; сохранён отправленный набор.' : ''}`);
        setOffset(0); setRevision(value => value + 1);
      } else {
        if (before !== key.current) throw new Error('Условия формы изменены во время ожидания. Открытие отменено; повторите его явно.');
        open.current(data); setName(data.name);
        setNotice(`Открыты условия «${data.name}». Нажмите «Рассчитать» для нового результата. Сохранённая запись не изменяется.`);
      }
    } catch (reason) {
      if (token !== action.current) return;
      setError(abort.signal.aborted ? kind === 'save' ? 'Время ожидания истекло. Сохранение не подтверждено: обновите список перед повтором.' : 'Истекло время открытия. Форма сохранена; повторите запрос.' : reason instanceof Error ? reason.message : 'Не удалось подтвердить операцию. Обновите список перед повтором сохранения.');
    } finally { window.clearTimeout(timer); if (token === action.current) setBusy(null); }
  }
  return <details className="saved-scenarios" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>Сохранённые условия</summary>
    <p className="library-explanation">В базе сохраняются условия для повторного расчёта. Результаты, массивы концентраций и пара А/Б не сохраняются. Записи доступны после перезагрузки.</p>
    <label htmlFor="saved-name">Название сохраняемых условий</label>
    <input id="saved-name" type="text" maxLength={120} value={name} onChange={event => setName(event.target.value)} placeholder="Например, короткий период на Дону" />
    <button type="button" disabled={!!busy} onClick={() => { void perform('save'); }}>{busy === 'save' ? 'Сохраняем условия…' : 'Сохранить как новый сценарий'}</button>
    <small>Каждое сохранение создаёт новую запись текущей формы. Показанный старый результат не используется.</small>
    <div data-testid="library-status" role="status">{notice}</div>
    {error && <p data-testid="library-error" role="alert">{error}</p>}
    {busy && <button type="button" onClick={cancel}>Отменить ожидание библиотеки</button>}
    <div className="library-list-heading"><strong>Библиотека</strong><button type="button" disabled={loading} onClick={() => { setError(''); setRevision(value => value + 1); }}>Обновить список</button></div>
    {loading && <p role="status">Загружаем условия…</p>}
    {!loading && page?.total === 0 && <p>Сохранённых условий пока нет.</p>}
    {page && <><ul aria-label="Сохранённые сценарии" aria-busy={loading}>
      {page.items.map(item => <li key={item.id}>
        <strong>{item.name}</strong><span>{item.reach_name} · {item.load_mode === 'finite' ? 'Ограниченный период' : 'Постоянная нагрузка'}</span>
        <time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
        <button type="button" disabled={!!busy || loading} aria-label={`Открыть «${item.name}»`} onClick={() => { void perform('open', item.id); }}>Открыть</button>
      </li>)}
    </ul><div className="library-pagination"><button type="button" aria-label="Предыдущие сохранённые условия" disabled={loading || offset === 0} onClick={() => { setError(''); setOffset(Math.max(0, offset - 20)); }}>←</button>
      <span>{page.total === 0 ? '0' : `${page.offset + 1}–${page.offset + page.items.length}`} из {page.total}</span>
      <button type="button" aria-label="Следующие сохранённые условия" disabled={loading || offset + 20 >= page.total} onClick={() => { setError(''); setOffset(offset + 20); }}>→</button></div></>}
  </details>;
}
