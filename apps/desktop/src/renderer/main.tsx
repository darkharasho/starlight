import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App.js';
import './index.css';
import { starlight } from './ipc-client.js';
import { useTrainerStore } from './stores/trainer-store.js';
import { useLatchState } from './stores/latch-store.js';

starlight().onEvent((e) => {
  useTrainerStore.getState().applyEvent(e);
  if (e.type === 'session:detached') {
    useLatchState.setState({
      state: 'waiting',
      detectedGame: null,
      error: e.reason === 'process-exit' ? 'Target process exited.' : null,
    });
  }
});

const root = createRoot(document.getElementById('root')!);
root.render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
