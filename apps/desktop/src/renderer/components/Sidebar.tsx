import { Bot, House, LayoutGrid, LibraryBig, Search, Settings2, Zap } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { useAgentStore } from '../stores/agent-store.js';
import { useUpdateStore } from '../stores/update-store.js';

const NAV = [
  { to: '/',          label: 'Home',           icon: House },
  { to: '/library',   label: 'Library',        icon: LibraryBig },
  { to: '/browse',    label: 'Browse',         icon: LayoutGrid },
  { to: '/search',    label: 'Search',         icon: Search },
  { to: '/active',    label: 'Active Trainer', icon: Zap },
  { to: '/agent',     label: 'Agent',          icon: Bot },
  { to: '/settings',  label: 'Settings',       icon: Settings2 },
];

export function Sidebar(): JSX.Element {
  const attached = useAgentStore((s) => s.state?.status === 'attached');
  const version = useUpdateStore((u) => u.version);
  return (
    <aside className="w-[216px] shrink-0 bg-shell px-3 py-4 flex flex-col gap-1">
      <nav className="flex flex-col gap-0.5 flex-1">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            className={({ isActive }) =>
              [
                'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan',
                isActive
                  ? 'bg-white/[0.08] text-ink [&>svg]:text-neon-cyan'
                  : 'text-muted hover:bg-white/[0.04] hover:text-ink',
              ].join(' ')
            }
          >
            <n.icon aria-hidden="true" className="size-[18px] shrink-0" strokeWidth={1.75} />
            <span>{n.label}</span>
            {n.to === '/agent' && attached && (
              <span role="status" aria-label="Agent attached" className="ml-auto size-2 rounded-full bg-neon-cyan" />
            )}
          </NavLink>
        ))}
      </nav>
      {version && <div className="px-3 pt-2 text-xs text-muted/70">v{version}</div>}
    </aside>
  );
}
