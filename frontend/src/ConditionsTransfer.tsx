import { useEffect, useRef, useState } from 'react';
import { responseData } from './scenarioStorage';
import { downloadConditions, MAX_CONDITIONS_FILE_BYTES, validDocumentValidation, type ConditionsDocument, type DocumentValidation } from './scenarioExchange';

type Props = { name: string; draftKey: string; interactionKey: number;
  getDocument: (name: string) => ConditionsDocument; onApply: (document: ConditionsDocument) => void; onAppliedName: (name: string) => void };
export default function ConditionsTransfer({ name, draftKey, interactionKey, getDocument, onApply, onAppliedName }: Props) {
  const [preview, setPreview] = useState<DocumentValidation | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const request = useRef(0), abort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const current = useRef({ draftKey, interactionKey, onApply, onAppliedName }); current.current = { draftKey, interactionKey, onApply, onAppliedName };
  const checkedAt = useRef<{ draftKey: string; interactionKey: number } | null>(null);
  useEffect(() => () => { request.current++; abort.current?.abort(); }, []);
  useEffect(() => {
    const input = fileInput.current;
    const cancel = () => setNotice('Выбор файла отменён. Условия формы не изменены.');
    input?.addEventListener('cancel', cancel);
    return () => input?.removeEventListener('cancel', cancel);
  }, []);
  function exportForm() {
    setError(''); setNotice('');
    try { downloadConditions(getDocument(name)); setNotice('Выгружены текущие условия формы. Показанный старый результат не использован.'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось выгрузить условия формы.'); }
  }
  async function selectFile(file?: File) {
    if (!file) { setNotice('Выбор файла отменён. Условия формы не изменены.'); return; }
    const id = ++request.current;
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    setPreview(null); setError(''); setNotice(''); setLoading(true);
    const before = { draftKey: current.current.draftKey, interactionKey: current.current.interactionKey };
    const timer = window.setTimeout(() => controller.abort(), 10_000);
    try {
      if (file.size === 0 || file.size > MAX_CONDITIONS_FILE_BYTES) throw new Error('Файл должен содержать JSON размером от 1 до 8192 байт.');
      const bytes = await file.arrayBuffer();
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new Error('Файл повреждён или имеет другую кодировку. Нужен JSON в UTF-8.'); }
      let data: unknown;
      try { data = JSON.parse(text); } catch { throw new Error('Повреждённый JSON. Выберите полный файл условий.'); }
      if (id !== request.current || controller.signal.aborted) return;
      const response = await fetch('/api/v1/scenario-files/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text, signal: controller.signal });
      const result = await responseData(response);
      if (id !== request.current || controller.signal.aborted) return;
      if (!validDocumentValidation(result)) throw new Error('Сервер вернул неполную проверку файла. Условия не изменены.');
      checkedAt.current = before; setPreview(result);
      setNotice('Файл проверен. Просмотрите условия и примените их отдельной кнопкой.');
    } catch (reason) {
      if (id !== request.current) return;
      setError(controller.signal.aborted ? 'Истекло время проверки файла. Условия не изменены; повторите выбор.' : reason instanceof Error ? reason.message : 'Файл не удалось прочитать. Условия не изменены.');
    } finally { window.clearTimeout(timer); if (id === request.current) setLoading(false); }
  }
  function apply() {
    if (!preview?.compatibility.compatible) return;
    if (!checkedAt.current || checkedAt.current.draftKey !== current.current.draftKey || checkedAt.current.interactionKey !== current.current.interactionKey) {
      setError('После проверки выполнено более новое действие или изменены условия. Выберите файл снова перед применением.'); return;
    }
    try { current.current.onApply(preview.document); current.current.onAppliedName(preview.document.name); setPreview(null); setError(''); setNotice('Условия файла применены к форме. Расчёт и сохранение выполняются отдельно.'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось применить условия.'); }
  }
  return <section className="conditions-transfer" aria-label="Перенос условий">
    <h3>Перенос через файл</h3>
    <button type="button" onClick={exportForm}>Выгрузить текущие условия JSON</button>
    <small>Название — в поле выше. В файл попадёт текущая валидная форма, без результатов и А/Б.</small>
    <label htmlFor="conditions-file">Импортировать условия JSON</label>
    <input ref={fileInput} id="conditions-file" type="file" accept=".json,application/json" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void selectFile(file); }} />
    <small>До 8192 байт. Проверка и просмотр не запускают расчёт и не сохраняют запись.</small>
    {loading && <p role="status">Проверяем файл условий…</p>}
    {loading && <button type="button" onClick={() => { request.current++; abort.current?.abort(); setLoading(false); setNotice('Проверка отменена. Условия формы не изменены.'); }}>Отменить проверку файла</button>}
    {error && <p data-testid="transfer-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {preview && <div className="conditions-preview" data-testid="conditions-preview">
      <strong>{preview.document.name}</strong><p>{preview.document.reach_name}</p>
      <dl><dt>Модель / формат</dt><dd>{preview.document.model_id} / {preview.document.format_version}</dd>
        <dt>Источник от начала, м</dt><dd>{preview.document.conditions.source_distance_m ?? 0}</dd>
        <dt>Расход реки / стоков, м³/с</dt><dd>{preview.document.conditions.river_flow_m3_s} / {preview.document.conditions.effluent_flow_m3_s}</dd>
        <dt>Фон, мг/л</dt><dd>{preview.document.conditions.background_mg_l}</dd>
        {preview.document.conditions.load_mode !== 'profile' && <><dt>Стоки, мг/л</dt><dd>{preview.document.conditions.effluent_mg_l}</dd></>}
        <dt>Скорость, м/с / дисперсия, м²/с</dt><dd>{preview.document.conditions.velocity_m_s} / {preview.document.conditions.dispersion_m2_s}</dd>
        <dt>Горизонт / период нагрузки, ч</dt><dd>{preview.document.conditions.duration_hours} / {preview.document.conditions.load_mode === 'profile' ? 'График нагрузки' : preview.document.conditions.load_mode === 'finite' ? preview.document.conditions.load_duration_hours : 'постоянная'}</dd>
        {preview.document.geometry_mode === 'synthetic' && <><dt>Длина, м</dt><dd>{preview.document.conditions.length_m}</dd></>}
      </dl>
      {preview.document.conditions.load_mode === 'profile' && <>
        <table aria-label="График нагрузки из файла"><caption>График нагрузки</caption>
          <thead><tr><th>Начало, ч</th><th>Конец, ч</th><th>Стоки, мг/л</th></tr></thead>
          <tbody>{preview.document.conditions.load_intervals?.map((row, index) => <tr key={index}><td>{row.start_hours}</td><td>{row.end_hours}</td><td>{row.effluent_mg_l}</td></tr>)}</tbody>
        </table>
        <p>{preview.document.conditions.load_intervals?.length ? 'Интервалы включают начало и не включают конец. Между интервалами концентрация стоков равна фону.' : 'Интервалов нет: концентрация стоков равна фону на всём горизонте.'}</p>
      </>}
      <p>{preview.compatibility.compatible ? 'Совместимо с текущей моделью и геометрией.' : preview.compatibility.reasons.join(' ')}</p>
      <button type="button" disabled={!preview.compatibility.compatible} onClick={apply}>Применить к форме</button>
      <button type="button" onClick={() => { setPreview(null); setError(''); setNotice('Предварительный просмотр закрыт. Условия формы не изменены.'); }}>Закрыть просмотр</button>
    </div>}
  </section>;
}
