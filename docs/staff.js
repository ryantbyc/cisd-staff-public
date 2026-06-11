'use strict';

// ─── STATE ───────────────────────────────────────────────────────────────────
let META = null, TURN = null, JOBS = null;
const TAB_RENDERED = new Set();
const PAGE_SIZE = 25;
const TURN_MONTH_LABELS = ['Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar','Apr','May','Jun'];

// Campus tab state
let campusSortKey  = 'hires';
let campusSortDir  = -1;
let campusTypeFilter = 'all';
let campusSearch   = '';
let campusPage     = 0;

// ─── UTILITIES ────────────────────────────────────────────────────────────────
function fmt(n) {
  if (n == null || n === '') return '–';
  return Number(n).toLocaleString();
}

function netBadge(n) {
  if (n == null) return '<span class="net-badge net-zero">–</span>';
  const v = +n;
  if (v > 0) return `<span class="net-badge net-pos">+${fmt(v)}</span>`;
  if (v < 0) return `<span class="net-badge net-neg">${fmt(v)}</span>`;
  return `<span class="net-badge net-zero">0</span>`;
}

function fmtDateShort(iso) {
  if (!iso) return '–';
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-US', {year:'numeric', month:'short', day:'numeric'});
}

function loadJSON(url) {
  return fetch(url).then(r => {
    if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + url);
    return r.json();
  });
}

function monthLabelIndex(monthStr) {
  // "Jul 2024" → 0,  "Aug 2024" → 1, … "Jun 2025" → 11
  return TURN_MONTH_LABELS.indexOf(monthStr.slice(0, 3));
}

// ─── CHART UTILITIES ─────────────────────────────────────────────────────────
function niceTicks(lo, hi, count) {
  const range = hi - lo || 1;
  const raw   = range / count;
  const mag   = Math.pow(10, Math.floor(Math.log10(Math.abs(raw) || 1)));
  const step  = ([1, 2, 2.5, 5, 10].find(f => f * mag >= raw) || 10) * mag;
  const start = Math.floor(lo / step) * step;
  const ticks = [];
  for (let v = start; v <= hi + step * 0.01; v += step) {
    ticks.push(Math.round(v * 1e9) / 1e9);
  }
  return ticks;
}

// Monthly grouped bar chart (hires = green, departures = red)
// monthData: array of {hires, departures} indexed by TURN_MONTH_LABELS position (null = no data)
function buildMonthlyBarChart(monthData) {
  const W = 720, H = 230;
  const PAD = {top: 26, right: 20, bottom: 42, left: 50};
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top - PAD.bottom;
  const n  = TURN_MONTH_LABELS.length;
  const slotW = cW / n;
  const barW  = Math.min(slotW * 0.36, 14);

  const maxVal = Math.max(...monthData.map(d => d ? Math.max(d.hires||0, d.departures||0) : 0), 10);
  const yTicks = niceTicks(0, maxVal, 5);
  const yHi   = yTicks[yTicks.length - 1];
  const scaleY = v => PAD.top + cH - (v / yHi) * cH;

  let bars = '';
  monthData.forEach((d, i) => {
    if (!d) return;
    const cx = PAD.left + i * slotW + slotW / 2;
    const h   = ((d.hires||0)       / yHi) * cH;
    const dep = ((d.departures||0)  / yHi) * cH;
    bars += `<rect x="${(cx - barW - 1.5).toFixed(1)}" y="${(PAD.top + cH - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(h, 0.5).toFixed(1)}" fill="#1d7a40" rx="2"/>`;
    bars += `<rect x="${(cx + 1.5).toFixed(1)}"        y="${(PAD.top + cH - dep).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(dep, 0.5).toFixed(1)}" fill="#dc2626" rx="2"/>`;
  });

  const xLabels = TURN_MONTH_LABELS.map((lbl, i) => {
    const x = PAD.left + i * slotW + slotW / 2;
    return `<text x="${x.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="#888">${lbl}</text>`;
  }).join('');

  const yLines = yTicks.map(v => {
    const y = scaleY(v);
    return `<line x1="${PAD.left}" x2="${W - PAD.right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#e5e7eb" stroke-width="1"/>
<text x="${PAD.left - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#888">${fmt(v)}</text>`;
  }).join('');

  const leg = `<rect x="${PAD.left}" y="6" width="12" height="10" fill="#1d7a40" rx="2"/>
<text x="${PAD.left + 16}" y="15" font-size="11" fill="#555">Hires</text>
<rect x="${PAD.left + 60}" y="6" width="12" height="10" fill="#dc2626" rx="2"/>
<text x="${PAD.left + 76}" y="15" font-size="11" fill="#555">Departures</text>`;

  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;display:block" aria-hidden="true">
${yLines}${bars}${xLabels}${leg}
</svg>`;
}

// Cumulative net line chart — one line per school year, year labels at end of each line
function buildCumulativeChart(syMonthlyMap) {
  const W = 740, H = 230;
  const PAD = {top: 26, right: 58, bottom: 42, left: 60};
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top - PAD.bottom;
  const n  = TURN_MONTH_LABELS.length;
  const COLORS = ['#1d7a40', '#0ea5e9', '#d97706', '#7c3aed', '#e11d48'];

  // Build cumulative arrays for each SY
  const series = Object.entries(syMonthlyMap).map(([sy, entries], ci) => {
    const monthly = new Array(n).fill(null);
    (entries || []).forEach(d => {
      const idx = monthLabelIndex(d.month);
      if (idx >= 0) monthly[idx] = (monthly[idx] || 0) + (d.hires - d.departures);
    });
    let cum = 0, started = false;
    const cumArr = monthly.map(v => {
      if (v !== null) { started = true; cum += v; return cum; }
      return started ? cum : null;
    });
    return {sy, cumArr, color: COLORS[ci % COLORS.length]};
  });

  const allVals = series.flatMap(s => s.cumArr.filter(v => v !== null));
  if (!allVals.length) return '<p style="color:#888;font-size:.85rem;padding:1rem 0">No data available.</p>';

  const rawLo = Math.min(...allVals, 0);
  const rawHi = Math.max(...allVals, 0);
  const range  = rawHi - rawLo || 1;
  const pad    = range * 0.12;
  const yLo = rawLo - pad, yHi = rawHi + pad;
  const yTicks = niceTicks(yLo, yHi, 5);

  const scaleY = v => PAD.top + cH - ((v - yLo) / (yHi - yLo)) * cH;
  const scaleX = i => PAD.left + (i / (n - 1)) * cW;

  const yLines = yTicks.map(v => {
    const y = scaleY(v);
    return `<line x1="${PAD.left}" x2="${W - PAD.right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#e5e7eb" stroke-width="1"/>
<text x="${(PAD.left - 6)}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#888">${v >= 0 ? (v > 0 ? '+' : '') : ''}${fmt(v)}</text>`;
  }).join('');

  const y0 = scaleY(0);
  const zeroLine = `<line x1="${PAD.left}" x2="${W - PAD.right}" y1="${y0.toFixed(1)}" y2="${y0.toFixed(1)}" stroke="#9ca3af" stroke-width="1.5" stroke-dasharray="5,3"/>`;

  let paths = '', endLabels = '';
  series.forEach(({sy, cumArr, color}) => {
    let d = '';
    let lastX = null, lastY = null;
    cumArr.forEach((v, i) => {
      if (v === null) return;
      const x = scaleX(i), y = scaleY(v);
      d += d === '' ? `M${x.toFixed(1)},${y.toFixed(1)}` : ` L${x.toFixed(1)},${y.toFixed(1)}`;
      lastX = x; lastY = y;
    });
    if (d) {
      paths += `<path d="${d}" stroke="${color}" stroke-width="2.5" fill="none" stroke-linejoin="round"/>`;
      if (lastX !== null) {
        endLabels += `<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="3.5" fill="${color}"/>`;
        endLabels += `<text x="${(lastX + 7).toFixed(1)}" y="${(lastY + 4).toFixed(1)}" font-size="10" fill="${color}" font-weight="700">${sy}</text>`;
      }
    }
  });

  const xLabels = TURN_MONTH_LABELS.map((lbl, i) =>
    `<text x="${scaleX(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="#888">${lbl}</text>`
  ).join('');

  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;display:block" aria-hidden="true">
${yLines}${zeroLine}${paths}${endLabels}${xLabels}
</svg>`;
}

// Open positions line chart
function buildPositionsChart(data) {
  if (!data || data.length < 2) {
    return '<p style="color:#888;font-size:.85rem;padding:1rem 0">Insufficient data for trend chart.</p>';
  }
  const W = 720, H = 230;
  const PAD = {top: 26, right: 40, bottom: 50, left: 50};
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top - PAD.bottom;
  const n  = data.length;

  const totals   = data.map(d => d.total   || 0);
  const teachers = data.map(d => d.teacher || 0);
  const yMax = Math.max(...totals, 10);
  const yTicks = niceTicks(0, yMax, 5);
  const yStep = yTicks.length > 1 ? yTicks[1] - yTicks[0] : yMax;
  while (yTicks[yTicks.length - 1] < yMax) yTicks.push(yTicks[yTicks.length - 1] + yStep);
  const yHi = yTicks[yTicks.length - 1];

  const scaleY = v => PAD.top + cH - (v / yHi) * cH;
  const scaleX = i => PAD.left + (i / Math.max(n - 1, 1)) * cW;

  const yLines = yTicks.map(v => {
    const y = scaleY(v);
    return `<line x1="${PAD.left}" x2="${W - PAD.right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#e5e7eb" stroke-width="1"/>
<text x="${(PAD.left - 6)}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#888">${fmt(v)}</text>`;
  }).join('');

  let totalPath = '', teacherPath = '';
  data.forEach((d, i) => {
    const x = scaleX(i).toFixed(1);
    const yt  = scaleY(d.total   || 0).toFixed(1);
    const ytc = scaleY(d.teacher || 0).toFixed(1);
    totalPath   += totalPath   === '' ? `M${x},${yt}`  : ` L${x},${yt}`;
    teacherPath += teacherPath === '' ? `M${x},${ytc}` : ` L${x},${ytc}`;
  });

  // X labels: first, last, and evenly spaced
  const xStep = Math.max(1, Math.floor(n / 5));
  let xLabels = '';
  data.forEach((d, i) => {
    if (i === 0 || i === n - 1 || i % xStep === 0) {
      const dt  = new Date(d.date + 'T12:00:00');
      const lbl = dt.toLocaleDateString('en-US', {month:'short', day:'numeric'});
      xLabels += `<text x="${scaleX(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#888">${lbl}</text>`;
    }
  });

  // Value labels on last point
  const last = data[n - 1];
  const lx   = scaleX(n - 1).toFixed(1);
  const labels2 = `<text x="${(+lx + 5)}" y="${(+scaleY(last.total || 0) + 4).toFixed(1)}" font-size="11" fill="#1a4545" font-weight="600">${last.total}</text>`;

  const leg = `<rect x="${PAD.left}" y="8" width="20" height="4" fill="#1a4545" rx="2"/>
<text x="${PAD.left + 25}" y="16" font-size="11" fill="#555">Total Open</text>
<rect x="${PAD.left + 105}" y="8" width="20" height="4" fill="#c9a227" rx="2"/>
<text x="${PAD.left + 130}" y="16" font-size="11" fill="#555">Teacher</text>`;

  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;display:block" aria-hidden="true">
${yLines}
<path d="${totalPath}"   stroke="#1a4545" stroke-width="2.5" fill="none" stroke-linejoin="round"/>
<path d="${teacherPath}" stroke="#c9a227" stroke-width="2"   fill="none" stroke-linejoin="round" stroke-dasharray="6,3"/>
${labels2}${xLabels}${leg}
</svg>`;
}

// ─── OVERVIEW ────────────────────────────────────────────────────────────────
function renderOverview() {
  const sys = TURN.school_years;                    // ["2023-24","2024-25","2025-26"]
  const latestSY = sys[sys.length - 1];
  const prevSY   = sys[sys.length - 2] || null;
  const summary  = TURN.school_year_summary[latestSY] || {};
  const latest   = JOBS && JOBS.length ? JOBS[JOBS.length - 1] : null;

  // ── Summary cards ──
  const hires = summary.hires || 0;
  const depts = summary.departures || 0;
  const net   = summary.net || 0;
  const opens = latest ? latest.total : null;

  const cards = [
    { label: `${latestSY} Hires`,      value: fmt(hires), cls: 'summary-card--hire'    },
    { label: `${latestSY} Departures`, value: fmt(depts), cls: 'summary-card--dept'    },
    { label: 'Net Change',             value: (net >= 0 ? '+' : '') + fmt(net),
      cls: net >= 0 ? 'summary-card--hire' : 'summary-card--dept' },
    { label: 'Open Positions',         value: opens != null ? fmt(opens) : '–', cls: '' },
  ];
  document.getElementById('overview-cards').innerHTML = cards.map(c =>
    `<div class="summary-card ${c.cls}">
       <div class="card-value">${c.value}</div>
       <div class="card-label">${c.label}</div>
     </div>`
  ).join('');

  // ── Insight ──
  const prevSum = prevSY ? (TURN.school_year_summary[prevSY] || {}) : null;
  let insightHTML = '';
  if (net < 0) {
    insightHTML = `<div class="insight-box insight-warn">
      <strong>More departures than hires in ${latestSY}.</strong>
      CISD recorded <strong>${fmt(depts)}</strong> professional staff departures vs. <strong>${fmt(hires)}</strong> hires so far — a net of <strong>${net}</strong>.
      ${prevSum && prevSum.net != null ? `For comparison, ${prevSY} ended with a net of <strong>${prevSum.net >= 0 ? '+' : ''}${fmt(prevSum.net)}</strong>.` : ''}
    </div>`;
  } else {
    insightHTML = `<div class="insight-box">
      CISD recorded <strong>${fmt(hires)}</strong> professional staff hires vs. <strong>${fmt(depts)}</strong> departures in ${latestSY} — a net of <strong>+${fmt(net)}</strong>.
      ${prevSum && prevSum.net != null ? `For comparison, ${prevSY} ended with a net of <strong>${prevSum.net >= 0 ? '+' : ''}${fmt(prevSum.net)}</strong>.` : ''}
    </div>`;
  }
  document.getElementById('overview-insight').innerHTML = insightHTML;

  // ── Category breakdown ──
  const currCats = TURN.school_year_by_category[latestSY] || [];
  const prevCats = prevSY ? (TURN.school_year_by_category[prevSY] || []) : [];
  const prevMap  = Object.fromEntries(prevCats.map(c => [c.category, c]));

  document.getElementById('overview-cat-subtitle').textContent = latestSY + ' (partial year)';

  const catRows = currCats.map(c => {
    const p = prevMap[c.category] || {};
    return `<tr>
      <td>${c.category}</td>
      <td class="num">${fmt(c.hires)}</td>
      <td class="num">${fmt(c.departures)}</td>
      <td class="num">${netBadge(c.net)}</td>
      <td class="num col-hide">${fmt(p.hires)}</td>
      <td class="num col-hide">${fmt(p.departures)}</td>
    </tr>`;
  }).join('');
  document.getElementById('cat-body').innerHTML = catRows ||
    '<tr><td colspan="6" style="color:#888">No category data available.</td></tr>';

  // ── Year-over-Year summary ──
  const yoyRows = sys.slice().reverse().map(sy => {
    const s = TURN.school_year_summary[sy] || {};
    const partial = sy === latestSY ? ' <span style="color:#888;font-weight:400">(partial)</span>' : '';
    return `<tr>
      <td>${sy}${partial}</td>
      <td class="num">${fmt(s.hires)}</td>
      <td class="num">${fmt(s.departures)}</td>
      <td class="num">${netBadge(s.net)}</td>
      <td class="num col-hide">${s.hires != null ? '' : '—'}</td>
    </tr>`;
  }).join('');
  document.getElementById('yoy-body').innerHTML = yoyRows;

  // ── Source note ──
  const updated = META.last_updated ? fmtDateShort(META.last_updated.slice(0, 10)) : '';
  document.getElementById('overview-source').textContent =
    `Data from ${META.source || 'CISD Board HR Reports'}. Last updated: ${updated}.`;
}

// ─── TURNOVER ────────────────────────────────────────────────────────────────
function populateTurnoverSYSelect() {
  const sys = TURN.school_years;
  const sel = document.getElementById('turnover-sy-select');
  sel.innerHTML = sys.map(sy =>
    `<option value="${sy}">${sy}</option>`
  ).join('');
  sel.value = sys[sys.length - 1];
}

function renderTurnoverPage(sy) {
  const entries = (TURN.school_year_monthly || {})[sy] || [];

  // Map to 12-slot array indexed by TURN_MONTH_LABELS
  const slots = new Array(12).fill(null);
  entries.forEach(d => {
    const idx = monthLabelIndex(d.month);
    if (idx >= 0) {
      slots[idx] = slots[idx]
        ? { hires: slots[idx].hires + d.hires, departures: slots[idx].departures + d.departures }
        : { hires: d.hires, departures: d.departures };
    }
  });

  // Monthly bar chart
  document.getElementById('turnover-monthly-chart').innerHTML = buildMonthlyBarChart(slots);

  // Cumulative chart (all school years overlay)
  document.getElementById('turnover-cumulative-chart').innerHTML =
    buildCumulativeChart(TURN.school_year_monthly || {});

  // Monthly detail table
  const sy1 = sy.split('-')[0];
  const sy2 = parseInt(sy.split('-')[1]) + 2000;
  document.getElementById('turnover-monthly-subtitle').textContent = `Jul ${sy1} – Jun ${sy2}`;

  let totalH = 0, totalD = 0;
  const rows = entries.map(d => {
    totalH += d.hires || 0;
    totalD += d.departures || 0;
    const net = (d.hires || 0) - (d.departures || 0);
    return `<tr>
      <td>${d.month}</td>
      <td class="num">${fmt(d.hires)}</td>
      <td class="num">${fmt(d.departures)}</td>
      <td class="num">${netBadge(net)}</td>
    </tr>`;
  });
  document.getElementById('turnover-monthly-body').innerHTML = rows.join('') ||
    '<tr><td colspan="4" style="color:#888">No data for this school year.</td></tr>';
  document.getElementById('turnover-total-hires').textContent = fmt(totalH);
  document.getElementById('turnover-total-depts').textContent = fmt(totalD);
  document.getElementById('turnover-total-net').innerHTML     = netBadge(totalH - totalD);
}

// ─── OPEN POSITIONS ──────────────────────────────────────────────────────────
function renderPositions() {
  if (!JOBS || !JOBS.length) {
    document.getElementById('page-positions').innerHTML =
      '<p style="padding:2rem;color:#888">No open positions data available.</p>';
    return;
  }

  const sorted  = [...JOBS].sort((a, b) => a.date < b.date ? -1 : 1);
  const latest  = sorted[sorted.length - 1];
  const prev    = sorted.length > 1 ? sorted[sorted.length - 2] : null;

  // ── Snapshot cards ──
  const fields = [
    { key: 'total',           label: 'Total Open'      },
    { key: 'teacher',         label: 'Teacher'         },
    { key: 'certified',       label: 'Certified'       },
    { key: 'paraprofessional', label: 'Paraprofessional'},
    { key: 'auxiliary',       label: 'Auxiliary'       },
  ];

  const cards = fields.map(f => {
    const val  = latest[f.key] != null ? latest[f.key] : null;
    const pval = prev  ? (prev[f.key] != null ? prev[f.key] : null) : null;
    let delta = '';
    if (val != null && pval != null) {
      const d = val - pval;
      if (d !== 0) delta = `<div class="pos-sub" style="color:${d > 0 ? '#dc2626' : '#1d7a40'}">${d > 0 ? '▲' : '▼'} ${Math.abs(d)} from prev</div>`;
    }
    return `<div class="pos-card">
      <div class="pos-value">${val != null ? fmt(val) : '–'}</div>
      <div class="pos-label">${f.label}</div>
      ${delta}
    </div>`;
  }).join('');
  document.getElementById('positions-cards').innerHTML = cards;

  // ── Trend chart ──
  document.getElementById('positions-chart').innerHTML = buildPositionsChart(sorted);

  // ── Snapshot table ──
  const rows = sorted.slice().reverse().map(d => `<tr>
    <td>${fmtDateShort(d.date)}</td>
    <td class="num">${fmt(d.total)}</td>
    <td class="num">${fmt(d.teacher)}</td>
    <td class="num col-hide">${fmt(d.certified)}</td>
    <td class="num col-hide">${fmt(d.paraprofessional)}</td>
    <td class="num col-hide">${fmt(d.auxiliary)}</td>
  </tr>`).join('');
  document.getElementById('positions-body').innerHTML = rows;
}

// ─── BY CAMPUS ───────────────────────────────────────────────────────────────
function renderCampus() {
  const depts = TURN.by_dept || [];

  // Collect unique types
  const types = [...new Set(depts.map(d => d.type).filter(Boolean))].sort();
  const filterEl = document.getElementById('type-filters');
  filterEl.innerHTML = [
    `<button class="type-chip ${campusTypeFilter === 'all' ? 'active' : ''}" data-type="all">All</button>`,
    ...types.map(t =>
      `<button class="type-chip ${campusTypeFilter === t ? 'active' : ''}" data-type="${t}">${t}</button>`
    )
  ].join('');

  filterEl.querySelectorAll('.type-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      campusTypeFilter = btn.dataset.type;
      campusPage = 0;
      renderCampus();
    });
  });

  // Determine latest FY key for "Latest FY" columns
  const fyKeys = (TURN.fiscal_years || []);
  const latestFY = fyKeys[fyKeys.length - 1] || null;

  // Filter
  const search = campusSearch.toLowerCase().trim();
  let rows = depts.filter(d => {
    if (campusTypeFilter !== 'all' && d.type !== campusTypeFilter) return false;
    if (search && !d.dept.toLowerCase().includes(search)) return false;
    return true;
  });

  // Sort
  rows = rows.slice().sort((a, b) => {
    let av, bv;
    if (campusSortKey === 'dept') {
      av = a.dept || ''; bv = b.dept || '';
      return campusSortDir * (av < bv ? -1 : av > bv ? 1 : 0);
    }
    const aFY = latestFY ? (a.by_fy || {})[latestFY] || {} : {};
    const bFY = latestFY ? (b.by_fy || {})[latestFY] || {} : {};
    const map = {
      hires: () => [a.hires, b.hires],
      depts: () => [a.departures, b.departures],
      net:   () => [a.hires - a.departures, b.hires - b.departures],
      curr_h: () => [aFY.hires || 0, bFY.hires || 0],
      curr_d: () => [aFY.departures || 0, bFY.departures || 0],
    };
    [av, bv] = (map[campusSortKey] || map.hires)();
    return campusSortDir * ((+av || 0) - (+bv || 0));
  });

  const total = rows.length;
  const pages = Math.ceil(total / PAGE_SIZE);
  if (campusPage >= pages) campusPage = Math.max(0, pages - 1);
  const slice = rows.slice(campusPage * PAGE_SIZE, (campusPage + 1) * PAGE_SIZE);

  document.getElementById('campus-count-label').textContent =
    `Showing ${slice.length} of ${fmt(total)} campuses/departments`;

  // Update sort arrows
  document.querySelectorAll('#campus-table th.sortable').forEach(th => {
    const k = th.dataset.sort;
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) {
      arrow.textContent = k === campusSortKey ? (campusSortDir === 1 ? ' ▲' : ' ▼') : '';
    }
  });

  const tbody = document.getElementById('campus-body');
  tbody.innerHTML = slice.map(d => {
    const net = (d.hires || 0) - (d.departures || 0);
    const fy  = latestFY ? (d.by_fy || {})[latestFY] || {} : {};
    return `<tr>
      <td>${d.dept || '–'}</td>
      <td class="col-hide">${d.type || '–'}</td>
      <td class="num">${fmt(d.hires)}</td>
      <td class="num">${fmt(d.departures)}</td>
      <td class="num">${netBadge(net)}</td>
      <td class="num col-hide">${fmt(fy.hires)}</td>
      <td class="num col-hide">${fmt(fy.departures)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" style="color:#888;padding:1rem">No results.</td></tr>';

  // Pagination
  const pag = document.getElementById('campus-pagination');
  if (pages <= 1) { pag.innerHTML = ''; return; }
  let btns = '';
  if (campusPage > 0) btns += `<button class="page-btn" data-pg="${campusPage - 1}">‹ Prev</button>`;
  btns += `<span class="page-info">Page ${campusPage + 1} of ${pages}</span>`;
  if (campusPage < pages - 1) btns += `<button class="page-btn" data-pg="${campusPage + 1}">Next ›</button>`;
  pag.innerHTML = btns;
  pag.querySelectorAll('.page-btn').forEach(btn => {
    btn.addEventListener('click', () => { campusPage = +btn.dataset.pg; renderCampus(); });
  });
}

// ─── TAB ROUTING ─────────────────────────────────────────────────────────────
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.page === name));
  const pg = document.getElementById('page-' + name);
  if (pg) pg.classList.add('active');

  // Redirect removed tabs
  if (name === 'campus') { showPage('turnover'); return; }

  if (!TAB_RENDERED.has(name)) {
    TAB_RENDERED.add(name);
    if (name === 'overview')  renderOverview();
    if (name === 'turnover') {
      populateTurnoverSYSelect();
      const sel = document.getElementById('turnover-sy-select');
      renderTurnoverPage(sel.value);
      renderCampus();
    }
    if (name === 'positions') renderPositions();
  }
}

// ─── PRELAUNCH MODAL ─────────────────────────────────────────────────────────
function initPrelaunch() {
  const overlay = document.getElementById('prelaunch-overlay');
  const ack     = document.getElementById('prelaunch-ack');
  if (!overlay || !ack) return;
  // Always show — no localStorage gate
  overlay.classList.remove('hidden');
  ack.addEventListener('click', () => overlay.classList.add('hidden'), { once: true });
}

// ─── SITENAV TOGGLE ──────────────────────────────────────────────────────────
function initSitenav() {
  const tog = document.querySelector('.sitenav__tog');
  const nav = document.querySelector('.sitenav');
  if (!tog || !nav) return;
  tog.addEventListener('click', () => {
    const open = nav.hasAttribute('data-open');
    nav.toggleAttribute('data-open', !open);
    tog.setAttribute('aria-expanded', String(!open));
  });
  document.addEventListener('click', e => {
    if (!nav.contains(e.target)) {
      nav.removeAttribute('data-open');
      tog.setAttribute('aria-expanded', 'false');
    }
  });
}

// ─── INIT ────────────────────────────────────────────────────────────────────
async function init() {
  try {
    [META, TURN, JOBS] = await Promise.all([
      loadJSON('data/meta.json'),
      loadJSON('data/turnover.json'),
      loadJSON('data/jobs_history.json').catch(() => []),
    ]);
  } catch (err) {
    document.getElementById('loading').textContent = 'Failed to load staff data. Please refresh.';
    console.error(err);
    return;
  }

  document.getElementById('loading').style.display = 'none';

  // Footer
  if (META.last_updated) {
    document.getElementById('footer-updated').textContent =
      'Data refreshed ' + fmtDateShort(META.last_updated.slice(0, 10));
  }

  // Tab nav wiring
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => showPage(btn.dataset.page));
  });

  // Turnover SY select change (re-render without adding to TAB_RENDERED guard)
  document.getElementById('turnover-sy-select').addEventListener('change', e => {
    renderTurnoverPage(e.target.value);
  });

  // Campus sort headers
  document.querySelectorAll('#campus-table th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      if (campusSortKey === k) campusSortDir *= -1;
      else { campusSortKey = k; campusSortDir = -1; }
      campusPage = 0;
      renderCampus();
    });
  });

  // Campus search
  document.getElementById('campus-search').addEventListener('input', e => {
    campusSearch = e.target.value;
    campusPage   = 0;
    if (TAB_RENDERED.has('turnover')) renderCampus();
  });

  initSitenav();
  initPrelaunch();

  // Show overview by default
  showPage('overview');
}

document.addEventListener('DOMContentLoaded', init);
