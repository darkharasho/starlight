import { NavLink } from 'react-router-dom';

const NAV = [
  { to: '/',          label: 'Home',           icon: 'M3 9.5 10 3l7 6.5V16a1 1 0 0 1-1 1h-3.5v-4.5h-5V17H4a1 1 0 0 1-1-1Z' },
  { to: '/library',   label: 'Library',        icon: 'M4 3v14M8 3v14M12.5 4l3.5 12.5' },
  { to: '/browse',    label: 'Browse',         icon: 'M3 3h5.5v5.5H3ZM11.5 3H17v5.5h-5.5ZM3 11.5h5.5V17H3ZM11.5 11.5H17V17h-5.5Z' },
  { to: '/search',    label: 'Search',         icon: 'M13.2 13.2 17 17M15 9A6 6 0 1 1 3 9a6 6 0 0 1 12 0Z' },
  { to: '/active',    label: 'Active Trainer', icon: 'M11 2 4 11.5h5L8.5 18l7-9.5h-5Z' },
  { to: '/settings',  label: 'Settings',       icon: 'M3 6h8M15 6h2M3 14h2M9 14h8M13 4v4M7 12v4' },
];

export function Sidebar(): JSX.Element {
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
            <svg viewBox="0 0 20 20" className="size-[18px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={n.icon} />
            </svg>
            <span>{n.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="px-3 pt-2 text-xs text-muted/70">
        v0.1
      </div>
    </aside>
  );
}
