interface Props {
  id: string;
  name: string;
  description?: string;
  active: boolean;
  hotkey?: string;
  onToggle: (id: string, next: boolean) => void;
}

export function ToggleCheatCard({ id, name, description, active, hotkey, onToggle }: Props): JSX.Element {
  const containerCls = active
    ? 'border-neon-green bg-neon-green/[0.04] glow-green'
    : 'border-line hover:border-neon-cyan';
  const titleCls = active ? 'text-neon-green' : '';

  return (
    <div className={`grid grid-cols-[1fr_auto_auto] gap-3.5 items-center px-4 py-3.5 rounded-sm bg-panel border transition-colors ${containerCls}`}>
      <div>
        <div className={`text-[13px] font-semibold ${titleCls}`}>{name}</div>
        {description && <div className="text-[11px] text-muted mt-0.5">{description}</div>}
      </div>
      {hotkey ? (
        <span className={`text-[10px] tracking-wider px-2 py-1 rounded-sm border font-mono ${active ? 'border-neon-green text-neon-green' : 'border-line text-muted'}`}>
          {hotkey}
        </span>
      ) : <span />}
      <button
        type="button"
        role="switch"
        aria-checked={active}
        onClick={() => onToggle(id, !active)}
        className={`w-9 h-[18px] rounded-[10px] border relative transition-colors ${active ? 'bg-neon-green/[0.15] border-neon-green' : 'bg-line border-line'}`}
      >
        <span
          className={`absolute top-px size-[14px] rounded-full transition-all ${active ? 'left-[19px] bg-neon-green glow-green' : 'left-px bg-[#3a3a55]'}`}
        />
      </button>
    </div>
  );
}
