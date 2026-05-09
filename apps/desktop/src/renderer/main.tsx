import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App.js';
import './index.css';
import { starlight } from './ipc-client.js';
import { useTrainerStore } from './stores/trainer-store.js';
import { useLatchState } from './stores/latch-store.js';

try {
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
} catch (err) {
  // Preload script failed to load. Surface the failure on the latch store
  // so the user sees an error banner instead of a blank window.
  useLatchState.setState({
    error: err instanceof Error ? err.message : String(err),
  });
}

const root = createRoot(document.getElementById('root')!);
root.render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
