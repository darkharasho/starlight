import { useState } from 'react';
import { starlight } from '../ipc-client.js';

interface Props {
  onCancel: () => void;
  onConfirm: (data: { name: string; exePath: string }) => Promise<void>;
}

export function AddManualGameDialog({ onCancel, onConfirm }: Props): JSX.Element {
  const [exePath, setExePath] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [pickError, setPickError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handlePick(): Promise<void> {
    setPickError(null);
    const r = await starlight().pickExecutable();
    if (!r.ok) {
      if (r.error === 'cancelled') return;
      setPickError(r.message ?? r.error);
      return;
    }
    setExePath(r.path);
  }

  async function handleSave(): Promise<void> {
    if (!exePath || !name.trim()) return;
    setSaving(true);
    try {
      await onConfirm({ name: name.trim(), exePath });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-bg/80 flex items-center justify-center z-50">
      <div role="dialog" aria-labelledby="add-manual-title"
           className="w-[420px] rounded-sm border border-line bg-panel px-5 py-4 flex flex-col gap-3">
        <h2 id="add-manual-title" className="text-sm font-semibold">Add a manual game</h2>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => void handlePick()}
            className="self-start px-3 py-1.5 text-xs rounded-sm border border-neon-cyan text-neon-cyan glow-cyan hover:bg-neon-cyan/[0.08]"
          >
            {exePath ? 'Pick a different executable' : 'Pick executable…'}
          </button>
          {exePath && <div className="text-[10px] text-muted truncate">{exePath}</div>}
          {pickError && <div className="text-[10px] text-neon-pink">{pickError}</div>}
        </div>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted text-[10px] tracking-wider uppercase">Display name</span>
          <input
            aria-label="Display name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!exePath}
            className="px-2 py-1.5 text-xs rounded-sm bg-bg border border-line text-ink disabled:opacity-50"
          />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded-sm border border-line text-muted hover:border-neon-pink hover:text-neon-pink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!exePath || !name.trim() || saving}
            className="px-3 py-1.5 text-xs rounded-sm border border-neon-cyan text-neon-cyan glow-cyan hover:bg-neon-cyan/[0.08] disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
