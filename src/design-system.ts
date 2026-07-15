// Shared visual design system for every server-rendered HTML page in this app.
// Pure CSS — no logic, no data, no behavior. Injected via ${DESIGN_SYSTEM_CSS} at the
// top of each page's <style> block so every page shares one color palette, type scale,
// spacing scale, and component set (buttons, badges, nav bar, tables, empty states)
// instead of each page re-declaring its own slightly-different copy of the same rules.
//
// Palette/scale choices are additive over what individual pages already used (most
// pages already leaned on #2563eb blue / green-success / red-danger / amber-warning
// fairly consistently) — this formalizes that into custom properties and reusable
// classes rather than inventing a new look from scratch.
export const DESIGN_SYSTEM_CSS = `
      :root {
        /* Color palette */
        --color-primary: #2563eb;
        --color-primary-dark: #1d4ed8;
        --color-primary-bg: #eff6ff;
        --color-primary-border: #bfdbfe;

        --color-bg: #f1f5f9;
        --color-surface: #ffffff;
        --color-surface-alt: #f8fafc;
        --color-border: #e5e7eb;
        --color-border-strong: #d1d5db;

        --color-text: #111827;
        --color-text-muted: #6b7280;
        --color-text-faint: #9ca3af;

        /* Semantic status colors */
        --color-success: #15803d;
        --color-success-bg: #dcfce7;
        --color-success-border: #bbf7d0;

        --color-warning: #92400e;
        --color-warning-bg: #fef3c7;
        --color-warning-border: #fde68a;

        --color-danger: #b91c1c;
        --color-danger-bg: #fee2e2;
        --color-danger-border: #fecaca;

        --color-neutral: #6b7280;
        --color-neutral-bg: #f3f4f6;
        --color-neutral-border: #d1d5db;

        /* Spacing scale (4/8/16/24/32/40px) */
        --space-1: 4px;
        --space-2: 8px;
        --space-3: 16px;
        --space-4: 24px;
        --space-5: 32px;
        --space-6: 40px;

        /* Type scale */
        --font-size-xs: 11px;
        --font-size-sm: 13px;
        --font-size-base: 14px;
        --font-size-lg: 17px;
        --font-size-xl: 22px;
        --font-size-2xl: 26px;

        --radius: 8px;
        --radius-lg: 14px;
        --radius-pill: 999px;
      }

      *, *::before, *::after { box-sizing: border-box; }

      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        margin: 0;
        padding: var(--space-4) var(--space-3);
        background: var(--color-bg);
        color: var(--color-text);
        min-height: 100vh;
        font-size: var(--font-size-base);
        line-height: 1.5;
      }

      .page { max-width: 1280px; margin: 0 auto; }

      h1 { margin: 0; font-size: var(--font-size-xl); font-weight: 700; }
      h2 { margin: 0 0 var(--space-3); font-size: var(--font-size-lg); font-weight: 600; color: var(--color-text); }
      .subtitle { color: var(--color-text-muted); font-size: var(--font-size-base); margin: 0 0 var(--space-4); }
      .empty { color: var(--color-text-faint); font-size: var(--font-size-sm); margin: 0; }

      a { color: var(--color-primary); }

      /* ── Nav bar ─────────────────────────────────────────────────────────── */
      .navbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: var(--space-2) var(--space-3);
        margin-bottom: var(--space-4);
      }
      .navbar-brand { font-size: var(--font-size-lg); font-weight: 700; color: var(--color-text); text-decoration: none; }
      .navbar-links { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-3); align-items: center; }
      .navbar-links a {
        color: var(--color-text-muted);
        text-decoration: none;
        font-size: var(--font-size-sm);
        font-weight: 600;
        padding: var(--space-1) var(--space-2);
        border-radius: var(--radius);
      }
      .navbar-links a:hover { background: var(--color-surface-alt); color: var(--color-primary); }
      .navbar-links a.active { color: var(--color-primary); background: var(--color-primary-bg); }

      /* Legacy simple "← Back to Dashboard" nav, kept for pages that only need one link */
      .nav { margin-bottom: var(--space-4); }
      .nav a { color: var(--color-primary); text-decoration: none; font-size: var(--font-size-base); font-weight: 600; }

      /* ── Cards ───────────────────────────────────────────────────────────── */
      .card {
        background: var(--color-surface);
        border-radius: var(--radius-lg);
        padding: var(--space-4);
        box-shadow: 0 1px 4px rgba(0,0,0,0.06), 0 4px 16px rgba(0,0,0,0.04);
        margin-bottom: var(--space-4);
      }

      /* ── Buttons ─────────────────────────────────────────────────────────── */
      .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: var(--space-1);
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius);
        font-size: var(--font-size-sm);
        font-weight: 600;
        border: 1px solid transparent;
        cursor: pointer;
        text-decoration: none;
        line-height: 1.2;
        transition: background .12s, border-color .12s, opacity .12s;
      }
      .btn:disabled { opacity: .5; cursor: not-allowed; }
      .btn-primary { background: var(--color-primary); color: white; }
      .btn-primary:hover:not(:disabled) { background: var(--color-primary-dark); }
      .btn-secondary { background: var(--color-surface-alt); color: var(--color-primary-dark); border-color: var(--color-primary-border); }
      .btn-secondary:hover:not(:disabled) { background: var(--color-primary-bg); }
      .btn-neutral { background: var(--color-neutral-bg); color: #374151; border-color: var(--color-border-strong); }
      .btn-neutral:hover:not(:disabled) { background: #e5e7eb; }
      .btn-success { background: var(--color-success); color: white; }
      .btn-success:hover:not(:disabled) { background: #166534; }
      .btn-danger { background: var(--color-danger-bg); color: var(--color-danger); border-color: var(--color-danger-border); }
      .btn-danger:hover:not(:disabled) { background: #fecaca; }
      .btn-block { display: flex; width: 100%; }
      .btn-sm { padding: var(--space-1) var(--space-2); font-size: var(--font-size-xs); }

      /* ── Badges / status pills ───────────────────────────────────────────── */
      .badge {
        display: inline-flex;
        align-items: center;
        padding: 2px var(--space-2);
        border-radius: var(--radius-pill);
        font-size: var(--font-size-xs);
        font-weight: 700;
        border: 1px solid transparent;
        white-space: nowrap;
      }
      .badge-success { background: var(--color-success-bg); color: var(--color-success); border-color: var(--color-success-border); }
      .badge-warning { background: var(--color-warning-bg); color: var(--color-warning); border-color: var(--color-warning-border); }
      .badge-danger { background: var(--color-danger-bg); color: var(--color-danger); border-color: var(--color-danger-border); }
      .badge-neutral { background: var(--color-neutral-bg); color: var(--color-text-muted); border-color: var(--color-neutral-border); }
      .badge-info { background: var(--color-primary-bg); color: var(--color-primary-dark); border-color: var(--color-primary-border); }

      /* ── Meta grid (label/value key facts, used on the home dashboard) ──── */
      .meta-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: var(--space-2) var(--space-4);
        margin: var(--space-3) 0 var(--space-4);
      }
      .meta-item label {
        display: block; font-size: var(--font-size-xs); font-weight: 600;
        color: var(--color-text-faint); text-transform: uppercase; letter-spacing: .05em; margin-bottom: 3px;
      }
      .meta-item span { font-size: var(--font-size-base); color: var(--color-text); font-weight: 500; }

      .error-box {
        background: var(--color-danger-bg); border: 1px solid var(--color-danger-border);
        border-radius: var(--radius); padding: var(--space-2) var(--space-3);
        font-size: var(--font-size-sm); color: var(--color-danger); margin: var(--space-3) 0 0;
      }

      /* ── Tables ──────────────────────────────────────────────────────────── */
      table { width: 100%; border-collapse: collapse; }
      thead th {
        background: var(--color-surface-alt); padding: var(--space-3) var(--space-3);
        text-align: left; font-size: var(--font-size-xs); font-weight: 700;
        color: var(--color-text-muted); text-transform: uppercase; letter-spacing: .06em;
        border-bottom: 2px solid var(--color-border); white-space: nowrap;
      }
      tbody tr { transition: background .1s; }
      tbody tr:nth-child(even) { background: var(--color-surface-alt); }
      tbody tr:hover { background: var(--color-primary-bg) !important; }
      tbody td { padding: var(--space-3); border-bottom: 1px solid #f3f4f6; vertical-align: middle; }
      tbody tr:last-child td { border-bottom: 0; }
      .table-wrap { overflow-x: auto; border-radius: 10px; border: 1px solid var(--color-border); }

      /* ── Loading / empty states ──────────────────────────────────────────── */
      .empty-state {
        text-align: center; padding: var(--space-6) var(--space-3);
        color: var(--color-text-muted); font-size: var(--font-size-base);
      }
      .loading-state {
        display: flex; align-items: center; justify-content: center; gap: var(--space-2);
        padding: var(--space-5) var(--space-3); color: var(--color-text-faint); font-size: var(--font-size-sm);
      }
      .spinner {
        width: 14px; height: 14px; border-radius: 50%;
        border: 2px solid var(--color-border); border-top-color: var(--color-primary);
        animation: ds-spin .7s linear infinite;
      }
      @keyframes ds-spin { to { transform: rotate(360deg); } }

      @media (max-width: 700px) {
        body { padding: var(--space-2); }
        .card { padding: var(--space-3); }
      }
`;
