import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg:        '#07070b',
        panel:     '#0d0d18',
        line:      '#1a1a2e',
        ink:       '#e6e6f0',
        muted:     '#7a7a92',
        'neon-cyan':  '#00ffc8',
        'neon-pink':  '#ff00b4',
        'neon-green': '#00ff7a',
        'neon-amber': '#ffb86b',
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'monospace'],
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
      },
      animation: {
        'pulse-slow': 'pulse 1.4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
