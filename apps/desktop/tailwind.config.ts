import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        shell:     '#141720',
        bg:        '#1b1e2a',
        panel:     '#232838',
        line:      '#363d52',
        ink:       '#f3f5fa',
        muted:     '#8e96ab',
        'neon-cyan':  '#3ee0c0',
        'neon-pink':  '#ff6b8e',
        'neon-green': '#4ade80',
        'neon-amber': '#f6bd60',
        raised:    '#2d3345',
        soft:      '#bcc3d4',
      },
      fontFamily: {
        sans: ['"Figtree Variable"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'monospace'],
      },
      borderRadius: { sm: '6px', DEFAULT: '8px', md: '10px' },
      boxShadow: {
        card: '0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 24px rgba(8,10,18,0.28)',
        pop:  '0 1px 0 rgba(255,255,255,0.06) inset, 0 18px 48px rgba(8,10,18,0.5)',
      },
      letterSpacing: {
        widest: '0.18em',
        wider:  '0.16em',
      },
      backgroundImage: {
        'neon-grid':
          'linear-gradient(rgba(255,0,180,0.05) 1px, transparent 1px),' +
          'linear-gradient(90deg, rgba(0,255,200,0.05) 1px, transparent 1px)',
      },
      backgroundSize: {
        'grid-26': '26px 26px',
      },
      keyframes: {
        pulse: { '50%': { opacity: '0.35' } },
        orbit: { to: { transform: 'rotate(360deg)' } },
        scan:  { from: { transform: 'translateX(-100%)' }, to: { transform: 'translateX(100%)' } },
        rise:  { from: { opacity: '0', transform: 'translateY(10px)' }, to: { opacity: '1', transform: 'none' } },
        pop:   { '0%': { opacity: '0', transform: 'scale(0.4)' }, '70%': { transform: 'scale(1.15)' }, '100%': { opacity: '1', transform: 'scale(1)' } },
        lock:  { '0%': { boxShadow: '0 0 0 0 rgba(62,224,192,0.5)' }, '100%': { boxShadow: '0 0 0 14px rgba(62,224,192,0)' } },
      },
      animation: {
        'pulse-slow': 'pulse 1.4s ease-in-out infinite',
        orbit: 'orbit 2.4s linear infinite',
        scan:  'scan 1.3s ease-in-out infinite',
        rise:  'rise 0.38s cubic-bezier(0.2, 0.8, 0.2, 1) both',
        pop:   'pop 0.3s ease-out both',
        lock:  'lock 0.7s ease-out both',
      },
    },
  },
  plugins: [],
};

export default config;
