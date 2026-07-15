// Shared visual design system for every server-rendered HTML page in this app.
// Pure CSS — no logic, no data, no behavior. Injected via ${DESIGN_SYSTEM_CSS} at the
// top of each page's <style> block so every page shares one color palette, type scale,
// spacing scale, and component set (header bar, buttons, badges, tables, empty states)
// instead of each page re-declaring its own slightly-different copy of the same rules.
//
// Modeled on modern professional SaaS admin dashboards (Linear/Vercel/Stripe/Notion):
// restrained, information-dense but organized — near-white page background with white
// cards lifting off it, a single indigo/blue accent used consistently rather than
// scattered, muted (not saturated) status colors, and a real top header bar instead of
// nav links buried in a page's first card.
export const DESIGN_SYSTEM_CSS = `
      :root {
        /* Color palette */
        --color-primary: #4f46e5;
        --color-primary-dark: #4338ca;
        --color-primary-bg: #eef2ff;
        --color-primary-border: #c7d2fe;

        --color-bg: #fafafa;
        --color-surface: #ffffff;
        --color-surface-alt: #f8f8f9;
        --color-border: #e4e4e7;
        --color-border-strong: #d4d4d8;

        --color-text: #18181b;
        --color-text-muted: #71717a;
        --color-text-faint: #a1a1aa;

        /* Semantic status colors — muted, not saturated */
        --color-success: #16a34a;
        --color-success-bg: #f0fdf4;
        --color-success-border: #bbf7d0;

        --color-warning: #d97706;
        --color-warning-bg: #fffbeb;
        --color-warning-border: #fde68a;

        --color-danger: #dc2626;
        --color-danger-bg: #fef2f2;
        --color-danger-border: #fecaca;

        --color-neutral: #71717a;
        --color-neutral-bg: #f4f4f5;
        --color-neutral-border: #d4d4d8;

        /* Spacing scale (strict 4px base) */
        --space-1: 4px;
        --space-2: 8px;
        --space-3: 12px;
        --space-4: 16px;
        --space-5: 24px;
        --space-6: 32px;
        --space-7: 48px;

        /* Type scale */
        --font-size-xs: 12px;
        --font-size-sm: 13px;
        --font-size-base: 14px;
        --font-size-lg: 17px;
        --font-size-xl: 26px;

        --radius: 6px;
        --radius-lg: 10px;
        --radius-pill: 999px;

        --header-height: 60px;
        --content-max-width: 1280px;
      }

      *, *::before, *::after { box-sizing: border-box; }

      html, body { margin: 0; padding: 0; }

      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif;
        background: var(--color-bg);
        color: var(--color-text);
        min-height: 100vh;
        font-size: var(--font-size-base);
        line-height: 1.5;
      }

      /* ── Top header bar — full-bleed, sits outside the content container ─── */
      .app-header {
        height: var(--header-height);
        display: flex;
        align-items: center;
        background: var(--color-surface);
        border-bottom: 1px solid var(--color-border);
      }
      .app-header-inner {
        width: 100%;
        max-width: var(--content-max-width);
        margin: 0 auto;
        padding: 0 var(--space-5);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-4);
        flex-wrap: wrap;
      }
      .app-header-brand {
        font-size: var(--font-size-base);
        font-weight: 600;
        color: var(--color-text);
        text-decoration: none;
        white-space: nowrap;
      }
      .app-header-links { display: flex; flex-wrap: wrap; gap: var(--space-1); align-items: center; }
      .app-header-links a {
        color: var(--color-text-muted);
        text-decoration: none;
        font-size: var(--font-size-sm);
        font-weight: 500;
        padding: var(--space-1) var(--space-3);
        border-radius: var(--radius);
        transition: background .15s, color .15s;
      }
      .app-header-links a:hover { background: var(--color-surface-alt); color: var(--color-text); }
      .app-header-links a.active { color: var(--color-primary); background: var(--color-primary-bg); }

      /* ── Page content container ─────────────────────────────────────────── */
      .page { max-width: var(--content-max-width); margin: 0 auto; padding: var(--space-5) var(--space-5) var(--space-7); }

      h1 { margin: 0; font-size: var(--font-size-xl); font-weight: 600; letter-spacing: -.01em; }
      h2 { margin: 0 0 var(--space-4); font-size: var(--font-size-lg); font-weight: 600; color: var(--color-text); }
      .subtitle { color: var(--color-text-muted); font-size: var(--font-size-base); margin: 0 0 var(--space-5); }
      .empty { color: var(--color-text-faint); font-size: var(--font-size-sm); margin: 0; }

      a { color: var(--color-primary); }

      /* Legacy simple "← Back to Dashboard" nav — kept for the rare page rendered
         standalone (outside the standard .app-header layout), e.g. error/fallback
         states that don't go through the full header markup. */
      .nav { margin-bottom: var(--space-5); }
      .nav a { color: var(--color-primary); text-decoration: none; font-size: var(--font-size-base); font-weight: 600; }

      /* ── Cards ───────────────────────────────────────────────────────────── */
      .card {
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        padding: var(--space-5);
        margin-bottom: var(--space-5);
      }

      /* ── Buttons ─────────────────────────────────────────────────────────── */
      .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: var(--space-1);
        height: 38px;
        padding: 0 var(--space-4);
        border-radius: var(--radius);
        font-size: var(--font-size-sm);
        font-weight: 600;
        border: 1px solid transparent;
        cursor: pointer;
        text-decoration: none;
        line-height: 1;
        transition: background .15s, border-color .15s, opacity .15s;
      }
      .btn:disabled { opacity: .5; cursor: not-allowed; }
      .btn-primary { background: var(--color-primary); color: white; }
      .btn-primary:hover:not(:disabled) { background: var(--color-primary-dark); }
      .btn-secondary { background: var(--color-surface); color: var(--color-text); border-color: var(--color-border-strong); }
      .btn-secondary:hover:not(:disabled) { background: var(--color-surface-alt); }
      .btn-neutral { background: var(--color-neutral-bg); color: #3f3f46; border-color: var(--color-border-strong); }
      .btn-neutral:hover:not(:disabled) { background: #e4e4e7; }
      .btn-success { background: var(--color-success); color: white; }
      .btn-success:hover:not(:disabled) { background: #15803d; }
      .btn-danger { background: var(--color-danger-bg); color: var(--color-danger); border-color: var(--color-danger-border); }
      .btn-danger:hover:not(:disabled) { background: #fee2e2; }
      .btn-block { display: flex; width: 100%; }
      .btn-sm { height: 30px; padding: 0 var(--space-3); font-size: var(--font-size-xs); }

      /* ── Badges / status pills ───────────────────────────────────────────── */
      .badge {
        display: inline-flex;
        align-items: center;
        padding: 2px var(--space-3);
        border-radius: var(--radius-pill);
        font-size: var(--font-size-xs);
        font-weight: 600;
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
        gap: var(--space-4) var(--space-5);
        margin: var(--space-4) 0 var(--space-5);
      }
      .meta-item label {
        display: block; font-size: var(--font-size-xs); font-weight: 600;
        color: var(--color-text-faint); text-transform: uppercase; letter-spacing: .04em; margin-bottom: 4px;
      }
      .meta-item span { font-size: var(--font-size-base); color: var(--color-text); font-weight: 500; }

      .error-box {
        background: var(--color-danger-bg); border: 1px solid var(--color-danger-border);
        border-radius: var(--radius); padding: var(--space-3) var(--space-4);
        font-size: var(--font-size-sm); color: var(--color-danger); margin: var(--space-4) 0 0;
      }

      /* ── Tables ──────────────────────────────────────────────────────────── */
      table { width: 100%; border-collapse: collapse; }
      thead th {
        padding: var(--space-3) var(--space-4);
        text-align: left; font-size: var(--font-size-xs); font-weight: 600;
        color: var(--color-text-muted); text-transform: uppercase; letter-spacing: .02em;
        border-bottom: 1px solid var(--color-border); white-space: nowrap;
      }
      thead th.num, tbody td.num { text-align: right; }
      thead th.center, tbody td.center { text-align: center; }
      tbody tr { transition: background .12s; }
      tbody tr:hover { background: var(--color-surface-alt); }
      tbody td { padding: var(--space-4); border-bottom: 1px solid var(--color-border); vertical-align: middle; }
      tbody tr:last-child td { border-bottom: 0; }
      .table-wrap { overflow-x: auto; border-radius: var(--radius-lg); border: 1px solid var(--color-border); }

      /* ── Loading / empty states ──────────────────────────────────────────── */
      .empty-state {
        text-align: center; padding: var(--space-7) var(--space-4);
        color: var(--color-text-muted); font-size: var(--font-size-base);
      }
      .loading-state {
        display: flex; align-items: center; justify-content: center; gap: var(--space-2);
        padding: var(--space-6) var(--space-4); color: var(--color-text-faint); font-size: var(--font-size-sm);
      }
      .spinner {
        width: 14px; height: 14px; border-radius: 50%;
        border: 2px solid var(--color-border); border-top-color: var(--color-primary);
        animation: ds-spin .7s linear infinite;
      }
      @keyframes ds-spin { to { transform: rotate(360deg); } }

      @media (max-width: 700px) {
        .page { padding: var(--space-4) var(--space-3) var(--space-6); }
        .card { padding: var(--space-4); }
        .app-header-inner { padding: 0 var(--space-4); }
      }
`;
