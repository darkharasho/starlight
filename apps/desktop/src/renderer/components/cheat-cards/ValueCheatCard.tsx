interface Props {
  id: string;
  name: string;
  description?: string;
  active: boolean;
  value: number;
  step: number;
  min?: number;
  max?: number;
  hotkeys?: { toggle?: string; inc?: string; dec?: string };
  onToggle: (id: string, next: boolean) => void;
  onValueChange: (id: string, value: number) => void;
}

function clamp(v: number, min?: number, max?: number): number {
  let r = v;
  if (min !== undefined && r < min) r = min;
  if (max !== undefined && r > max) r = max;
  return Number(r.toFixed(6));
}

export function ValueCheatCard(props: Props): JSX.Element {
  const { id, name, description, active, value, step, min, max, hotkeys, onToggle, onValueChange } = props;
  const containerCls = active
    ? 'border-neon-green bg-neon-green/[0.04] glow-green'
    : 'border-line hover:border-neon-cyan';
  const titleCls = active ? 'text-neon-green' : '';

  return (
    <div className={`grid grid-cols-[1fr_140px_120px_auto] gap-3.5 items-center px-4 py-3.5 rounded-sm bg-panel border transition-colors ${containerCls}`}>
      <div>
        <div className={`text-[13px] font-semibold ${titleCls}`}>{name}</div>
        {description && <div className="text-[11px] text-muted mt-0.5">{description}</div>}
      </div>

      <div className={`flex h-7 rounded-sm border overflow-hidden ${active ? 'border-neon-green' : 'border-line'}`}>
        <button
          type="button"
          aria-label="-"
          onClick={() => onValueChange(id, clamp(value - step, min, max))}
          className="w-7 bg-panel border-r border-line text-ink hover:bg-neon-cyan/10 hover:text-neon-cyan font-mono"
        >−</button>
        <input
          type="number"
          aria-label={`${name} value`}
          value={value}
          step={step}
          min={min}
          max={max}
          onChange={(e) => onValueChange(id, clamp(Number(e.target.value), min, max))}
          className={`flex-1 min-w-0 bg-transparent text-center font-mono text-xs px-1 outline-none ${active ? 'text-neon-green' : 'text-ink'}`}
        />
        <button
          type="button"
          aria-label="+"
          onClick={() => onValueChange(id, clamp(value + step, min, max))}
          className="w-7 bg-panel border-l border-line text-ink hover:bg-neon-cyan/10 hover:text-neon-cyan font-mono"
        >+</button>
      </div>

      {hotkeys ? (
        <div className="flex flex-col gap-0.5 items-end font-mono text-[9px] text-muted">
          {hotkeys.toggle && <Hotkey label="on" keyName={hotkeys.toggle} active={active} />}
          {hotkeys.inc    && <Hotkey label="+"  keyName={hotkeys.inc}    active={active} />}
          {hotkeys.dec    && <Hotkey label="−"  keyName={hotkeys.dec}    active={active} />}
        </div>
      ) : <span />}

      <button
        type="button"
        role="switch"
        aria-checked={active}
        onClick={() => onToggle(id, !active)}
        className={`w-9 h-[18px] rounded-[10px] border relative transition-colors justify-self-end ${active ? 'bg-neon-green/[0.15] border-neon-green' : 'bg-line border-line'}`}
      >
        <span className={`absolute top-px size-[14px] rounded-full transition-all ${active ? 'left-[19px] bg-neon-green glow-green' : 'left-px bg-[#3a3a55]'}`} />
      </button>
    </div>
  );
}

function Hotkey({ label, keyName, active }: { label: string; keyName: string; active: boolean }): JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <span className="tracking-wider uppercase opacity-70">{label}</span>
      <span className={`border px-1.5 py-px rounded-sm min-w-[38px] text-center ${active ? 'border-neon-green/50 text-neon-green' : 'border-line'}`}>
        {keyName}
      </span>
    </div>
  );
}
