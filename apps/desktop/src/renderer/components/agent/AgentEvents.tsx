import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { attachAgentEvents } from '../../stores/agent-store.js';
import { starlight } from '../../ipc-client.js';

/** Keeps the agent store current and opens the agent view on `agent:focus`. Renders nothing. */
export function AgentEvents(): null {
  const navigate = useNavigate();
  useEffect(() => attachAgentEvents(), []);
  useEffect(() => starlight().onEvent((e) => {
    if (e.type === 'agent:focus') navigate('/agent');
  }), [navigate]);
  return null;
}
