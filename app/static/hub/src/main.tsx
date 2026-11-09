import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { setGlobalTheme } from '@atlaskit/tokens/set-global-theme';
import { App } from './App';
import { isForge } from './api';
import './styles.css';

const q = new URLSearchParams(window.location.search);
const forced = q.get('theme');
const colorMode = forced === 'dark' || forced === 'light' ? forced : 'auto';

async function boot() {
  const opts = { light: 'light', dark: 'dark', spacing: 'spacing', typography: 'typography', shape: 'shape' } as const;
  if (isForge) {
    // Inside Jira the host decides light or dark.
    const { view } = await import('@forge/bridge');
    await view.theme.enable().catch(() => setGlobalTheme({ ...opts, colorMode }));
  } else {
    await setGlobalTheme({ ...opts, colorMode });
  }
  createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
}
void boot();
