// ─────────────────────────────────────────────
// Zendesk Ticket Tracker — Web Dashboard
// Reads the same Firestore document the Chrome extension writes to
// (/users/{uid}/data/tracker) plus the shared weekly leaderboard collection.
// No build step — plain ES modules, Firebase's own CDN build.
// ─────────────────────────────────────────────

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js';
import {
    getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';
import {
    getFirestore, doc, getDoc, collection, getDocs
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';

// ── Firebase Config ────────────────────────────
// Same project the extension uses (firebase-config.js). apiKey is a public
// client identifier, not a secret — access is enforced by Firestore's
// security rules (see /firestore.rules), not by hiding this value.
const firebaseConfig = {
    apiKey: 'AIzaSyCO-s0Lxohqo2tG1XzUCHh40M_h0BtVXi0',
    authDomain: 'zendesk-tracker.firebaseapp.com',
    projectId: 'zendesk-tracker'
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ── Date Helpers (mirrors background.js's date-key logic) ────────────────
function dateKey(ts) {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}
function todayKey() { return dateKey(Date.now()); }

function getLastNDaysKeys(n, endDate) {
    const keys = [];
    const end = endDate ? new Date(endDate) : new Date();
    for (let i = n - 1; i >= 0; i--) {
        const d = new Date(end);
        d.setDate(end.getDate() - i);
        keys.push(dateKey(d.getTime()));
    }
    return keys;
}

function getCurrentMonthKeys() {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const keys = [];
    for (let d = 1; d <= daysInMonth; d++) {
        keys.push(`${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
    return keys;
}

function getLastWeekKey() {
    const now = new Date();
    const lastWeek = new Date(now);
    lastWeek.setDate(now.getDate() - 7);
    const day = lastWeek.getDay();
    const monday = new Date(lastWeek);
    monday.setDate(lastWeek.getDate() - (day === 0 ? 6 : day - 1));
    monday.setHours(0, 0, 0, 0);
    const year = monday.getFullYear();
    const startOfYear = new Date(year, 0, 1);
    const days = Math.floor((monday - startOfYear) / 86400000);
    const weekNum = Math.ceil((days + startOfYear.getDay() + 1) / 7);
    return `${year}-${String(weekNum).padStart(2, '0')}`;
}

function getLastMonthKey() {
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`;
}

function fmtShortDateStr(dateStr) {
    const [, m, d] = dateStr.split('-');
    return `${parseInt(m)}/${parseInt(d)}`;
}

// ── Color Palette (matches the extension's "moody" theme) ────────────────
// Mutable — re-derived from the active theme's own --red/--yellow/etc. CSS
// variables (see refreshCategoryColorsFromTheme) so chart bars/lines match
// whichever theme is picked instead of staying frozen on the original
// "classic" hues now that there's more than one theme to choose from.
let COLORS = {
    open: { bg: 'rgba(255,107,107,0.75)', border: '#ff6b6b' },
    new: { bg: 'rgba(255,217,61,0.75)', border: '#ffd93d' },
    team: { bg: 'rgba(89,168,255,0.75)', border: '#59a8ff' },
    compliance: { bg: 'rgba(34,197,139,0.75)', border: '#22c58b' },
    escalation: { bg: 'rgba(181,114,62,0.75)', border: '#b5723e' },
    closed: { bg: 'rgba(154,154,154,0.75)', border: '#9a9a9a' }
};
const ALL_TYPES = ['open', 'new', 'team', 'compliance', 'escalation', 'closed'];
const CATEGORY_TO_CSS_VAR = { open: 'red', new: 'yellow', team: 'blue', compliance: 'green', escalation: 'brown', closed: 'gray' };

function refreshCategoryColorsFromTheme() {
    const cs = getComputedStyle(document.documentElement);
    Object.entries(CATEGORY_TO_CSS_VAR).forEach(([cat, varName]) => {
        const hex = (cs.getPropertyValue(`--${varName}`) || '').trim();
        if (hex) COLORS[cat] = { bg: hexToRgba(hex, 0.75), border: hex };
    });
}

function $(id) { return document.getElementById(id); }
function emptyTotals() { return { open: 0, new: 0, team: 0, compliance: 0, escalation: 0, closed: 0 }; }

function sumTotals(dailyTotals, keys) {
    const out = emptyTotals();
    keys.forEach(k => {
        const day = dailyTotals[k];
        if (!day) return;
        ALL_TYPES.forEach(t => { out[t] += day[t] || 0; });
    });
    return out;
}

// ── State ───────────────────────────────────────
let currentRange = 'today';
let chartViewMode = 'tickets';
let chartInstance = null;
let userData = null; // { dailyTotals, ticketLog, masterLogHistory, ticketPayeeIssues, agentName }
let currentLbPeriod = 'week';
let currentLbCategory = 'tickets'; // 'tickets' | 'speed'

// ── Auth ────────────────────────────────────────
$('signin-btn').addEventListener('click', async () => {
    $('auth-error').hidden = true;
    try {
        await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (e) {
        console.error('[TT Dashboard] Sign-in failed:', e.code, e.message);
        let msg = `Sign-in failed: ${e.message}`;
        if (e.code === 'auth/unauthorized-domain') {
            msg = `This domain isn't authorized for sign-in yet. In the Firebase Console, go to Authentication → Settings → Authorized domains, and add ${location.hostname}.`;
        } else if (e.code === 'auth/popup-blocked') {
            msg = 'Your browser blocked the sign-in popup. Allow popups for this site and try again.';
        } else if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') {
            // User closed it themselves — not a real error, no need to alarm them.
            $('auth-error').hidden = true;
            return;
        }
        $('auth-error').textContent = msg;
        $('auth-error').hidden = false;
    }
});

$('signout-btn').addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        $('auth-screen').hidden = false;
        $('app-main').hidden = true;
        return;
    }

    $('auth-screen').hidden = true;
    $('app-main').hidden = false;
    $('user-name').textContent = user.displayName || user.email || '';

    await loadUserData(user.uid);
    renderAll();

    loadLeaderboard(currentLbPeriod).catch(e => console.warn('[TT Dashboard] Leaderboard load failed:', e.message));
});

// ── Firestore Reads ─────────────────────────────
async function loadUserData(uid) {
    try {
        const snap = await getDoc(doc(db, 'users', uid, 'data', 'tracker'));
        if (!snap.exists()) {
            userData = { dailyTotals: {}, ticketLog: [], masterLogHistory: [], ticketPayeeIssues: {}, agentName: '' };
            return;
        }
        const d = snap.data();
        userData = {
            dailyTotals: safeParse(d.dailyTotalsJson, {}),
            ticketLog: safeParse(d.ticketLogJson, []),
            masterLogHistory: safeParse(d.masterLogHistoryJson, []),
            ticketPayeeIssues: safeParse(d.ticketPayeeIssuesJson, {}),
            agentName: d.agentName || ''
        };
    } catch (e) {
        console.error('[TT Dashboard] Failed to load user data:', e.message);
        userData = { dailyTotals: {}, ticketLog: [], masterLogHistory: [], ticketPayeeIssues: {}, agentName: '' };
    }
}

function safeParse(json, fallback) {
    try { return json ? JSON.parse(json) : fallback; } catch (e) { return fallback; }
}

// Always the last *completed* period (never the in-progress current one —
// same fix as the extension's popup) so nobody looks like a runaway leader
// just for having synced the most tickets so far in a week/month that's
// barely started. A finished period's total is stable for the entire next
// one, then rolls over once that period itself ends.
async function loadLeaderboard(period) {
    currentLbPeriod = period || currentLbPeriod;
    const isWeek = currentLbPeriod === 'week';
    const isSpeed = currentLbCategory === 'speed';
    const collectionName = isWeek ? 'weeklyLeaderboard' : 'monthlyLeaderboard';
    const periodKey = isWeek ? getLastWeekKey() : getLastMonthKey();

    const periodLabelEl = $('leaderboard-period-label');
    if (periodLabelEl) periodLabelEl.textContent = isWeek ? 'Last Week' : 'Last Month';

    const snap = await getDocs(collection(db, collectionName, periodKey, 'users'));
    const rows = [];
    snap.forEach(d => rows.push({ uid: d.id, ...d.data() }));
    const totalField = isSpeed ? (isWeek ? 'weekPeakSpeed' : 'monthPeakSpeed') : (isWeek ? 'weekTotal' : 'monthTotal');
    const filtered = isSpeed ? rows.filter(r => (r[totalField] || 0) > 0) : rows;
    filtered.sort((a, b) => (b[totalField] || 0) - (a[totalField] || 0));
    renderLeaderboard(filtered, totalField, isWeek, isSpeed);
}

document.querySelectorAll('[data-lb-period]').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('[data-lb-period]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        loadLeaderboard(btn.dataset.lbPeriod).catch(e => console.warn('[TT Dashboard] Leaderboard load failed:', e.message));
    });
});

document.querySelectorAll('[data-lb-cat]').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('[data-lb-cat]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentLbCategory = btn.dataset.lbCat;
        loadLeaderboard(currentLbPeriod).catch(e => console.warn('[TT Dashboard] Leaderboard load failed:', e.message));
    });
});

// ── Active date keys for the selected range ────
function getActiveDateKeys() {
    if (currentRange === 'today') return [todayKey()];
    if (currentRange === 'week') return getLastNDaysKeys(7);
    if (currentRange === 'month') return getCurrentMonthKeys();
    return [];
}

// ── Render: everything ──────────────────────────
function renderAll() {
    renderStats();
    renderChart();
    renderTicketsTable();
}

// ── Render: stat cards ──────────────────────────
function renderStats() {
    if (!userData) return;
    const totals = sumTotals(userData.dailyTotals, getActiveDateKeys());
    ALL_TYPES.forEach(t => { $(`stat-${t}`).textContent = totals[t]; });
    const total = ALL_TYPES.reduce((sum, t) => sum + totals[t], 0);
    $('stat-total').textContent = total;
}

// ── Render: chart (Number of Tickets / Payee Issue Types) ──────────────
function buildTicketsChartData() {
    const keys = getActiveDateKeys();
    if (currentRange === 'today') {
        const d = userData.dailyTotals[keys[0]] || emptyTotals();
        return {
            labels: ['Today'],
            datasets: ALL_TYPES.map(t => ({
                label: cap(t), data: [d[t] || 0],
                backgroundColor: COLORS[t].bg, borderColor: COLORS[t].border, borderWidth: 1.5, borderRadius: 4
            }))
        };
    }
    return {
        labels: keys.map(fmtShortDateStr),
        datasets: ALL_TYPES.map(t => ({
            label: cap(t), data: keys.map(k => (userData.dailyTotals[k] || {})[t] || 0),
            backgroundColor: COLORS[t].bg, borderColor: COLORS[t].border, borderWidth: 1.5, borderRadius: 3
        }))
    };
}

// Distinct, stable palette for payee issue bars — mirrors popup.js's
// PAYEE_PALETTE so the same issue reads as roughly the same color across
// the extension and the dashboard.
const PAYEE_PALETTE = ['#6c63ff', '#ff6b6b', '#ffd93d', '#2ecc71', '#74b9ff', '#e17055', '#a29bfe', '#00cec9', '#fd79a8', '#fdcb6e'];

function hexToRgba(hex, alpha) {
    const h = hex.replace('#', '');
    const num = parseInt(h, 16);
    const r = (num >> 16) & 255, g = (num >> 8) & 255, b = num & 255;
    return `rgba(${r},${g},${b},${alpha})`;
}

function abbreviateIssue(name) {
    const words = String(name).trim().split(/\s+/).filter(w => w.length);
    if (words.length >= 2) return words.map(w => w[0].toUpperCase()).join('').slice(0, 5);
    return words[0] ? words[0].slice(0, 5).toUpperCase() : '?';
}

function buildPayeeIssueChartData() {
    const activeDates = new Set(getActiveDateKeys());
    const seenTickets = new Set();
    const tally = new Map();

    (userData.ticketLog || []).forEach(entry => {
        if (!activeDates.has(entry.date)) return;
        if (seenTickets.has(entry.ticketNumber)) return;
        seenTickets.add(entry.ticketNumber);
        const issue = userData.ticketPayeeIssues[entry.ticketNumber];
        if (!issue || issue === '-') return;
        tally.set(issue, (tally.get(issue) || 0) + 1);
    });

    if (!tally.size) return null;
    const top6 = Array.from(tally.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const colors = top6.map((_, i) => PAYEE_PALETTE[i % PAYEE_PALETTE.length]);

    return {
        labels: top6.map(([issue]) => abbreviateIssue(issue)),
        fullLabels: top6.map(([issue]) => issue),
        datasets: [{
            label: 'Payee Issue Types',
            data: top6.map(([, count]) => count),
            backgroundColor: colors.map(c => hexToRgba(c, 0.7)),
            borderColor: colors,
            borderWidth: 1.5,
            borderRadius: 4
        }]
    };
}

function renderPayeeLegend(data) {
    const el = $('payee-legend-row');
    if (!el) return;
    if (!data || !data.fullLabels) {
        el.innerHTML = '';
        el.style.display = 'none';
        return;
    }
    el.style.display = 'flex';
    const colors = data.datasets[0].borderColor;
    el.innerHTML = data.fullLabels.map((full, i) => `
        <span class="legend-chip" title="${full.replace(/"/g, '&quot;')}">
            <span class="legend-swatch" style="background:${colors[i]}"></span>${data.labels[i]}
        </span>
    `).join('');
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// Reads the active theme's own CSS variables instead of hardcoding a single
// dark palette — needed now that the Appearance picker can switch to a
// light theme, where a white-based grid/tick/empty-state color would be
// nearly invisible. The tooltip itself stays dark in every theme by design
// (see --chart-tooltip-bg in styles.css), so its white title/body text
// doesn't need to be theme-aware.
function getThemeChartColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
    return {
        gridColor: v('--chart-grid', 'rgba(255,255,255,0.05)'),
        gridColorY: v('--chart-grid-y', 'rgba(255,255,255,0.07)'),
        ticksColor: v('--chart-ticks', 'rgba(255,255,255,0.4)'),
        tooltipBg: v('--chart-tooltip-bg', 'rgba(14,14,16,0.95)'),
        tooltipBorder: v('--border-h', 'rgba(255,255,255,0.14)'),
        emptyColor: v('--text-3', 'rgba(236,236,236,0.32)')
    };
}

function renderChart() {
    if (!userData) return;
    const ctx = $('main-chart').getContext('2d');
    const data = chartViewMode === 'payee' ? buildPayeeIssueChartData() : buildTicketsChartData();

    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

    const { gridColor, gridColorY, ticksColor, tooltipBg, tooltipBorder, emptyColor } = getThemeChartColors();

    if (!data) {
        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.fillStyle = emptyColor;
        ctx.font = '12px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No data for this period', ctx.canvas.width / 2, ctx.canvas.height / 2);
        renderPayeeLegend(null);
        return;
    }

    chartInstance = new Chart(ctx, {
        type: 'bar',
        data,
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 350, easing: 'easeInOutQuart' },
            plugins: {
                // The bigger standalone .chart-legend chips replace Chart.js's
                // own built-in legend — no need to render both.
                legend: { display: false },
                tooltip: {
                    backgroundColor: tooltipBg,
                    borderColor: tooltipBorder,
                    borderWidth: 1,
                    titleColor: 'rgba(255,255,255,0.7)',
                    bodyColor: '#fff',
                    padding: 10,
                    cornerRadius: 8,
                    callbacks: data.fullLabels ? {
                        title: (items) => data.fullLabels[items[0].dataIndex] || items[0].label
                    } : undefined
                }
            },
            scales: {
                x: {
                    grid: { color: gridColor, drawBorder: false },
                    ticks: { color: ticksColor, font: { size: 10, family: 'Inter' } },
                    border: { display: false }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: gridColorY, drawBorder: false },
                    ticks: { color: ticksColor, font: { size: 10, family: 'Inter' }, stepSize: 1, precision: 0 },
                    border: { display: false }
                }
            }
        }
    });

    renderPayeeLegend(chartViewMode === 'payee' ? data : null);
}

// ── Render: leaderboard ─────────────────────────
// Same rank badges as the extension's podium cards — the crown alone
// (plus the "Last Week"/"Last Month" label above the list) is enough to
// read as "this is the champion" without needing a second line of text
// that the row's single-line layout would just clip anyway.
const LB_RANK_BADGES = ['👑', '🥈', '🥉'];

function renderLeaderboard(rows, totalField, isWeek, isSpeed) {
    const list = $('leaderboard-list');
    if (!rows.length) {
        list.innerHTML = `<div class="leaderboard-empty">No data yet for ${isWeek ? 'last week' : 'last month'}.</div>`;
        return;
    }
    list.innerHTML = rows.map((r, i) => `
        <div class="leaderboard-row rank-${i + 1}">
            <span class="leaderboard-rank">${LB_RANK_BADGES[i] || `#${i + 1}`}</span>
            ${r.photoUrl
                ? `<img class="leaderboard-avatar" src="${r.photoUrl}" alt="" referrerpolicy="no-referrer" />`
                : `<div class="leaderboard-avatar"></div>`}
            <span class="leaderboard-name">${escapeHtml(r.displayName || r.email || 'Agent')}</span>
            <span class="leaderboard-total">${isSpeed ? (r[totalField] || 0) + ' TPH' : (r[totalField] || 0)}</span>
        </div>
    `).join('');
}

// ── Render: recent tickets table ────────────────
function renderTicketsTable() {
    if (!userData) return;
    const activeDates = new Set(getActiveDateKeys());

    // Same per-ticket-per-day dedup as the exports: a reclassified ticket
    // shows once, under its latest category.
    const sorted = [...(userData.ticketLog || [])]
        .filter(e => activeDates.has(e.date))
        .sort((a, b) => a.timestamp - b.timestamp);
    const latestByTicket = new Map();
    sorted.forEach(e => latestByTicket.set(e.ticketNumber, e));

    const rows = Array.from(latestByTicket.values()).sort((a, b) => b.timestamp - a.timestamp);

    const tbody = $('tickets-tbody');
    if (!rows.length) {
        tbody.innerHTML = '';
        $('tickets-empty').hidden = false;
        return;
    }
    $('tickets-empty').hidden = true;

    tbody.innerHTML = rows.slice(0, 200).map(r => `
        <tr>
            <td>${fmtShortDateStr(r.date)}</td>
            <td>#${escapeHtml(String(r.ticketNumber))}</td>
            <td>${cap(r.type)}</td>
            <td class="ticket-issue">${escapeHtml(userData.ticketPayeeIssues[r.ticketNumber] || '—')}</td>
        </tr>
    `).join('');
}

function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Range switcher ──────────────────────────────
document.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentRange = btn.dataset.range;
        renderAll();
    });
});

// ── Chart view toggle ───────────────────────────
document.querySelectorAll('.chart-view-btn[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.chart-view-btn[data-view]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        chartViewMode = btn.dataset.view;
        $('chart-legend-row').style.display = (chartViewMode === 'payee') ? 'none' : '';
        renderChart();
    });
});

// ── Appearance / Theme Picker ────────────────────────────────────────────
// First theme system this dashboard has ever had — "classic" (the bg/accent
// values below) is the look every existing visitor already sees, kept as
// the default so nobody's view changes unless they open this picker.
const THEMES = [
    { key: 'classic', name: 'Classic Dark', bg: '#171717', accent: '#10a37f' },
    { key: 'blue-light', name: 'Ocean Blue (Light)', bg: '#fbfbfe', accent: '#2f27ce' },
    { key: 'blue-dark', name: 'Ocean Blue (Dark)', bg: '#010104', accent: '#3a31d8' },
    { key: 'emerald-forest', name: 'Emerald Forest', bg: '#050c08', accent: '#10b981' },
    { key: 'crisp-light', name: 'Crisp Minimalist (Light)', bg: '#f8fafc', accent: '#6366f1' },
    { key: 'crisp-dark', name: 'Crisp Minimalist (Dark)', bg: '#030507', accent: '#0d109b' },
    { key: 'crimson-light', name: 'Crimson Obsidian (Light)', bg: '#ececee', accent: '#d72323' },
    { key: 'crimson-dark', name: 'Crimson Obsidian (Dark)', bg: '#121214', accent: '#dc2626' }
];
const THEME_STORAGE_KEY = 'ttDashboardTheme';

function applyTheme(key) {
    document.documentElement.setAttribute('data-theme', key);
    try { localStorage.setItem(THEME_STORAGE_KEY, key); } catch (e) {}
    refreshCategoryColorsFromTheme();
    if (chartInstance) renderChart();
    if (detailChartInstance) loadDetailChart();
}

function renderThemeList() {
    const active = document.documentElement.getAttribute('data-theme') || 'classic';
    $('theme-picker-list').innerHTML = THEMES.map(t => `
        <div class="theme-row${t.key === active ? ' selected' : ''}" data-theme-key="${t.key}">
            <span class="theme-swatch" style="background: linear-gradient(135deg, ${t.bg}, ${t.accent});"></span>
            <span class="theme-row-name">${t.name}</span>
            <span class="theme-row-check">${t.key === active ? '✓' : ''}</span>
        </div>
    `).join('');
    $('theme-picker-list').querySelectorAll('.theme-row').forEach(row => {
        row.addEventListener('click', () => {
            applyTheme(row.getAttribute('data-theme-key'));
            renderThemeList();
        });
    });
}

if ($('theme-btn')) {
    $('theme-btn').addEventListener('click', () => {
        renderThemeList();
        $('theme-picker-modal').classList.add('open');
        $('theme-picker-modal').setAttribute('aria-hidden', 'false');
    });
}
function closeThemeModal() {
    $('theme-picker-modal').classList.remove('open');
    $('theme-picker-modal').setAttribute('aria-hidden', 'true');
}
if ($('theme-picker-close')) $('theme-picker-close').addEventListener('click', closeThemeModal);
if ($('theme-picker-modal')) {
    $('theme-picker-modal').addEventListener('click', (e) => {
        if (e.target === $('theme-picker-modal')) closeThemeModal();
    });
}

// Apply whatever the inline <head> script already set on <html> (or the
// default) to COLORS right away, before the first chart ever renders.
refreshCategoryColorsFromTheme();

// ── Detailed Chart Modal (Number of Tickets / Payee Issue Types) ──────────
// Client-side equivalent of the extension's background.js getDetailedStats
// — same bucketing rules, just computed straight off the already-loaded
// userData instead of a chrome.runtime message round trip.
let detailChartInstance = null;
let detailRange = 'today';
let detailDateParam = null; // null = current/rolling
let detailViewMode = 'tickets'; // 'tickets' | 'payee'
const DOW_NAMES_DETAIL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function getPayeeBucketSeriesLocal(ticketLog, ticketPayeeIssues, validDates, bucketFn, bucketLabels) {
    const seen = new Set();
    const bucketTally = bucketLabels.map(() => ({}));
    const overallTally = {};

    [...ticketLog]
        .filter(e => !validDates || validDates.has(e.date))
        .sort((a, b) => a.timestamp - b.timestamp)
        .forEach(entry => {
            if (seen.has(entry.ticketNumber)) return;
            seen.add(entry.ticketNumber);
            const issue = ticketPayeeIssues[entry.ticketNumber];
            if (!issue || issue === '-') return;
            const idx = bucketFn(entry);
            if (idx == null || idx < 0 || idx >= bucketLabels.length) return;
            bucketTally[idx][issue] = (bucketTally[idx][issue] || 0) + 1;
            overallTally[issue] = (overallTally[issue] || 0) + 1;
        });

    const topIssues = Object.entries(overallTally).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => k);
    return {
        topIssues,
        buckets: bucketLabels.map((label, i) => {
            const entry = { label };
            topIssues.forEach(issue => { entry[issue] = bucketTally[i][issue] || 0; });
            return entry;
        })
    };
}

function getDetailedStatsLocal(range, dateParam) {
    const dt = userData.dailyTotals || {};
    const ticketLog = userData.ticketLog || [];
    const ticketPayeeIssues = userData.ticketPayeeIssues || {};

    if (range === 'today') {
        const targetDate = dateParam || todayKey();
        const hourly = [];
        for (let h = 0; h < 24; h++) {
            const entry = { label: `${h}:00`, hour: h };
            ALL_TYPES.forEach(t => entry[t] = 0);
            hourly.push(entry);
        }
        ticketLog.forEach(e => {
            if (e.date === targetDate && ALL_TYPES.includes(e.type)) {
                hourly[new Date(e.timestamp).getHours()][e.type]++;
            }
        });
        const payee = getPayeeBucketSeriesLocal(
            ticketLog, ticketPayeeIssues, new Set([targetDate]),
            (e) => new Date(e.timestamp).getHours(),
            hourly.map(h => h.label)
        );
        return { range: 'today', data: hourly, payee };
    }

    if (range === 'week') {
        const baseDate = dateParam ? new Date(dateParam + 'T00:00:00') : new Date();
        const keys = getLastNDaysKeys(7, baseDate);
        const daily = keys.map(k => {
            const d = new Date(k + 'T00:00:00');
            const entry = { label: `${DOW_NAMES_DETAIL[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`, date: k };
            ALL_TYPES.forEach(t => entry[t] = dt[k]?.[t] ?? 0);
            return entry;
        });
        const payee = getPayeeBucketSeriesLocal(
            ticketLog, ticketPayeeIssues, new Set(keys),
            (e) => keys.indexOf(e.date),
            daily.map(d => d.label)
        );
        return { range: 'week', data: daily, payee };
    }

    if (range === 'month') {
        const prefix = dateParam ? dateParam.substring(0, 7) : todayKey().substring(0, 7);
        const [y, m] = prefix.split('-').map(Number);
        const daysInMonth = new Date(y, m, 0).getDate();
        const grouped = [];
        const validMonthDates = new Set();
        for (let start = 1; start <= daysInMonth; start += 3) {
            const end = Math.min(start + 2, daysInMonth);
            const label = start === end ? `${m}/${start}` : `${m}/${start}-${end}`;
            const entry = { label };
            ALL_TYPES.forEach(t => entry[t] = 0);
            for (let d = start; d <= end; d++) {
                const k = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                validMonthDates.add(k);
                if (dt[k]) ALL_TYPES.forEach(t => entry[t] += dt[k][t] ?? 0);
            }
            grouped.push(entry);
        }
        const payee = getPayeeBucketSeriesLocal(
            ticketLog, ticketPayeeIssues, validMonthDates,
            (e) => Math.floor((parseInt(e.date.split('-')[2], 10) - 1) / 3),
            grouped.map(g => g.label)
        );
        return { range: 'month', data: grouped, payee };
    }

    return { error: 'Invalid range' };
}

function renderDetailChart(response) {
    const ctx = $('detail-chart').getContext('2d');
    if (detailChartInstance) { detailChartInstance.destroy(); detailChartInstance = null; }

    const isPayee = detailViewMode === 'payee';
    $('detail-legend').style.display = isPayee ? 'none' : '';
    $('detail-payee-legend-row').style.display = isPayee ? 'flex' : 'none';

    const { gridColor, gridColorY, ticksColor, tooltipBg, tooltipBorder, emptyColor } = getThemeChartColors();

    const noData = (msg) => {
        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.fillStyle = emptyColor;
        ctx.font = '12px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(msg, ctx.canvas.width / 2, ctx.canvas.height / 2);
    };

    let labels, datasets;

    if (isPayee) {
        const payee = response.payee;
        if (!payee || !payee.topIssues.length) {
            noData('No payee issue data for this period');
            $('detail-payee-legend-row').innerHTML = '';
            return;
        }
        labels = payee.buckets.map(b => b.label);
        const colors = payee.topIssues.map((_, i) => PAYEE_PALETTE[i % PAYEE_PALETTE.length]);
        datasets = payee.topIssues.map((issue, i) => ({
            label: issue,
            data: payee.buckets.map(b => b[issue] || 0),
            borderColor: colors[i],
            backgroundColor: hexToRgba(colors[i], 0.15),
            borderWidth: 2, pointRadius: 3, pointHoverRadius: 5, pointBackgroundColor: colors[i], tension: 0.3, fill: false
        }));
        $('detail-payee-legend-row').innerHTML = payee.topIssues.map((full, i) => `
            <span class="legend-chip" title="${full.replace(/"/g, '&quot;')}">
                <span class="legend-swatch" style="background:${colors[i]}"></span>${abbreviateIssue(full)}
            </span>
        `).join('');
    } else {
        const chartData = response.data;
        if (!chartData || !chartData.length) { noData('No data for this period'); return; }
        labels = chartData.map(d => d.label);
        const TYPE_LABELS = { open: 'Open', new: 'New', team: 'Team', compliance: 'Compliance', escalation: 'Escalation', closed: 'Closed' };
        datasets = ALL_TYPES.map(t => ({
            label: TYPE_LABELS[t],
            data: chartData.map(d => d[t] ?? 0),
            borderColor: COLORS[t].border,
            backgroundColor: COLORS[t].bg.replace('0.75', '0.15'),
            borderWidth: 2, pointRadius: 3, pointHoverRadius: 5, pointBackgroundColor: COLORS[t].border, tension: 0.3, fill: false
        }));
    }

    let title = 'Today (Hourly)';
    if (detailRange === 'today') {
        if (detailDateParam) { const [, m, d] = detailDateParam.split('-'); title = `${parseInt(m)}/${parseInt(d)} (Hourly)`; }
    } else if (detailRange === 'week') {
        if (detailDateParam) {
            const end = new Date(detailDateParam + 'T00:00:00');
            const start = new Date(end); start.setDate(start.getDate() - 6);
            title = `${start.getMonth() + 1}/${start.getDate()} - ${end.getMonth() + 1}/${end.getDate()}`;
        } else {
            title = 'Last 7 Days';
        }
    } else if (detailRange === 'month') {
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        if (detailDateParam) {
            title = `${monthNames[parseInt(detailDateParam.split('-')[1]) - 1]} (3-Day Groups)`;
        } else {
            title = `${monthNames[new Date().getMonth()]} (3-Day Groups)`;
        }
    }
    $('detail-chart-title').textContent = title;

    detailChartInstance = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 350, easing: 'easeInOutQuart' },
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: tooltipBg,
                    borderColor: tooltipBorder,
                    borderWidth: 1,
                    titleColor: 'rgba(255,255,255,0.7)',
                    bodyColor: '#fff',
                    padding: 10,
                    cornerRadius: 8
                }
            },
            scales: {
                x: {
                    grid: { color: gridColor, drawBorder: false },
                    ticks: {
                        color: ticksColor, font: { size: 9, family: 'Inter' },
                        maxRotation: detailRange === 'today' ? 0 : 45, autoSkip: true,
                        maxTicksLimit: detailRange === 'today' ? 12 : 15
                    },
                    border: { display: false }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: gridColorY, drawBorder: false },
                    ticks: { color: ticksColor, font: { size: 10, family: 'Inter' }, stepSize: 1, precision: 0 },
                    border: { display: false }
                }
            }
        }
    });
}

function loadDetailChart() {
    if (!userData) return;
    renderDetailChart(getDetailedStatsLocal(detailRange, detailDateParam));
}

function openDetailModal() {
    const modal = $('detail-modal');
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    detailRange = currentRange;
    detailDateParam = null;
    document.querySelectorAll('.detail-range-btn').forEach(b => b.classList.toggle('active', b.dataset.drange === detailRange));
    detailViewMode = chartViewMode;
    document.querySelectorAll('[data-dview]').forEach(b => b.classList.toggle('active', b.dataset.dview === detailViewMode));
    loadDetailChart();
}

function closeDetailModal() {
    const modal = $('detail-modal');
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    if (detailChartInstance) { detailChartInstance.destroy(); detailChartInstance = null; }
}

if ($('chart-expand-btn')) $('chart-expand-btn').addEventListener('click', (e) => { e.stopPropagation(); openDetailModal(); });
if ($('detail-close-btn')) $('detail-close-btn').addEventListener('click', closeDetailModal);
if ($('detail-modal')) $('detail-modal').addEventListener('click', (e) => { if (e.target === $('detail-modal')) closeDetailModal(); });

document.querySelectorAll('.detail-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.detail-range-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        detailRange = btn.dataset.drange;
        loadDetailChart();
    });
});

if ($('detail-date-btn')) {
    $('detail-date-btn').addEventListener('click', () => $('detail-date-input').showPicker());
    $('detail-date-input').addEventListener('change', (e) => {
        if (e.target.value) { detailDateParam = e.target.value; loadDetailChart(); }
    });
}

document.querySelectorAll('[data-dview]').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('[data-dview]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        detailViewMode = btn.dataset.dview;
        loadDetailChart();
    });
});

// ── PWA service worker ──────────────────────────
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    });
}
