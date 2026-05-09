import { NavLink } from 'react-router-dom';

const NAV = [
  { to: '/',          label: 'Home' },
  { to: '/library',   label: 'Library' },
  { to: '/browse',    label: 'Browse' },
  { to: '/search',    label: 'Search' },
  { to: '/active',    label: 'Active Trainer' },
];

export function Sidebar(): JSX.Element {
  return (
    <aside className="w-[220px] shrink-0 border-r border-line bg-panel px-2.5 py-4 flex flex-col gap-1">
      <nav className="flex flex-col gap-0.5 flex-1">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            className={({ isActive }) =>
              [
                'flex items-center gap-2.5 rounded px-3 py-2.5 text-[13px] border',
                isActive
                  ? 'bg-neon-cyan/[0.06] border-neon-cyan text-neon-cyan glow-cyan'
                  : 'border-transparent text-ink hover:bg-line/40',
              ].join(' ')
            }
          >
            <span className="block size-1.5 rounded-full bg-[#3a3a55]" />
            <span>{n.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="px-2 pt-2 text-[11px] text-muted border-t border-line">
        v0.1 · phase 3 · mock data
      </div>
    </aside>
  );
}
