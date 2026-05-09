interface Props { id: string; name: string; reason: string; description?: string }

export function UnsupportedCheatCard({ name, reason, description }: Props): JSX.Element {
  return (
    <div className="grid grid-cols-[1fr_auto_auto] gap-3.5 items-center px-4 py-3.5 rounded-sm bg-panel border border-line opacity-55">
      <div>
        <div className="text-[13px] font-semibold">
          {name}
          <span className="ml-1.5 inline-block text-[8px] tracking-wider px-1.5 py-px rounded-sm border border-neon-amber text-neon-amber align-middle">
            UNSUPPORTED
          </span>
        </div>
        {(description || reason) && <div className="text-[11px] text-muted mt-0.5">{description ?? reason}</div>}
      </div>
      <span className="text-[10px] tracking-wider px-2 py-1 rounded-sm border border-line text-muted font-mono">—</span>
      <span className="w-9 h-[18px] rounded-[10px] border border-line bg-line block" />
    </div>
  );
}
