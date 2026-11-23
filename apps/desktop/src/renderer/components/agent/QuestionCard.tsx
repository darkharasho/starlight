import { useEffect, useRef, useState } from 'react';
import type { PendingQuestion } from '../../../shared/ipc.js';
import { useAgentStore } from '../../stores/agent-store.js';
import { useNow, countdown } from './useNow.js';

interface Props { question: PendingQuestion; yesKey: string; noKey: string }

export function QuestionCard({ question, yesKey, noKey }: Props): JSX.Element {
  const answer = useAgentStore((s) => s.answer);
  const now = useNow();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // The number box takes focus on mount and whenever the window comes back, so
  // the player can alt-tab out of the game and just type.
  useEffect(() => {
    if (question.answer !== 'number') return;
    const focus = (): void => input.current?.focus();
    focus();
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [question.id, question.answer]);

  useEffect(() => { setText(''); setError(null); }, [question.id]);

  const send = async (value: number | boolean | string): Promise<void> => {
    const r = await answer(question.id, value);
    setError(r.ok ? null : (r.error ?? 'That did not work'));
  };

  const btn = 'rounded-lg border border-neon-cyan/40 px-4 py-2 text-sm text-ink hover:bg-neon-cyan/10';
  return (
    <section aria-label="Question" className="rounded-xl border border-neon-cyan/40 bg-panel px-5 py-4 animate-rise">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">{question.question}</h2>
        <span className="shrink-0 text-xs text-muted">{countdown(question.expiresAt - now)}</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {question.answer === 'number' && (
          <form
            className="flex items-center gap-2"
            onSubmit={(ev) => {
              ev.preventDefault();
              const n = Number(text);
              if (text.trim() === '' || !Number.isFinite(n)) { setError('Type a number'); return; }
              void send(n);
            }}
          >
            <input
              ref={input}
              aria-label="Your answer"
              value={text}
              onChange={(ev) => setText(ev.target.value)}
              inputMode="decimal"
              className="w-40 rounded-lg border border-white/10 bg-bg px-3 py-2 text-sm text-ink focus:border-neon-cyan focus:outline-none"
            />
            <button type="submit" className={btn}>Send</button>
          </form>
        )}
        {question.answer === 'confirm' && (
          <>
            <button type="button" className={btn} onClick={() => void send(true)}>Yes <span className="ml-1 text-xs text-muted">{yesKey}</span></button>
            <button type="button" className={btn} onClick={() => void send(false)}>No <span className="ml-1 text-xs text-muted">{noKey}</span></button>
          </>
        )}
        {question.answer === 'choice' && (question.choices ?? []).map((c) => (
          <button key={c} type="button" className={btn} onClick={() => void send(c)}>{c}</button>
        ))}
      </div>
      {error && <p role="alert" className="mt-2 text-[13px] text-neon-pink">{error}</p>}
    </section>
  );
}
