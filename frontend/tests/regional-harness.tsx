import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import RegionalOverview from '../src/RegionalOverview';
import '../src/styles.css';

function Harness() {
  const [visible, setVisible] = useState(true);
  const [applied, setApplied] = useState('');
  return <><button onClick={() => setVisible(value => !value)}>Переключить обзор</button><output data-testid="applied-reach">{applied}</output><RegionalOverview visible={visible} currentReachId="don-olkhovets" hasResult onApplyReach={reach => setApplied(reach.id)} onReturnResult={() => setVisible(false)} /></>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
