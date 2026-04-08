// ─────────────────────────────────────────────
// Zendesk Ticket Tracker — Background Service Worker
// Storage engine: append-only event log + precomputed daily totals
// Cross-device sync via Firebase Firestore REST API
// ─────────────────────────────────────────────

// Firebase helpers loaded via importScripts (manifest type changed to non-module)
importScripts('firebase-config.js');

// ── Helpers ──────────────────────────────────

function dateKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayKey() {
  return dateKey(Date.now());
}

// ── Cloud Sync Constants ──────────────────────

const CLOUD_SYNC_COOLDOWN = 10 * 60 * 1000; // 10 minutes
let lastCloudSyncTime = 0;

// ── Storage helpers ───────────────────────────

// ── Generic Promise wrapper for chrome.storage.local
async function getLocal() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ['events', 'dailyTotals', 'ticketLog', 'agentName', 'countingEnabled', 'theme', 'syncId', 'tgToken', 'tgChatId'],
      (result) => {
        if (chrome.runtime.lastError) {
          console.error('[ZTK] Failed to read local storage:', chrome.runtime.lastError.message);
          resolve({
            events: [],
            dailyTotals: {},
            ticketLog: [],
            agentName: '',
            countingEnabled: true,
            theme: 'dark',
            syncId: '',
            tgToken: '',
            tgChatId: ''
          });
          return;
        }
        resolve({
          events: result.events ?? [],
          dailyTotals: result.dailyTotals ?? {},
          ticketLog: result.ticketLog ?? [],
          agentName: result.agentName ?? '',
          countingEnabled: result.countingEnabled !== false, // default true
          theme: result.theme ?? 'dark',
          syncId: result.syncId ?? '',
          tgToken: result.tgToken ?? '',
          tgChatId: result.tgChatId ?? ''
        });
      }
    );
  });
}

// Alias for backward compatibility within the file
async function getAll() {
  return getLocal();
}

async function saveLocal(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set(data, () => {
      if (chrome.runtime.lastError) {
        console.error('[ZTK] Failed to save to local storage:', chrome.runtime.lastError.message);
      }
      resolve();
    });
  });
}

// ── Cloud Sync: Push to Firestore ─────────────

async function syncToCloud(dailyTotals, settings) {
  const syncId = settings.syncId || (await getLocal()).syncId;
  if (!syncId) {
    console.log('[ZTK Cloud] No Sync ID set, skipping cloud sync');
    return false;
  }
  if (!isFirebaseConfigured()) {
    console.log('[ZTK Cloud] Firebase not configured, skipping cloud sync');
    return false;
  }

  try {
    console.log('[ZTK Cloud] Pushing data to Firestore…');
    await firestoreWrite(syncId, dailyTotals, settings);
    console.log('[ZTK Cloud] ✓ Successfully synced to Firestore');
    return true;
  } catch (e) {
    console.error('[ZTK Cloud] ✗ Failed to push to Firestore:', e.message);
    return false;
  }
}

// ── Cloud Sync: Pull from Firestore ───────────

async function pullFromCloud() {
  const localData = await getLocal();
  if (!localData.syncId) {
    console.log('[ZTK Cloud] No Sync ID set, skipping cloud pull');
    return null;
  }
  if (!isFirebaseConfigured()) {
    console.log('[ZTK Cloud] Firebase not configured, skipping cloud pull');
    return null;
  }

  try {
    console.log('[ZTK Cloud] Pulling data from Firestore…');
    const remoteData = await firestoreRead(localData.syncId);

    if (!remoteData) {
      console.log('[ZTK Cloud] No data found in Firestore for this Sync ID — uploading local data');
      // First time: push local data to cloud
      await syncToCloud(localData.dailyTotals, {
        agentName: localData.agentName,
        theme: localData.theme,
        countingEnabled: localData.countingEnabled,
        syncId: localData.syncId
      });
      return localData.dailyTotals;
    }

    // Merge: max-per-field strategy
    const merged = mergeDailyTotals(localData.dailyTotals, remoteData.dailyTotals);

    // Save merged data locally
    const updates = { dailyTotals: merged };
    if (remoteData.agentName && !localData.agentName) {
      updates.agentName = remoteData.agentName;
    }
    await saveLocal(updates);
    lastCloudSyncTime = Date.now();

    // If we changed anything, push merged result back
    if (dailyTotalsChanged(merged, remoteData.dailyTotals)) {
      console.log('[ZTK Cloud] Local had data not in cloud, pushing merged result back');
      await syncToCloud(merged, {
        agentName: updates.agentName || localData.agentName,
        theme: localData.theme,
        countingEnabled: localData.countingEnabled,
        syncId: localData.syncId
      });
    }

    const localDays = Object.keys(localData.dailyTotals).length;
    const remoteDays = Object.keys(remoteData.dailyTotals).length;
    const mergedDays = Object.keys(merged).length;
    console.log(`[ZTK Cloud] ✓ Merged: ${localDays} local + ${remoteDays} remote = ${mergedDays} total days`);

    return merged;
  } catch (e) {
    console.error('[ZTK Cloud] ✗ Failed to pull from Firestore:', e.message);
    return null;
  }
}

// Debounced cloud pull: only runs if cooldown has elapsed
async function pullFromCloudIfNeeded() {
  const now = Date.now();
  if (now - lastCloudSyncTime < CLOUD_SYNC_COOLDOWN) {
    return;
  }
  await pullFromCloud();
}

// ── Merge Helpers ─────────────────────────────

function mergeDailyTotals(local, remote) {
  const merged = { ...local };
  const ALL_TYPES = ['open', 'new', 'team', 'compliance', 'escalation', 'closed'];
  for (const [day, remoteTotals] of Object.entries(remote)) {
    if (!merged[day]) {
      merged[day] = { ...remoteTotals };
    } else {
      const m = {};
      for (const t of ALL_TYPES) {
        m[t] = Math.max(merged[day][t] ?? 0, remoteTotals[t] ?? 0);
      }
      merged[day] = m;
    }
  }
  return merged;
}

function dailyTotalsChanged(a, b) {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  const ALL_TYPES = ['open', 'new', 'team', 'compliance', 'escalation', 'closed'];
  if (aKeys.length !== bKeys.length) return true;
  for (const key of aKeys) {
    if (!b[key]) return true;
    for (const t of ALL_TYPES) {
      if ((a[key][t] ?? 0) !== (b[key][t] ?? 0)) return true;
    }
  }
  return false;
}

// ── Write-through: save to local + cloud ──────

async function saveAll(data) {
  // Always save to local first — this must never fail
  await saveLocal(data);

  // Also push to cloud (skip the events array — too large, local-only)
  if (data.dailyTotals !== undefined) {
    try {
      const localData = await getLocal();
      await syncToCloud(data.dailyTotals, {
        agentName: data.agentName ?? localData.agentName,
        theme: data.theme ?? localData.theme,
        countingEnabled: data.countingEnabled ?? localData.countingEnabled,
        syncId: localData.syncId
      });
    } catch (e) {
      console.warn('[ZTK Cloud] Cloud sync failed in saveAll, local data is safe:', e.message);
    }
  }
}

// ── Add Event ─────────────────────────────────

async function addEvent(type, ticketNumber) {
  const ts = Date.now();
  const key = dateKey(ts);
  const data = await getAll();

  // Append event
  data.events.push({ type, timestamp: ts, ticketNumber: ticketNumber || null });

  // Increment daily total
  if (!data.dailyTotals[key]) {
    data.dailyTotals[key] = { open: 0, new: 0, team: 0, compliance: 0, escalation: 0, closed: 0 };
  }
  data.dailyTotals[key][type] = (data.dailyTotals[key][type] ?? 0) + 1;

  // Append to ticket log if we have a ticket number
  if (ticketNumber) {
    data.ticketLog.push({ date: key, type, ticketNumber, timestamp: ts });
  }

  await saveAll({ events: data.events, dailyTotals: data.dailyTotals, ticketLog: data.ticketLog });
  return { success: true, totals: data.dailyTotals[key] };
}

// ── Undo Last Event ───────────────────────────

async function undoLastEvent() {
  const data = await getAll();
  if (!data.events.length) return { success: false, message: 'No events to undo.' };

  const last = data.events.pop();
  const key = dateKey(last.timestamp);

  if (data.dailyTotals[key] && data.dailyTotals[key][last.type] > 0) {
    data.dailyTotals[key][last.type] -= 1;
  }

  await saveAll({ events: data.events, dailyTotals: data.dailyTotals });
  return { success: true, undoneType: last.type };
}

// ── Aggregation ───────────────────────────────

function emptyTotals() {
  return { open: 0, new: 0, team: 0, compliance: 0, escalation: 0, closed: 0 };
}

function sumTotals(dailyTotals, keys) {
  const result = emptyTotals();
  const ALL_TYPES = ['open', 'new', 'team', 'compliance', 'escalation', 'closed'];
  for (const k of keys) {
    if (dailyTotals[k]) {
      for (const t of ALL_TYPES) {
        result[t] += dailyTotals[k][t] ?? 0;
      }
    }
  }
  result.total = ALL_TYPES.reduce((s, t) => s + result[t], 0);
  return result;
}

function getLastNDaysKeys(n, fromDate) {
  const keys = [];
  const base = fromDate ? new Date(fromDate) : new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    keys.push(dateKey(d.getTime()));
  }
  return keys.reverse();
}

function getCurrentMonthKeys(dailyTotals, yearMonth) {
  const prefix = yearMonth || todayKey().substring(0, 7); // YYYY-MM
  return Object.keys(dailyTotals).filter(k => k.startsWith(prefix)).sort();
}

// ── Stats aggregator ──────────────────────────

async function getStats() {
  // Best-effort pull from cloud — never let it break stats retrieval
  try {
    await pullFromCloudIfNeeded();
  } catch (e) {
    console.warn('[ZTK Cloud] Cloud pull failed during getStats, using local data:', e.message);
  }

  const data = await getAll();
  const dt = data.dailyTotals;

  const today = sumTotals(dt, [todayKey()]);
  const weekKeys = getLastNDaysKeys(7);
  const week = sumTotals(dt, weekKeys);
  const monthKeys = getCurrentMonthKeys(dt);
  const month = sumTotals(dt, monthKeys);
  const allKeys = Object.keys(dt);
  const allTime = sumTotals(dt, allKeys);

  // Chart data: per-day breakdown for week and month
  const weekChart = weekKeys.map(k => ({
    date: k,
    ...(dt[k] ?? emptyTotals())
  }));

  const monthChart = monthKeys.map(k => ({
    date: k,
    ...(dt[k] ?? emptyTotals())
  }));

  return {
    today,
    week,
    month,
    allTime,
    weekChart,
    monthChart,
    agentName: data.agentName,
    countingEnabled: data.countingEnabled,
    theme: data.theme,
    syncId: data.syncId,
    tgToken: data.tgToken,
    tgChatId: data.tgChatId,
    lastEvent: data.events.length > 0 ? data.events[data.events.length - 1] : null,
    todayKey: todayKey(),
    dailyTotals: dt   // expose so popup can check which days have data
  };
}

// ── Stats for a custom range ──────────────────

async function getStatsForRange(rangeType, params) {
  const data = await getAll();
  const dt = data.dailyTotals;

  let keys = [];
  let chartData = [];

  if (rangeType === 'today' || rangeType === 'day') {
    // params.date = 'YYYY-MM-DD'
    keys = [params.date];
    chartData = [{ date: params.date, ...(dt[params.date] ?? emptyTotals()) }];
  } else if (rangeType === 'week') {
    // params.weekStart = 'YYYY-MM-DD'
    keys = getLastNDaysKeys(7, (() => {
      // weekStart + 6 days
      const d = new Date(params.weekStart);
      d.setDate(d.getDate() + 6);
      return d;
    })());
    chartData = keys.map(k => ({ date: k, ...(dt[k] ?? emptyTotals()) }));
  } else if (rangeType === 'month') {
    // params.month = 'YYYY-MM'
    keys = getCurrentMonthKeys(dt, params.month);
    // Also make sure all days of the month appear (for chart visual consistency)
    const [y, m] = params.month.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const allDays = [];
    for (let d = 1; d <= daysInMonth; d++) {
      allDays.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
    chartData = allDays.map(k => ({ date: k, ...(dt[k] ?? emptyTotals()) }));
    keys = allDays;
  }

  const totals = sumTotals(dt, keys);

  return {
    rangeStats: totals,
    rangeChart: chartData,
    rangeType,
    rangeParams: params
  };
}

// ── Detailed Stats (for line chart modal) ────

async function getDetailedStats(range, dateParam) {
  const data = await getAll();
  const events = data.events;
  const dt = data.dailyTotals;
  const ALL_TYPES = ['open', 'new', 'team', 'compliance', 'escalation', 'closed'];

  if (range === 'today') {
    // Hourly breakdown for a single day
    const targetDate = dateParam || todayKey();
    const hourly = [];
    for (let h = 0; h < 24; h++) {
      const entry = { label: `${h}:00`, hour: h };
      ALL_TYPES.forEach(t => entry[t] = 0);
      hourly.push(entry);
    }
    // Count events that fall on this day by hour
    for (const ev of events) {
      const evDate = dateKey(ev.timestamp);
      if (evDate === targetDate && ALL_TYPES.includes(ev.type)) {
        const hour = new Date(ev.timestamp).getHours();
        hourly[hour][ev.type]++;
      }
    }
    return { range: 'today', date: targetDate, data: hourly };
  }

  if (range === 'week') {
    // Daily breakdown for 7 days around the selected date
    let baseDate;
    if (dateParam) {
      // Show 7 days ending on the selected date
      baseDate = new Date(dateParam + 'T00:00:00');
    } else {
      baseDate = new Date();
    }
    const keys = getLastNDaysKeys(7, baseDate);
    const daily = keys.map(k => {
      const d = new Date(k + 'T00:00:00');
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const entry = { label: `${dayNames[d.getDay()]} ${d.getMonth()+1}/${d.getDate()}`, date: k };
      ALL_TYPES.forEach(t => entry[t] = dt[k]?.[t] ?? 0);
      return entry;
    });
    return { range: 'week', data: daily };
  }

  if (range === 'month') {
    // Group by 3-day periods for the selected month
    let prefix;
    if (dateParam) {
      prefix = dateParam.substring(0, 7); // YYYY-MM from the selected date
    } else {
      prefix = todayKey().substring(0, 7);
    }
    const [y, m] = prefix.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const grouped = [];
    for (let start = 1; start <= daysInMonth; start += 3) {
      const end = Math.min(start + 2, daysInMonth);
      const label = start === end ? `${m}/${start}` : `${m}/${start}-${end}`;
      const entry = { label };
      ALL_TYPES.forEach(t => entry[t] = 0);
      for (let d = start; d <= end; d++) {
        const k = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        if (dt[k]) {
          ALL_TYPES.forEach(t => entry[t] += dt[k][t] ?? 0);
        }
      }
      grouped.push(entry);
    }
    return { range: 'month', data: grouped };
  }

  return { error: 'Invalid range' };
}

// ── Export ────────────────────────────────────

// Determine shift info based on the day of week
function getShiftInfo(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay(); // 0=Sun, 6=Sat
  if (day === 0) { // Sunday
    return { shift: 'Weekend', startTime: '8:00 AM', endTime: '12:00 PM' };
  } else if (day === 6) { // Saturday
    return { shift: 'Night', startTime: '6:00 PM', endTime: '12:00 AM' };
  } else { // Mon-Fri
    return { shift: 'Night', startTime: '6:00 PM', endTime: '10:00 PM' };
  }
}

// Map event type to CSV column name
const TYPE_TO_COLUMN = {
  'new': 'New Handled Tickets - Moved to Open or Pending',
  'open': 'Updates to Existing',
  'team': 'Updates to Existing',
  'compliance': 'New/Pending/Open Tickets- Moved to Compliance',
  'escalation': 'New/Pending/Open Tickets - Moved to Escalations',
  'closed': 'Closed Tickets if any'
};

async function exportData(format) {
  const data = await getAll();
  if (format === 'json') {
    return JSON.stringify(data, null, 2);
  }

  // CSV matching the boss's Excel format
  const headers = [
    'Date', 'Agent name', 'Shift', 'Starting Time', 'End Time',
    'New Handled Tickets - Moved to Open or Pending',
    'Updates to Existing',
    'New/Pending/Open Tickets- Moved to Compliance',
    'New/Pending/Open Tickets - Moved to Escalations',
    'Remarks- for special cases',
    'Closed Tickets if any'
  ];

  const rows = [headers];
  const agentName = data.agentName || 'Eyosias Belhu';

  // Sort ticket log by date then timestamp
  const sortedLog = [...data.ticketLog].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.timestamp - b.timestamp;
  });

  for (const entry of sortedLog) {
    const shiftInfo = getShiftInfo(entry.date);
    // Format date as M/D/YYYY
    const [y, m, d] = entry.date.split('-');
    const fmtDate = `${parseInt(m)}/${parseInt(d)}/${y}`;

    const row = [
      fmtDate,
      agentName,
      shiftInfo.shift,
      shiftInfo.startTime,
      shiftInfo.endTime,
      '', // New Handled
      '', // Updates to Existing
      '', // Compliance
      '', // Escalation
      '', // Remarks
      ''  // Closed
    ];

    // Place ticket number in the correct column
    const colName = TYPE_TO_COLUMN[entry.type];
    const colIdx = headers.indexOf(colName);
    if (colIdx !== -1) {
      row[colIdx] = `#${entry.ticketNumber}`;
    }

    rows.push(row);
  }

  // If no ticket log entries, fall back to daily totals summary
  if (sortedLog.length === 0) {
    const sorted = Object.keys(data.dailyTotals).sort();
    for (const k of sorted) {
      const dt = data.dailyTotals[k];
      const shiftInfo = getShiftInfo(k);
      const [y, m, d] = k.split('-');
      const fmtDate = `${parseInt(m)}/${parseInt(d)}/${y}`;
      const total = (dt.open ?? 0) + (dt.new ?? 0) + (dt.team ?? 0) +
                    (dt.compliance ?? 0) + (dt.escalation ?? 0) + (dt.closed ?? 0);
      if (total > 0) {
        rows.push([fmtDate, agentName, shiftInfo.shift, shiftInfo.startTime, shiftInfo.endTime,
          dt.new ?? 0, (dt.open ?? 0) + (dt.team ?? 0), dt.compliance ?? 0, dt.escalation ?? 0, '', dt.closed ?? 0]);
      }
    }
  }

  return rows.map(r => r.map(c => {
    const s = String(c);
    return s.includes(',') ? `"${s}"` : s;
  }).join(',')).join('\n');
}

// ── Agent name ────────────────────────────────

async function setAgentName(name) {
  await saveAll({ agentName: name });
  return { success: true };
}

// ── Counting enabled ──────────────────────────

async function setCounting(enabled) {
  await saveAll({ countingEnabled: enabled });
  return { success: true };
}

// ── Theme ─────────────────────────────────────

async function setTheme(theme) {
  await saveAll({ theme });
  return { success: true };
}

// ── Sync ID ───────────────────────────────────

async function setSyncId(syncId) {
  await saveLocal({ syncId });
  if (syncId && isFirebaseConfigured()) {
    // Immediately pull from cloud with the new ID
    console.log('[ZTK Cloud] Sync ID set to:', syncId, '— pulling data…');
    lastCloudSyncTime = 0; // force refresh
    await pullFromCloud();
  }
  return { success: true };
}

// ── Telegram Settings ─────────────────────────

async function saveTelegramSettings(tgToken, tgChatId) {
  await saveLocal({ tgToken, tgChatId });
  return { success: true };
}

// ── Send Telegram Note ────────────────────────

async function sendTelegramNote(text) {
  const data = await getAll();
  const token = data.tgToken;
  const chatId = data.tgChatId;

  if (!token || !chatId) {
    return { success: false, error: 'Telegram credentials not set in Settings.' };
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  
  // Strip out the custom markdown added by content.js to keep it plain text
  let plainText = text.replace('📝 **Zendesk Note**', '📝 Zendesk Note');
  // Convert 🔗 [View Ticket](url) to just the URL
  plainText = plainText.replace(/🔗 \[View Ticket\]\((.*?)\)/g, '🔗 $1');
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: plainText,
        disable_web_page_preview: true
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[Telegram] API Error:', errText);
      return { success: false, error: `Telegram Error: ${response.status}` };
    }

    return { success: true };
  } catch (err) {
    console.error('[Telegram] Network Error:', err);
    return { success: false, error: 'Network Error' };
  }
}

// ── Message handler ───────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.action) {
        case 'ADD_EVENT':
          sendResponse(await addEvent(msg.type, msg.ticketNumber));
          break;
        case 'UNDO':
          sendResponse(await undoLastEvent());
          break;
        case 'GET_STATS':
          sendResponse(await getStats());
          break;
        case 'GET_STATS_FOR_RANGE':
          sendResponse(await getStatsForRange(msg.rangeType, msg.params));
          break;
        case 'EXPORT':
          sendResponse({ data: await exportData(msg.format) });
          break;
        case 'SET_AGENT_NAME':
          sendResponse(await setAgentName(msg.name));
          break;
        case 'SET_COUNTING':
          sendResponse(await setCounting(msg.enabled));
          break;
        case 'SET_THEME':
          sendResponse(await setTheme(msg.theme));
          break;
        case 'SET_SYNC_ID':
          sendResponse(await setSyncId(msg.syncId));
          break;
        case 'SET_TELEGRAM':
          sendResponse(await saveTelegramSettings(msg.tgToken, msg.tgChatId));
          break;
        case 'SEND_TELEGRAM_NOTE':
          sendResponse(await sendTelegramNote(msg.text));
          break;
        case 'FORCE_SYNC':
          lastCloudSyncTime = 0;
          await pullFromCloud();
          sendResponse({ success: true });
          break;
        case 'GET_DETAILED_STATS':
          sendResponse(await getDetailedStats(msg.range, msg.dateParam));
          break;
        default:
          sendResponse({ error: 'Unknown action' });
      }
    } catch (e) {
      console.error('[ZTK] Message handler error:', e);
      sendResponse({ error: e.message });
    }
  })();
  return true; // keep message channel open for async
});

// ── Startup: pull latest data from cloud ──────

chrome.runtime.onStartup.addListener(async () => {
  console.log('[ZTK Cloud] Browser started — pulling latest cloud data…');
  await pullFromCloud();
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    console.log(`[ZTK Cloud] Extension ${details.reason} — syncing with cloud…`);
    await pullFromCloud();
    console.log('[ZTK Cloud] Migration complete.');
  }
});
