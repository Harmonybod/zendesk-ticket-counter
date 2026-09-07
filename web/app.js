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

function getCurrentWeekKey() {
    const now = new Date();
    const day = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
    monday.setHours(0, 0, 0, 0);
    const year = monday.getFullYear();
    const startOfYear = new Date(year, 0, 1);
    const days = Math.floor((monday - startOfYear) / 86400000);
    const weekNum = Math.ceil((days + startOfYear.getDay() + 1) / 7);
    return `${year}-${String(weekNum).padStart(2, '0')}`;
}

function fmtShortDateStr(dateStr) {
    const [, m, d] = dateStr.split('-');
    return `${parseInt(m)}/${parseInt(d)}`;
}

// ── Color Palette (matches the extension's "moody" theme) ────────────────
const COLORS = {
    open: { bg: 'rgba(255,107,107,0.75)', border: '#ff6b6b' },
    new: { bg: 'rgba(255,217,61,0.75)', border: '#ffd93d' },
    team: { bg: 'rgba(89,168,255,0.75)', border: '#59a8ff' },
    compliance: { bg: 'rgba(34,197,139,0.75)', border: '#22c58b' },
    escalation: { bg: 'rgba(181,114,62,0.75)', border: '#b5723e' },
    closed: { bg: 'rgba(154,154,154,0.75)', border: '#9a9a9a' }
};
const ALL_TYPES = ['open', 'new', 'team', 'compliance', 'escalation', 'closed'];

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

    loadLeaderboard().catch(e => console.warn('[TT Dashboard] Leaderboard load failed:', e.message));
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

async function loadLeaderboard() {
    const weekKey = getCurrentWeekKey();
    const snap = await getDocs(collection(db, 'weeklyLeaderboard', weekKey, 'users'));
    const rows = [];
    snap.forEach(d => rows.push({ uid: d.id, ...d.data() }));
    rows.sort((a, b) => (b.weekTotal || 0) - (a.weekTotal || 0));
    renderLeaderboard(rows);
}

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

    return {
        labels: top6.map(([issue]) => issue),
        datasets: [{
            label: 'Payee Issue Types',
            data: top6.map(([, count]) => count),
            backgroundColor: 'rgba(16,163,127,0.6)',
            borderColor: '#10a37f',
            borderWidth: 1.5,
            borderRadius: 4
        }]
    };
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function renderChart() {
    if (!userData) return;
    const ctx = $('main-chart').getContext('2d');
    const data = chartViewMode === 'payee' ? buildPayeeIssueChartData() : buildTicketsChartData();

    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

    if (!data) {
        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.fillStyle = 'rgba(236,236,236,0.32)';
        ctx.font = '12px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No data for this period', ctx.canvas.width / 2, ctx.canvas.height / 2);
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
                legend: { display: chartViewMode === 'payee' ? false : true, labels: { color: '#ececec', font: { size: 10 }, boxWidth: 10 } },
                tooltip: {
                    backgroundColor: 'rgba(14,14,16,0.95)',
                    borderColor: 'rgba(255,255,255,0.14)',
                    borderWidth: 1,
                    titleColor: 'rgba(255,255,255,0.7)',
                    bodyColor: '#fff',
                    padding: 10,
                    cornerRadius: 8
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255,255,255,0.05)', drawBorder: false },
                    ticks: { color: 'rgba(255,255,255,0.4)', font: { size: 10, family: 'Inter' } },
                    border: { display: false }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(255,255,255,0.07)', drawBorder: false },
                    ticks: { color: 'rgba(255,255,255,0.4)', font: { size: 10, family: 'Inter' }, stepSize: 1, precision: 0 },
                    border: { display: false }
                }
            }
        }
    });
}

// ── Render: leaderboard ─────────────────────────
function renderLeaderboard(rows) {
    const list = $('leaderboard-list');
    if (!rows.length) {
        list.innerHTML = '<div class="leaderboard-empty">No leaderboard entries yet this week.</div>';
        return;
    }
    list.innerHTML = rows.map((r, i) => `
        <div class="leaderboard-row rank-${i + 1}">
            <span class="leaderboard-rank">${i + 1}</span>
            ${r.photoUrl
                ? `<img class="leaderboard-avatar" src="${r.photoUrl}" alt="" referrerpolicy="no-referrer" />`
                : `<div class="leaderboard-avatar"></div>`}
            <span class="leaderboard-name">${escapeHtml(r.displayName || r.email || 'Agent')}</span>
            <span class="leaderboard-total">${r.weekTotal || 0}</span>
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
document.querySelectorAll('.chart-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.chart-view-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        chartViewMode = btn.dataset.view;
        renderChart();
    });
});

// ── PWA service worker ──────────────────────────
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    });
}
