// ─────────────────────────────────────────────
// Zendesk Ticket Tracker — Popup JS
// Dashboard logic, settings, custom calendar picker, chart rendering
// Google Auth integration
// ─────────────────────────────────────────────

'use strict';

// ── State ─────────────────────────────────────
let currentRange = 'today';
let stats = null;
let chartInstance = null;

// Picker state
let customRangeParams = null; // null means use rolling default
let pickerVisible = false;
let pickerDate = new Date(); // for browsing months/years in calendar
let dailyTotalsRef = {}; // ref to latest dates with data

// ── Color palette ─────────────────────────────
const COLORS = {
    open: { bg: 'rgba(255,107,107,0.85)', border: '#ff6b6b' },
    new: { bg: 'rgba(255,217,61,0.85)', border: '#ffd93d' },
    team: { bg: 'rgba(116,185,255,0.85)', border: '#74b9ff' },
    compliance: { bg: 'rgba(46,204,113,0.85)', border: '#2ecc71' },
    escalation: { bg: 'rgba(181,114,62,0.85)', border: '#b5723e' },
    closed: { bg: 'rgba(149,165,166,0.85)', border: '#95a5a6' }
};

// ── Utility ───────────────────────────────────
function $(id) { return document.getElementById(id); }

function showToast(msg, duration = 2200) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), duration);
}

function bumpValue(el) {
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
}

function fmtDateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtShortDateStr(dateStr) {
    const [, m, d] = dateStr.split('-');
    return `${parseInt(m)}/${parseInt(d)}`;
}

// ── Auth Flow ─────────────────────────────────

function showAuthScreen() {
    $('auth-screen').classList.add('visible');
    $('app-main').classList.remove('visible');
}

function showAppMain() {
    $('auth-screen').classList.remove('visible');
    $('app-main').classList.add('visible');
}

function checkAuthAndInit() {
    chrome.runtime.sendMessage({ action: 'GET_AUTH_STATE' }, (response) => {
        if (chrome.runtime.lastError || !response) {
            showAuthScreen();
            return;
        }

        if (response.isSignedIn && response.user) {
            showAppMain();
            loadStats(() => {
                updateChartTitle();
                renderStats();
                renderChart();
            });
        } else {
            showAuthScreen();
        }
    });
}

// Sign in button
$('google-signin-btn').addEventListener('click', () => {
    const btn = $('google-signin-btn');
    const errEl = $('auth-error');
    errEl.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Signing in…';

    chrome.runtime.sendMessage({ action: 'SIGN_IN' }, (response) => {
        btn.disabled = false;
        btn.innerHTML = '<img src="icons/google.svg" alt="" width="20" height="20" /> Sign in with Google';

        if (chrome.runtime.lastError) {
            errEl.textContent = 'Connection error. Try again.';
            return;
        }

        if (response && response.success) {
            showAppMain();
            loadStats(() => {
                updateChartTitle();
                renderStats();
                renderChart();
            });
        } else {
            errEl.textContent = response?.error || 'Sign-in failed. Try again.';
        }
    });
});

// Sign out button
$('sign-out-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'SIGN_OUT' }, (response) => {
        if (chrome.runtime.lastError) return;
        if (response && response.success) {
            showAuthScreen();
            showToast('Signed out');
            // Close settings panel if open
            $('settings-panel').classList.remove('open');
            $('settings-btn').classList.remove('active');
        }
    });
});

// ── Load stats from background ────────────────
function loadStats(callback) {
    if (!customRangeParams) {
        chrome.runtime.sendMessage({ action: 'GET_STATS' }, (response) => {
            if (chrome.runtime.lastError || !response) {
                showToast('⚠ Failed to load stats');
                return;
            }
            stats = response;
            dailyTotalsRef = response.dailyTotals || {};
            applyTheme(stats.theme);
            applySettingsUI();
            if (callback) callback();
        });
    } else {
        chrome.runtime.sendMessage({
            action: 'GET_STATS_FOR_RANGE',
            rangeType: currentRange,
            params: customRangeParams
        }, (response) => {
            if (chrome.runtime.lastError || !response) return;
            // Merge custom range data into existing shape
            stats[currentRange] = response.rangeStats;
            if (currentRange === 'today') {
                stats.todayChart = response.rangeChart;
            } else if (currentRange === 'week') {
                stats.weekChart = response.rangeChart;
            } else if (currentRange === 'month') {
                stats.monthChart = response.rangeChart;
            }
            if (callback) callback();
        });
    }
}

// ── Settings & Theme ──────────────────────────
function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme || 'dark');
    $('theme-toggle').setAttribute('aria-checked', theme === 'light' ? 'true' : 'false');
    $('theme-sublabel').textContent = theme === 'light' ? 'Light mode' : 'Dark mode';
    if (chartInstance) renderChart(); // re-render to update tooltip colors
}

function applySettingsUI() {
    if (stats.agentName) $('agent-name').textContent = stats.agentName;
    $('agent-name-input').value = stats.agentName || '';
    $('counting-toggle').setAttribute('aria-checked', stats.countingEnabled !== false ? 'true' : 'false');

    // User profile from auth
    if (stats.user) {
        $('user-display-name').textContent = stats.user.displayName || stats.user.email || 'User';
        $('user-email').textContent = stats.user.email || '';
        $('sync-status').textContent = '☁️ Synced to Google account';
    } else {
        $('user-display-name').textContent = 'Not signed in';
        $('user-email').textContent = '';
        $('sync-status').textContent = 'Not connected';
    }

    // Telegram
    $('tg-token-input').value = stats.tgToken || '';
    $('tg-chat-id-input').value = stats.tgChatId || '';
    $('tg-status').textContent = (stats.tgToken && stats.tgChatId) ? '✓ Telegram connected' : '';
}

$('settings-btn').addEventListener('click', () => {
    $('settings-btn').classList.toggle('active');
    $('settings-panel').classList.toggle('open');
    $('settings-panel').setAttribute('aria-hidden', !$('settings-panel').classList.contains('open'));
});

$('save-name').addEventListener('click', () => {
    const name = $('agent-name-input').value.trim();
    chrome.runtime.sendMessage({ action: 'SET_AGENT_NAME', name }, () => {
        $('agent-name').textContent = name || 'Zendesk Agent';
        showToast('✓ Name saved');
        $('settings-btn').click(); // close panel
    });
});
$('agent-name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('save-name').click(); });

$('counting-toggle').addEventListener('click', () => {
    const btn = $('counting-toggle');
    const isNowEnabled = btn.getAttribute('aria-checked') !== 'true';
    btn.setAttribute('aria-checked', isNowEnabled);
    chrome.runtime.sendMessage({ action: 'SET_COUNTING', enabled: isNowEnabled }, () => {
        stats.countingEnabled = isNowEnabled;
    });
});

$('theme-toggle').addEventListener('click', () => {
    const btn = $('theme-toggle');
    const isNowLight = btn.getAttribute('aria-checked') !== 'true';
    const newTheme = isNowLight ? 'light' : 'dark';
    chrome.runtime.sendMessage({ action: 'SET_THEME', theme: newTheme }, () => {
        stats.theme = newTheme;
        applyTheme(newTheme);
    });
});

// ── Telegram Settings ─────────────────────────
$('save-tg-btn').addEventListener('click', () => {
    const tgToken = $('tg-token-input').value.trim();
    const tgChatId = $('tg-chat-id-input').value.trim();
    chrome.runtime.sendMessage({ action: 'SET_TELEGRAM', tgToken, tgChatId }, (response) => {
        if (response && response.success) {
            stats.tgToken = tgToken;
            stats.tgChatId = tgChatId;
            $('tg-status').textContent = (tgToken && tgChatId) ? '✓ Telegram connected' : 'Telegram credentials cleared';
            showToast('✓ Telegram settings saved');
        }
    });
});
$('tg-token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('save-tg-btn').click(); });
$('tg-chat-id-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('save-tg-btn').click(); });

// ── Force Sync ────────────────────────────────
$('force-sync-btn').addEventListener('click', () => {
    $('sync-status').textContent = '🔄 Syncing…';
    chrome.runtime.sendMessage({ action: 'FORCE_SYNC' }, (response) => {
        if (chrome.runtime.lastError || !response) {
            $('sync-status').textContent = '⚠️ Sync failed';
            showToast('⚠ Sync failed');
            return;
        }
        showToast('✓ Synced with cloud');
        loadStats(() => {
            renderStats();
            renderLastTicket();
            renderChart();
            $('sync-status').textContent = '☁️ Synced to Google account';
        });
    });
});

// ── Render stat cards ─────────────────────────
function renderStats() {
    if (!stats) return;

    let data;
    switch (currentRange) {
        case 'week': data = stats.week; break;
        case 'month': data = stats.month; break;
        default: data = stats.today; break;
    }

    const fields = ['open', 'new', 'team', 'compliance', 'escalation', 'closed'];
    fields.forEach(f => {
        const el = $(`stat-${f}`);
        const prev = parseInt(el.textContent) || 0;
        const next = data[f] ?? 0;
        el.textContent = next;
        if (next !== prev) bumpValue(el);
    });

    const totalEl = $('stat-total');
    totalEl.textContent = data.total ?? 0;

    // All-time
    const at = stats.allTime;
    $('alltime-total').textContent = at.total ?? 0;
    $('alltime-sub').textContent = `Open: ${at.open ?? 0} · New: ${at.new ?? 0} · Team: ${at.team ?? 0} · Cmpl: ${at.compliance ?? 0} · Esc: ${at.escalation ?? 0} · Closed: ${at.closed ?? 0}`;

    renderLastTicket();
}

// ── Render last handled ticket ────────────────────────────────────────────
const TYPE_LABELS_FULL = {
    open: 'Open', new: 'New', team: 'Team',
    compliance: 'Compliance', escalation: 'Escalation', closed: 'Closed'
};

function relativeTime(ts) {
    if (!ts) return '';
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60)   return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

function renderLastTicket() {
    const last = stats && stats.lastEvent;
    const dotEl  = $('last-ticket-dot');
    const numEl  = $('last-ticket-num');
    const typeEl = $('last-ticket-type');
    const timeEl = $('last-ticket-time');
    if (!dotEl || !numEl || !typeEl || !timeEl) return;

    if (!last) {
        dotEl.className = 'last-ticket-dot';
        numEl.textContent = '—';
        typeEl.textContent = 'No tickets yet';
        timeEl.textContent = '';
        return;
    }

    dotEl.className = `last-ticket-dot type-${last.type}`;
    numEl.textContent = last.ticketNumber ? `#${last.ticketNumber}` : '—';
    typeEl.textContent = TYPE_LABELS_FULL[last.type] || last.type;
    timeEl.textContent = relativeTime(last.timestamp);
}

// ── Build chart dataset ───────────────────────
function buildChartData() {
    if (!stats) return null;

    let chartData = [];
    if (currentRange === 'today') {
        if (!customRangeParams) {
            const d = stats.today;
            return {
                labels: ['Today'],
                datasets: [
                    { label: 'Open', data: [d.open ?? 0], backgroundColor: COLORS.open.bg, borderColor: COLORS.open.border, borderWidth: 1.5, borderRadius: 4 },
                    { label: 'New', data: [d.new ?? 0], backgroundColor: COLORS.new.bg, borderColor: COLORS.new.border, borderWidth: 1.5, borderRadius: 4 },
                    { label: 'Team', data: [d.team ?? 0], backgroundColor: COLORS.team.bg, borderColor: COLORS.team.border, borderWidth: 1.5, borderRadius: 4 },
                    { label: 'Compliance', data: [d.compliance ?? 0], backgroundColor: COLORS.compliance.bg, borderColor: COLORS.compliance.border, borderWidth: 1.5, borderRadius: 4 },
                    { label: 'Escalation', data: [d.escalation ?? 0], backgroundColor: COLORS.escalation.bg, borderColor: COLORS.escalation.border, borderWidth: 1.5, borderRadius: 4 },
                    { label: 'Closed', data: [d.closed ?? 0], backgroundColor: COLORS.closed.bg, borderColor: COLORS.closed.border, borderWidth: 1.5, borderRadius: 4 }
                ]
            };
        } else {
            chartData = stats.todayChart;
        }
    } else {
        chartData = currentRange === 'week' ? stats.weekChart : stats.monthChart;
    }

    if (!chartData || !chartData.length) return null;

    return {
        labels: chartData.map(d => fmtShortDateStr(d.date)),
        datasets: [
            { label: 'Open', data: chartData.map(d => d.open ?? 0), backgroundColor: COLORS.open.bg, borderColor: COLORS.open.border, borderWidth: 1.5, borderRadius: 3 },
            { label: 'New', data: chartData.map(d => d.new ?? 0), backgroundColor: COLORS.new.bg, borderColor: COLORS.new.border, borderWidth: 1.5, borderRadius: 3 },
            { label: 'Team', data: chartData.map(d => d.team ?? 0), backgroundColor: COLORS.team.bg, borderColor: COLORS.team.border, borderWidth: 1.5, borderRadius: 3 },
            { label: 'Compliance', data: chartData.map(d => d.compliance ?? 0), backgroundColor: COLORS.compliance.bg, borderColor: COLORS.compliance.border, borderWidth: 1.5, borderRadius: 3 },
            { label: 'Escalation', data: chartData.map(d => d.escalation ?? 0), backgroundColor: COLORS.escalation.bg, borderColor: COLORS.escalation.border, borderWidth: 1.5, borderRadius: 3 },
            { label: 'Closed', data: chartData.map(d => d.closed ?? 0), backgroundColor: COLORS.closed.bg, borderColor: COLORS.closed.border, borderWidth: 1.5, borderRadius: 3 }
        ]
    };
}

// ── Render chart ──────────────────────────────
function renderChart() {
    const ctx = $('main-chart').getContext('2d');
    const data = buildChartData();

    if (chartInstance) {
        chartInstance.destroy();
        chartInstance = null;
    }

    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const gridColor = isLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.04)';
    const gridColorY = isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)';
    const ticksColor = isLight ? 'rgba(0,0,0,0.4)' : 'rgba(255,255,255,0.4)';
    const tooltipBg = isLight ? 'rgba(26,29,53,0.95)' : 'rgba(13,15,28,0.95)';
    const tooltipBorder = isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.1)';

    if (!data) {
        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.fillStyle = isLight ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.15)';
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
            animation: { duration: 400, easing: 'easeInOutQuart' },
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
                    stacked: false,
                    grid: { color: gridColor, drawBorder: false },
                    ticks: { color: ticksColor, font: { size: 10, family: 'Inter' } },
                    border: { display: false }
                },
                y: {
                    stacked: false,
                    beginAtZero: true,
                    grid: { color: gridColorY, drawBorder: false },
                    ticks: {
                        color: ticksColor,
                        font: { size: 10, family: 'Inter' },
                        stepSize: 1,
                        precision: 0
                    },
                    border: { display: false }
                }
            }
        }
    });
}

// ── Range switcher ────────────────────────────
document.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentRange = btn.dataset.range;

        // Reset to default on range change
        customRangeParams = null;
        updateChartTitle();
        closePicker();

        loadStats(() => { renderStats(); renderChart(); });
    });
});

function updateChartTitle() {
    const titles = { today: 'Today', week: 'Last 7 Days', month: 'This Month' };
    let t = titles[currentRange];

    if (customRangeParams) {
        if (currentRange === 'today') {
            t = fmtShortDateStr(customRangeParams.date);
        } else if (currentRange === 'week') {
            const start = new Date(customRangeParams.weekStart);
            const end = new Date(start); end.setDate(start.getDate() + 6);
            t = `${start.getMonth() + 1}/${start.getDate()} - ${end.getMonth() + 1}/${end.getDate()}`;
        } else if (currentRange === 'month') {
            const [y, m] = customRangeParams.month.split('-');
            const md = new Date(y, parseInt(m) - 1, 1);
            t = md.toLocaleString('default', { month: 'short', year: 'numeric' });
        }
    }

    $('chart-title').textContent = t;
}

// ── Date Picker Logic ─────────────────────────
$('chart-title-btn').addEventListener('click', () => {
    pickerVisible = !pickerVisible;
    if (pickerVisible) {
        openPicker();
    } else {
        closePicker();
    }
});

function closePicker() {
    pickerVisible = false;
    $('date-picker-panel').classList.remove('open');
    $('date-picker-panel').setAttribute('aria-hidden', 'true');
    $('chart-title-btn').classList.remove('active');
}

function openPicker() {
    pickerVisible = true;
    $('date-picker-panel').classList.add('open');
    $('date-picker-panel').setAttribute('aria-hidden', 'false');
    $('chart-title-btn').classList.add('active');

    // Set pickerDate to currently viewed custom date, or today
    if (customRangeParams) {
        if (currentRange === 'today') pickerDate = new Date(customRangeParams.date + 'T00:00:00');
        if (currentRange === 'week') pickerDate = new Date(customRangeParams.weekStart + 'T00:00:00');
        if (currentRange === 'month') pickerDate = new Date(customRangeParams.month + '-01T00:00:00');
    } else {
        pickerDate = new Date();
    }

    renderPicker();
}

$('picker-prev').addEventListener('click', () => navigatePicker(-1));
$('picker-next').addEventListener('click', () => navigatePicker(1));

function navigatePicker(dir) {
    if (currentRange === 'month') {
        pickerDate.setFullYear(pickerDate.getFullYear() + dir);
    } else {
        pickerDate.setMonth(pickerDate.getMonth() + dir);
    }
    renderPicker();
}

function renderPicker() {
    if (currentRange === 'month') {
        $('picker-cal').style.display = 'none';
        $('picker-months').style.display = 'grid';
        $('picker-period').textContent = pickerDate.getFullYear();
        renderMonths();
    } else {
        $('picker-months').style.display = 'none';
        $('picker-cal').style.display = 'grid';
        const m = pickerDate.toLocaleString('default', { month: 'long' });
        $('picker-period').textContent = `${m} ${pickerDate.getFullYear()}`;
        renderCalendar();
    }
}

function renderMonths() {
    const container = $('picker-months');
    container.innerHTML = '';

    const year = pickerDate.getFullYear();
    const selMonth = customRangeParams && currentRange === 'month' ? customRangeParams.month : null;

    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    months.forEach((mName, i) => {
        const mKey = `${year}-${String(i + 1).padStart(2, '0')}`;
        const btn = document.createElement('div');
        btn.className = 'picker-month';
        btn.textContent = mName;
        if (selMonth === mKey) btn.classList.add('selected');

        // check if this month has any data
        const hasData = Object.keys(dailyTotalsRef).some(k => k.startsWith(mKey));
        if (hasData) btn.style.fontWeight = '700';

        btn.addEventListener('click', () => {
            customRangeParams = { month: mKey };
            updateChartTitle();
            closePicker();
            loadStats(() => { renderStats(); renderChart(); });
        });
        container.appendChild(btn);
    });
}

function renderCalendar() {
    const cal = $('picker-cal');
    cal.innerHTML = '';
    cal.className = currentRange === 'week' ? 'picker-cal week-mode' : 'picker-cal';

    // Headers
    ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach(d => {
        const h = document.createElement('div');
        h.className = 'picker-cal-header';
        h.textContent = d;
        cal.appendChild(h);
    });

    const year = pickerDate.getFullYear();
    const month = pickerDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);

    // Calculate start date (Sunday of the first week)
    const start = new Date(firstDay);
    start.setDate(start.getDate() - start.getDay());

    let current = new Date(start);
    const todayStr = fmtDateKey(new Date());

    // Selected keys
    let selDateStr = null;
    let selWeekStartStr = null;
    let selWeekEndStr = null;
    if (customRangeParams) {
        if (currentRange === 'today') selDateStr = customRangeParams.date;
        if (currentRange === 'week') {
            selWeekStartStr = customRangeParams.weekStart;
            const wEnd = new Date(selWeekStartStr + 'T00:00:00');
            wEnd.setDate(wEnd.getDate() + 6);
            selWeekEndStr = fmtDateKey(wEnd);
        }
    }

    // Render rows until all days of the current month are shown
    let doneWithMonth = false;
    for (let r = 0; r < 7 && !doneWithMonth; r++) {
        const rowWrap = document.createElement('div');
        if (currentRange === 'week') {
            rowWrap.className = 'picker-row-span';
            const rowStartStr = fmtDateKey(current);
            // check if this row is selected week
            if (selWeekStartStr && rowStartStr === selWeekStartStr) {
                rowWrap.classList.add('selected');
            }

            rowWrap.addEventListener('click', () => {
                customRangeParams = { weekStart: rowStartStr };
                updateChartTitle();
                closePicker();
                loadStats(() => { renderStats(); renderChart(); });
            });
        } else {
            rowWrap.className = 'picker-row-group';
        }

        for (let c = 0; c < 7; c++) {
            const dStr = fmtDateKey(current);
            const dayDiv = document.createElement('div');
            dayDiv.className = 'picker-day';
            dayDiv.textContent = current.getDate();

            if (current.getMonth() !== month) dayDiv.classList.add('dim');
            if (dStr === todayStr) dayDiv.classList.add('today');
            if (dailyTotalsRef[dStr]) dayDiv.classList.add('has-data');

            if (currentRange === 'today') {
                if (dStr === selDateStr) dayDiv.classList.add('selected');
                dayDiv.addEventListener('click', (e) => {
                    e.stopPropagation();
                    customRangeParams = { date: dStr };
                    updateChartTitle();
                    closePicker();
                    loadStats(() => { renderStats(); renderChart(); });
                });
            }

            rowWrap.appendChild(dayDiv);
            current.setDate(current.getDate() + 1);
        }
        cal.appendChild(rowWrap);

        // Stop after we've gone past the last day of the month
        if (current.getMonth() !== month) doneWithMonth = true;
    }
}


// ── Undo ──────────────────────────────────────
$('undo-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'UNDO' }, (response) => {
        if (chrome.runtime.lastError || !response) return;
        if (response.success) {
            const labels = { open: '🔴 Open', new: '🟡 New', team: '🔵 Team', compliance: '🟢 Compliance', escalation: '🟤 Escalation', closed: '⚪ Closed' };
            showToast(`↩ Undone: ${labels[response.undoneType] || 'ticket'}`);
            loadStats(() => { renderStats(); renderChart(); renderLastTicket(); });
        } else {
            showToast(response.message || 'Nothing to undo');
        }
    });
});

// ── Export ────────────────────────────────────
function triggerDownload(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

$('export-csv').addEventListener('click', () => {
    // Build a human-readable filename that reflects the selected period
    let fileLabel = new Date().toISOString().split('T')[0]; // default: today
    if (customRangeParams) {
        if (customRangeParams.date) {
            fileLabel = customRangeParams.date;
        } else if (customRangeParams.weekStart) {
            const end = new Date(customRangeParams.weekStart);
            end.setDate(end.getDate() + 6);
            fileLabel = `week-${customRangeParams.weekStart}_${fmtDateKey(end)}`;
        } else if (customRangeParams.month) {
            fileLabel = customRangeParams.month;
        }
    } else if (currentRange === 'week') {
        // Rolling last-7-days: label as the 7-day span
        const today = new Date();
        const weekAgo = new Date(); weekAgo.setDate(today.getDate() - 6);
        fileLabel = `week-${fmtDateKey(weekAgo)}_${fmtDateKey(today)}`;
    } else if (currentRange === 'month') {
        // Rolling current month
        const now = new Date();
        fileLabel = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }

    chrome.runtime.sendMessage({
        action: 'EXPORT',
        format: 'csv',
        rangeType: currentRange,
        rangeParams: customRangeParams
    }, (response) => {
        if (chrome.runtime.lastError || !response) return;
        triggerDownload(response.data, `tickets-${fileLabel}.csv`, 'text/csv');
        showToast('✓ CSV exported');
    });
});

$('export-json').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'EXPORT', format: 'json' }, (response) => {
        if (chrome.runtime.lastError || !response) return;
        const today = new Date().toISOString().split('T')[0];
        triggerDownload(response.data, `tickets-${today}.json`, 'application/json');
        showToast('✓ JSON exported');
    });
});

// ── Detailed Chart Modal ──────────────────────
let detailChartInstance = null;
let detailRange = 'today';
let detailDateParam = null; // null = current/rolling

function openDetailModal() {
    const modal = $('detail-modal');
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    detailRange = currentRange === 'today' ? 'today' : currentRange === 'week' ? 'week' : 'month';

    // Inherit the date from the main widget's custom date picker
    if (customRangeParams) {
        if (customRangeParams.date) {
            detailDateParam = customRangeParams.date;
        } else if (customRangeParams.weekStart) {
            detailDateParam = customRangeParams.weekStart;
        } else if (customRangeParams.month) {
            detailDateParam = customRangeParams.month + '-01';
        }
    } else {
        detailDateParam = null;
    }

    // Sync range buttons
    document.querySelectorAll('.detail-range-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.drange === detailRange);
    });

    loadDetailChart();
}

function closeDetailModal() {
    const modal = $('detail-modal');
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    if (detailChartInstance) {
        detailChartInstance.destroy();
        detailChartInstance = null;
    }
}

function loadDetailChart() {
    chrome.runtime.sendMessage({
        action: 'GET_DETAILED_STATS',
        range: detailRange,
        dateParam: detailDateParam
    }, (response) => {
        if (chrome.runtime.lastError || !response || response.error) return;
        renderDetailChart(response);
    });
}

function renderDetailChart(response) {
    const ctx = $('detail-chart').getContext('2d');

    if (detailChartInstance) {
        detailChartInstance.destroy();
        detailChartInstance = null;
    }

    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const gridColor = isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)';
    const ticksColor = isLight ? 'rgba(0,0,0,0.4)' : 'rgba(255,255,255,0.4)';
    const tooltipBg = isLight ? 'rgba(26,29,53,0.95)' : 'rgba(13,15,28,0.95)';

    const chartData = response.data;
    if (!chartData || !chartData.length) {
        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.fillStyle = isLight ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.15)';
        ctx.font = '12px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No data for this period', ctx.canvas.width / 2, ctx.canvas.height / 2);
        return;
    }

    const labels = chartData.map(d => d.label);
    const ALL_TYPES = ['open', 'new', 'team', 'compliance', 'escalation', 'closed'];
    const TYPE_LABELS = { open: 'Open', new: 'New', team: 'Team', compliance: 'Compliance', escalation: 'Escalation', closed: 'Closed' };

    const datasets = ALL_TYPES.map(t => ({
        label: TYPE_LABELS[t],
        data: chartData.map(d => d[t] ?? 0),
        borderColor: COLORS[t].border,
        backgroundColor: COLORS[t].bg.replace('0.85', '0.15'),
        borderWidth: 2,
        pointRadius: 3,
        pointHoverRadius: 5,
        pointBackgroundColor: COLORS[t].border,
        tension: 0.3,
        fill: false
    }));

    // Update title — clearly show what period is being viewed
    let title = 'Today (Hourly)';
    if (detailRange === 'today') {
        if (detailDateParam) {
            const [, m, d] = detailDateParam.split('-');
            title = `${parseInt(m)}/${parseInt(d)} (Hourly)`;
        } else {
            title = 'Today (Hourly)';
        }
    } else if (detailRange === 'week') {
        if (detailDateParam) {
            // Show the 7-day range ending on detailDateParam
            const end = new Date(detailDateParam + 'T00:00:00');
            const start = new Date(end);
            start.setDate(start.getDate() - 6);
            title = `${start.getMonth()+1}/${start.getDate()} - ${end.getMonth()+1}/${end.getDate()}`;
        } else {
            title = 'Last 7 Days';
        }
    } else if (detailRange === 'month') {
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        if (detailDateParam) {
            const monthNum = parseInt(detailDateParam.split('-')[1]);
            title = `${monthNames[monthNum - 1]} (3-Day Groups)`;
        } else {
            const now = new Date();
            title = `${monthNames[now.getMonth()]} (3-Day Groups)`;
        }
    }
    $('detail-chart-title').textContent = title;

    detailChartInstance = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 400, easing: 'easeInOutQuart' },
            interaction: {
                mode: 'index',
                intersect: false
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: tooltipBg,
                    borderColor: 'rgba(255,255,255,0.1)',
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
                        color: ticksColor,
                        font: { size: 9, family: 'Inter' },
                        maxRotation: detailRange === 'today' ? 0 : 45,
                        autoSkip: true,
                        maxTicksLimit: detailRange === 'today' ? 12 : 15
                    },
                    border: { display: false }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: gridColor, drawBorder: false },
                    ticks: {
                        color: ticksColor,
                        font: { size: 10, family: 'Inter' },
                        stepSize: 1,
                        precision: 0
                    },
                    border: { display: false }
                }
            }
        }
    });
}

// Expand button
$('chart-expand-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    openDetailModal();
});

// Close button
$('detail-close-btn').addEventListener('click', closeDetailModal);

// Click overlay to close
$('detail-modal').addEventListener('click', (e) => {
    if (e.target === $('detail-modal')) closeDetailModal();
});

// Range buttons inside modal — keep the selected date, just switch view
document.querySelectorAll('.detail-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.detail-range-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        detailRange = btn.dataset.drange;
        // Keep detailDateParam so the same date context is shown in new range
        loadDetailChart();
    });
});

// Date picker for detailed chart
$('detail-date-btn').addEventListener('click', () => {
    $('detail-date-input').showPicker();
});

$('detail-date-input').addEventListener('change', (e) => {
    const val = e.target.value;
    if (val) {
        // Keep current range, just change the date
        detailDateParam = val;
        loadDetailChart();
    }
});

// ── Init ──────────────────────────────────────
checkAuthAndInit();
