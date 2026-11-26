import { useShareStore } from '../../stores/share-store.js';

/** What sharing a cheat sends, shown before it's sent. */
export function ShareDialog(): JSX.Element | null {
  const { target, preview, credit, sending, result } = useShareStore();
  if (!target) return null;
  const close = (): void => useShareStore.getState().close();
  const link = (url: string): JSX.Element => (
    <a href={url} target="_blank" rel="noreferrer" className="text-neon-cyan underline underline-offset-2">{url}</a>
  );

  let body: JSX.Element;
  if (result) {
    body = result.ok ? (
      <div className="space-y-1.5 text-[13px]">
        <p className="text-ink">
          {result.state === 'declined' ? 'This cheat was reviewed and not accepted.'
            : result.state === 'merged' ? 'This cheat is already in the catalog.'
            : result.duplicate ? 'Already submitted' : 'Submitted for review'}
        </p>
        <p>{link(result.url)}</p>
      </div>
    ) : <p role="alert" className="text-[13px] text-neon-pink">{result.reason}</p>;
  } else if (!preview) {
    body = <p className="text-[13px] text-muted">Getting it ready…</p>;
  } else if (!preview.ok) {
    body = <p role="alert" className="text-[13px] text-neon-pink">{preview.reason}</p>;
  } else {
    body = (
      <div className="space-y-3">
        {preview.already && (
          <div className="text-[13px]"><p className="text-ink">Already submitted</p><p>{link(preview.already.url)}</p></div>
        )}
        <p className="text-[12.5px] text-muted">
          This is everything that will be sent. The maintainer reads it before anyone else can use the cheat.
        </p>
        <div className="whitespace-pre-wrap rounded-lg border border-line bg-bg/60 px-3 py-2 text-[12.5px] text-soft">{preview.summary}</div>
        <details className="text-[12px] text-muted">
          <summary className="cursor-pointer">Exactly what’s sent</summary>
          <pre className="mt-1.5 max-h-56 overflow-auto rounded-lg border border-line bg-bg px-3 py-2 text-[11.5px] text-soft">{preview.json}</pre>
        </details>
        {!preview.already && (
          <label className="flex items-center gap-2 text-[13px] text-soft">
            <span>Credit as</span>
            <input value={credit} maxLength={40} placeholder="Anonymous"
                   onChange={(e) => void useShareStore.getState().setCredit(e.target.value)}
                   className="flex-1 rounded-lg border border-line bg-bg px-2.5 py-1 text-ink focus:border-neon-cyan focus:outline-none" />
          </label>
        )}
      </div>
    );
  }

  const canSend = !result && preview?.ok === true && !preview.already;
  return (
    <div role="dialog" aria-label={`Share ${target.name}`}
         className="mb-3 overflow-hidden rounded-xl border border-neon-cyan/40 bg-panel animate-rise">
      <header className="border-b border-line/70 bg-[#2a3044] px-3.5 py-2 text-[12.5px] font-medium text-soft">{`Share “${target.name}”`}</header>
      <div className="px-3.5 py-3">{body}</div>
      <footer className="flex justify-end gap-2 border-t border-line/70 px-3.5 py-2">
        {canSend && (
          <button type="button" disabled={sending} onClick={() => void useShareStore.getState().send()}
                  className="rounded-full border border-neon-cyan/60 px-3 py-1 text-[13px] text-neon-cyan hover:bg-neon-cyan/[0.1] disabled:opacity-50">Send</button>
        )}
        <button type="button" onClick={close}
                className="rounded-full border border-line px-3 py-1 text-[13px] text-muted hover:text-ink">{result ? 'Close' : 'Cancel'}</button>
      </footer>
    </div>
  );
}
