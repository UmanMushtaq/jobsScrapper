import { AnalyticsData, CountBucket, WindowDays } from './job-search/analytics';
import { DESIGN_SYSTEM_CSS, renderSidebar } from './design-system';

// No charting library is installed anywhere in this project (checked package.json before
// writing this) — every chart here is plain HTML/CSS bars or a hand-built inline SVG
// polyline, matching the rest of the app's server-rendered-HTML-with-inline-styles
// convention (see app.service.ts) rather than adding a new frontend dependency for a
// handful of bar charts.

const MAX_BARS = 15;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderBarChart(title: string, buckets: CountBucket[], color: string): string {
  if (buckets.length === 0) {
    return `<div class="card">
      <h2>${escapeHtml(title)}</h2>
      <p class="empty">No data in this window.</p>
    </div>`;
  }

  const shown = buckets.slice(0, MAX_BARS);
  const overflow = buckets.length - shown.length;
  const max = Math.max(...shown.map((b) => b.count), 1);

  const rows = shown.map((b) => {
    const pct = Math.max(2, Math.round((b.count / max) * 100));
    return `<div class="bar-row">
      <div class="bar-label" title="${escapeHtml(b.label)}">${escapeHtml(b.label)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color};"></div></div>
      <div class="bar-count">${b.count}</div>
    </div>`;
  }).join('');

  return `<div class="card">
    <h2>${escapeHtml(title)}</h2>
    <div class="bar-chart">${rows}</div>
    ${overflow > 0 ? `<p class="empty">+${overflow} more not shown</p>` : ''}
  </div>`;
}

function renderStatusBreakdown(breakdown: AnalyticsData['statusBreakdown']): string {
  const total = breakdown.applied + breakdown.dismissed + breakdown.pending;
  if (total === 0) {
    return `<div class="card">
      <h2>Applied vs. dismissed vs. pending</h2>
      <p class="empty">No data in this window.</p>
    </div>`;
  }

  const segments: Array<{ key: string; count: number; color: string }> = [
    { key: 'Applied', count: breakdown.applied, color: '#16a34a' },
    { key: 'Dismissed', count: breakdown.dismissed, color: '#dc2626' },
    { key: 'Pending', count: breakdown.pending, color: '#9ca3af' },
  ];

  const bar = segments
    .filter((s) => s.count > 0)
    .map((s) => `<div style="width:${(s.count / total) * 100}%;background:${s.color};" title="${s.key}: ${s.count}"></div>`)
    .join('');

  const legend = segments
    .map((s) => `<span class="legend-item"><span class="legend-swatch" style="background:${s.color};"></span>${s.key}: <strong>${s.count}</strong></span>`)
    .join('');

  return `<div class="card">
    <h2>Applied vs. dismissed vs. pending</h2>
    <div class="stacked-bar">${bar}</div>
    <div class="legend">${legend}</div>
  </div>`;
}

function renderTrendChart(trend: AnalyticsData['trend']): string {
  if (trend.length < 2) {
    return `<div class="card">
      <h2>Trend over time</h2>
      <p class="empty">Not enough data yet to plot a trend (need at least 2 days in this window).</p>
    </div>`;
  }

  const width = 640;
  const height = 160;
  const padX = 30;
  const padY = 20;
  const max = Math.max(...trend.map((t) => t.count), 1);
  const stepX = trend.length > 1 ? (width - padX * 2) / (trend.length - 1) : 0;

  const points = trend.map((t, i) => {
    const x = padX + i * stepX;
    const y = height - padY - (t.count / max) * (height - padY * 2);
    return { x, y, t };
  });

  const polyline = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const dots = points.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="#2563eb"><title>${escapeHtml(p.t.date)}: ${p.t.count}</title></circle>`).join('');

  // Label only the first, middle, and last day to avoid clutter on a wide window.
  const labelIdx = new Set([0, Math.floor(points.length / 2), points.length - 1]);
  const labels = points
    .filter((_, i) => labelIdx.has(i))
    .map((p) => `<text x="${p.x.toFixed(1)}" y="${height - 4}" font-size="10" fill="#6b7280" text-anchor="middle">${escapeHtml(p.t.date.slice(5))}</text>`)
    .join('');

  return `<div class="card">
    <h2>Trend over time</h2>
    <svg viewBox="0 0 ${width} ${height}" style="width:100%;height:auto;max-width:${width}px;">
      <polyline points="${polyline}" fill="none" stroke="#2563eb" stroke-width="2" />
      ${dots}
      ${labels}
    </svg>
  </div>`;
}

function renderWindowSelector(current: WindowDays): string {
  const options: Array<{ value: string; label: string }> = [
    { value: '7', label: 'Last 7 days' },
    { value: '30', label: 'Last 30 days' },
    { value: '90', label: 'Last 90 days' },
    { value: 'all', label: 'All time' },
  ];
  const currentValue = String(current);
  const links = options
    .map((o) => {
      const active = o.value === currentValue;
      return `<a href="/analytics?days=${o.value}" class="window-opt${active ? ' active' : ''}">${o.label}</a>`;
    })
    .join('');
  return `<div class="window-selector">${links}</div>`;
}

export function renderAnalyticsPage(data: AnalyticsData): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sources &amp; Applications — Job Search Bot</title>
    <style>${DESIGN_SYSTEM_CSS}
      .subtitle { margin: 0 0 4px; }
      .window-selector { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 18px; }
      .window-opt { padding: 6px 14px; font-size: 13px; font-weight: 600; border-radius: 999px;
                    background: white; border: 1px solid var(--color-border-strong); color: var(--color-text); text-decoration: none; }
      .window-opt.active { background: var(--color-primary); color: white; border-color: var(--color-primary); }
      .bar-chart { display: flex; flex-direction: column; gap: 10px; }
      .bar-row { display: grid; grid-template-columns: 140px 1fr 44px; align-items: center; gap: 10px; }
      .bar-label { font-size: 13px; color: var(--color-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bar-track { background: var(--color-surface-alt); border-radius: 6px; height: 16px; overflow: hidden; }
      .bar-fill { height: 100%; border-radius: 6px; }
      .bar-count { font-size: 13px; font-weight: 600; color: var(--color-text); text-align: right; }
      .stacked-bar { display: flex; height: 22px; border-radius: 8px; overflow: hidden; background: var(--color-surface-alt); }
      .legend { display: flex; gap: 16px; margin-top: 12px; flex-wrap: wrap; }
      .legend-item { font-size: 13px; color: var(--color-text); display: flex; align-items: center; gap: 6px; }
      .legend-swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
      .data-note { color: var(--color-text-faint); font-size: 12px; line-height: 1.6; margin: 0; }
    </style>
  </head>
  <body>
    <div class="app-shell">
      ${renderSidebar('/analytics')}
      <div class="main-area">
        <div class="page">

        <div class="content-topbar">
          <div>
            <div class="breadcrumb">Overview</div>
            <h1>Sources &amp; Applications</h1>
            <p class="subtitle" style="margin:4px 0 0;">Where jobs are coming from and where you're actually applying — read-only, updates independently of the main dashboard.</p>
          </div>
        </div>

      <div class="card">
        <div class="nav"><a href="/">← Back to Dashboard</a></div>
        ${renderWindowSelector(data.windowDays)}
        <p class="data-note">${escapeHtml(data.dataNote)}</p>
      </div>

      ${renderBarChart('Jobs found by source', data.jobsBySource, '#2563eb')}
      ${renderBarChart('Applications by source', data.applicationsBySource, '#16a34a')}
      ${renderBarChart('Jobs by country', data.jobsByCountry, '#7c3aed')}
      ${renderStatusBreakdown(data.statusBreakdown)}
      ${renderTrendChart(data.trend)}
        </div>
      </div>
    </div>
  </body>
</html>`;
}
