import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // All colors use CSS custom properties so themes can swap them at runtime.
        // CSS vars hold space-separated RGB triplets so Tailwind's opacity modifier
        // syntax (e.g. bg-accent/30) works correctly.
        // The triplets themselves live in client/src/index.css, one block per theme
        // ([data-theme="obli-operator" | "obli-daylight" | "modern" | "neon"]).
        bg: {
          primary:   'rgb(var(--c-bg-primary)   / <alpha-value>)',
          secondary: 'rgb(var(--c-bg-secondary) / <alpha-value>)',
          tertiary:  'rgb(var(--c-bg-tertiary)  / <alpha-value>)',
          hover:     'rgb(var(--c-bg-hover)     / <alpha-value>)',
          active:    'rgb(var(--c-bg-active)    / <alpha-value>)',
        },
        // NOTE - design-system hard rule: no `border:` on cards / pills / buttons.
        // These tokens exist only for hairline separators (table rules, the topbar
        // under-line, the vertical rule in the user badge). Never for a card outline.
        border: {
          DEFAULT: 'rgb(var(--c-border)       / <alpha-value>)',
          light:   'rgb(var(--c-border-light) / <alpha-value>)',
        },
        text: {
          primary:   'rgb(var(--c-text-primary)   / <alpha-value>)',
          secondary: 'rgb(var(--c-text-secondary) / <alpha-value>)',
          muted:     'rgb(var(--c-text-muted)     / <alpha-value>)',
        },
        // -- Ticket status colors --------------------------------------------
        // Keyed by the MANDATORY hard-coded status CATEGORY enum, never by a
        // configurable status slug. A tenant may name a status "Waiting on
        // customer"; its category is still pending_requester, and the pill
        // paints itself with `status-pending-requester`. Mapping helper:
        //   `status-${category.replace(/_/g, '-')}`
        status: {
          'new':                    'rgb(var(--c-status-new)                    / <alpha-value>)',
          'new-bg':                 'rgb(var(--c-status-new-bg)                 / <alpha-value>)',
          'open':                   'rgb(var(--c-status-open)                   / <alpha-value>)',
          'open-bg':                'rgb(var(--c-status-open-bg)                / <alpha-value>)',
          'pending-requester':      'rgb(var(--c-status-pending-requester)      / <alpha-value>)',
          'pending-requester-bg':   'rgb(var(--c-status-pending-requester-bg)   / <alpha-value>)',
          'pending-third-party':    'rgb(var(--c-status-pending-third-party)    / <alpha-value>)',
          'pending-third-party-bg': 'rgb(var(--c-status-pending-third-party-bg) / <alpha-value>)',
          'scheduled':              'rgb(var(--c-status-scheduled)              / <alpha-value>)',
          'scheduled-bg':           'rgb(var(--c-status-scheduled-bg)           / <alpha-value>)',
          'resolved':               'rgb(var(--c-status-resolved)               / <alpha-value>)',
          'resolved-bg':            'rgb(var(--c-status-resolved-bg)            / <alpha-value>)',
          'closed':                 'rgb(var(--c-status-closed)                 / <alpha-value>)',
          'closed-bg':              'rgb(var(--c-status-closed-bg)              / <alpha-value>)',
          'cancelled':              'rgb(var(--c-status-cancelled)              / <alpha-value>)',
          'cancelled-bg':           'rgb(var(--c-status-cancelled-bg)           / <alpha-value>)',
        },
        // -- Priority colors -------------------------------------------------
        // p1 = critical ... p4 = low. Priorities are configurable per tenant but
        // every priority config carries a rank 1-4 that selects one of these.
        priority: {
          'p1':    'rgb(var(--c-priority-p1)    / <alpha-value>)',
          'p1-bg': 'rgb(var(--c-priority-p1-bg) / <alpha-value>)',
          'p2':    'rgb(var(--c-priority-p2)    / <alpha-value>)',
          'p2-bg': 'rgb(var(--c-priority-p2-bg) / <alpha-value>)',
          'p3':    'rgb(var(--c-priority-p3)    / <alpha-value>)',
          'p3-bg': 'rgb(var(--c-priority-p3-bg) / <alpha-value>)',
          'p4':    'rgb(var(--c-priority-p4)    / <alpha-value>)',
          'p4-bg': 'rgb(var(--c-priority-p4-bg) / <alpha-value>)',
        },
        // -- SLA clock colors ------------------------------------------------
        // ok = comfortably inside the target, warn = inside the at-risk window,
        // breach = target passed, paused = clock stopped (pending_* / scheduled).
        sla: {
          'ok':        'rgb(var(--c-sla-ok)        / <alpha-value>)',
          'ok-bg':     'rgb(var(--c-sla-ok-bg)     / <alpha-value>)',
          'warn':      'rgb(var(--c-sla-warn)      / <alpha-value>)',
          'warn-bg':   'rgb(var(--c-sla-warn-bg)   / <alpha-value>)',
          'breach':    'rgb(var(--c-sla-breach)    / <alpha-value>)',
          'breach-bg': 'rgb(var(--c-sla-breach-bg) / <alpha-value>)',
          'paused':    'rgb(var(--c-sla-paused)    / <alpha-value>)',
          'paused-bg': 'rgb(var(--c-sla-paused-bg) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--c-accent)       / <alpha-value>)',
          hover:   'rgb(var(--c-accent-hover) / <alpha-value>)',
          dark:    'rgb(var(--c-accent-dark)  / <alpha-value>)',
        },
        // Alias used by the enrollment wizard and interactive components
        primary: 'rgb(var(--c-primary) / <alpha-value>)',
        // Obli Suite brand palette - used by the topbar app switcher
        // and the per-app active-pill highlight. Values fixed per
        // D:/Mockup/obli-design-system.md section 1; not theme-swappable.
        obli: {
          view:   '#2bc4bd',
          guard:  '#f5a623',
          guard2: '#ffb84a',
          map:    '#1edd8a',
          ance:   '#e03a3a',
          hub:    '#2d4ec9',
          desk:   '#22b8f5',
          desk2:  '#5fd0ff',
        },
      },
      fontFamily: {
        // Obli Design v1 section 11 - two-tier font stack:
        //   font-sans     -> Inter / system stack for body, nav, table rows
        //   font-display  -> Rajdhani for headings + hero values (>= 24px only)
        //   font-mono     -> JetBrains Mono for ticket keys / counts / timestamps
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Noto Sans',
          'Helvetica',
          'Arial',
          'sans-serif',
        ],
        display: [
          'Rajdhani',
          'Inter',
          '-apple-system',
          'Segoe UI',
          'sans-serif',
        ],
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
      },
      boxShadow: {
        // Depth without borders (design-system section 2 hard rule). The raw
        // values are theme-dependent and defined as --shadow-* in index.css.
        card: 'var(--shadow-card)',
        glow: 'var(--shadow-glow)',
      },
      borderRadius: {
        // Section 8 shape system - pills 7px, cards 10px, modals 14px.
        pill: '7px',
        card: '10px',
        modal: '14px',
      },
    },
  },
  plugins: [],
} satisfies Config;
