import type { Config } from 'tailwindcss';

// Dark-only design system — see CLAUDE.md's Dashboard section and
// src/index.css for the token values. No light theme, no toggle: `dark`
// is applied permanently on <html> in index.html, and darkMode: 'class'
// here exists only because Tremor's own components ship `dark:` variants
// internally and expect that class to be present.
const config: Config = {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    './node_modules/@tremor/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        card: {
          DEFAULT: 'var(--card)',
          foreground: 'var(--card-foreground)',
        },
        border: 'var(--border)',
        input: 'var(--input)',
        muted: {
          DEFAULT: 'var(--muted)',
          foreground: 'var(--muted-foreground)',
        },
        primary: {
          DEFAULT: 'var(--primary)',
          foreground: 'var(--primary-foreground)',
        },
        secondary: {
          DEFAULT: 'var(--secondary)',
          foreground: 'var(--secondary-foreground)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--accent-foreground)',
        },
        destructive: {
          DEFAULT: 'var(--destructive)',
          foreground: 'var(--destructive-foreground)',
        },
        ring: 'var(--ring)',

        // Tremor's own palette, remapped to our near-black system so its
        // charts/KPI cards sit flush with everything else instead of
        // looking like a different app. Values chosen to echo
        // --background/--card/--border rather than Tremor's light defaults.
        tremor: {
          brand: {
            faint: '#0B1229',
            muted: '#1E2A4A',
            subtle: '#2F5FD6',
            DEFAULT: '#3B82F6',
            emphasis: '#60A5FA',
            inverted: '#04050A',
          },
          background: {
            muted: '#101219',
            subtle: '#171A22',
            DEFAULT: 'var(--card)',
            emphasis: '#D1D5DB',
          },
          border: { DEFAULT: 'var(--border)' },
          ring: { DEFAULT: 'var(--border)' },
          content: {
            subtle: '#5B606E',
            DEFAULT: 'var(--muted-foreground)',
            emphasis: '#E5E7EB',
            strong: 'var(--foreground)',
            inverted: '#000000',
          },
        },
      },
      backgroundImage: {
        'gradient-baseline':
          'linear-gradient(135deg, var(--gradient-baseline-from) 0%, var(--gradient-baseline-to) 100%)',
        'gradient-optimized':
          'linear-gradient(135deg, var(--gradient-optimized-from) 0%, var(--gradient-optimized-to) 100%)',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 4px)',
        sm: 'calc(var(--radius) - 8px)',
        'tremor-small': '0.375rem',
        'tremor-default': '0.5rem',
        'tremor-full': '9999px',
      },
      fontSize: {
        'tremor-label': ['0.75rem'],
        'tremor-default': ['0.875rem', { lineHeight: '1.25rem' }],
        'tremor-title': ['1.125rem', { lineHeight: '1.75rem' }],
        'tremor-metric': ['1.875rem', { lineHeight: '2.25rem' }],
      },
      boxShadow: {
        'glow-baseline':
          '0 0 0 1px rgba(34,211,238,0.18), 0 0 28px -6px rgba(139,92,246,0.35)',
        'glow-optimized':
          '0 0 0 1px rgba(245,158,11,0.18), 0 0 28px -6px rgba(34,197,94,0.35)',
      },
    },
  },
  safelist: [
    {
      pattern:
        /^(bg|text|border|ring|fill|stroke)-(cyan|violet|amber|emerald|red|gray|blue)-(50|100|200|300|400|500|600|700|800|900)$/,
      variants: ['hover', 'dark'],
    },
  ],
  plugins: [require('tailwindcss-animate')],
};

export default config;
