// ─────────────────────────────────────────────
// Zendesk Ticket Tracker — Background Service Worker
// Storage engine: append-only event log + precomputed daily totals
// Cross-device sync via Firebase Firestore REST API (Google Auth)
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
      ['events', 'dailyTotals', 'ticketLog', 'masterLogHistory', 'ticketPayeeIssues', 'agentName', 'countingEnabled', 'theme', 'tgToken', 'tgChatId', 'slackToken', 'slackUserId', 'shiftConfig', 'weeklyShiftConfig'],
      (result) => {
        if (chrome.runtime.lastError) {
          console.error('[ZTK] Failed to read local storage:', chrome.runtime.lastError.message);
          resolve({
            events: [],
            dailyTotals: {},
            ticketLog: [],
            masterLogHistory: [],
            ticketPayeeIssues: {},
            agentName: '',
            countingEnabled: true,
            theme: 'moody',
            tgToken: '',
            tgChatId: '',
            slackToken: '',
            slackUserId: '',
            shiftConfig: null,
            weeklyShiftConfig: null
          });
          return;
        }
        resolve({
          events: result.events ?? [],
          dailyTotals: result.dailyTotals ?? {},
          ticketLog: result.ticketLog ?? [],
          masterLogHistory: result.masterLogHistory ?? [],
          ticketPayeeIssues: result.ticketPayeeIssues ?? {},
          agentName: result.agentName ?? '',
          countingEnabled: result.countingEnabled !== false, // default true
          theme: result.theme ?? 'moody',
          tgToken: result.tgToken ?? '',
          tgChatId: result.tgChatId ?? '',
          slackToken: result.slackToken ?? '',
          slackUserId: result.slackUserId ?? '',
          shiftConfig: result.shiftConfig ?? null,
          weeklyShiftConfig: result.weeklyShiftConfig ?? null
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

function getWeeklyTotal(dailyTotals) {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  monday.setHours(0, 0, 0, 0);

  let total = 0;
  const ALL_TYPES = ['open', 'new', 'team', 'compliance', 'escalation', 'closed'];

  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const key = dateKey(d.getTime());
    if (dailyTotals[key]) {
      for (const t of ALL_TYPES) {
        total += dailyTotals[key][t] ?? 0;
      }
    }
  }

  return total;
}

// A day's speed record = the most tickets logged within any single
// 60-minute window that day — a rolling window checked at every ticket's
// own timestamp (two-pointer sliding-window-max), not fixed clock-hour
// buckets, so a genuine burst like 6:23-7:23 counts as one full hour
// instead of being split across two buckets and undercounted. This
// replaces the old "day total / elapsed time between first and last
// ticket" average, which rewarded having less idle time in your day almost
// as much as it rewarded actually handling more tickets, and made the
// number keep drifting down the longer a shift went on.
// Mirrors popup.js's computeDayPeakHourlyTickets — keep both in sync.
function computeDayPeakHourlyTickets(ticketLog, dateStr) {
  const timestamps = (ticketLog || [])
    .filter(e => e.date === dateStr)
    .map(e => e.timestamp)
    .sort((a, b) => a - b);
  if (!timestamps.length) return 0;

  let maxCount = 0;
  let left = 0;
  for (let right = 0; right < timestamps.length; right++) {
    while (timestamps[right] - timestamps[left] > 3600000) left++;
    maxCount = Math.max(maxCount, right - left + 1);
  }
  return maxCount;
}

function getWeeklyPeakSpeed(dailyTotals, ticketLog) {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  monday.setHours(0, 0, 0, 0);

  let peak = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const key = dateKey(d.getTime());
    if (!dailyTotals[key]) continue;
    peak = Math.max(peak, computeDayPeakHourlyTickets(ticketLog, key));
  }
  return peak;
}

function getMonthlyPeakSpeed(dailyTotals, ticketLog) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  let peak = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (!dailyTotals[key]) continue;
    peak = Math.max(peak, computeDayPeakHourlyTickets(ticketLog, key));
  }
  return peak;
}

function getMonthlyTotal(dailyTotals) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  let total = 0;
  const ALL_TYPES = ['open', 'new', 'team', 'compliance', 'escalation', 'closed'];

  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (dailyTotals[key]) {
      for (const t of ALL_TYPES) {
        total += dailyTotals[key][t] ?? 0;
      }
    }
  }

  return total;
}

async function syncToCloud(dailyTotals, ticketLog, settings) {
  if (!isFirebaseConfigured()) {
    console.log('[ZTK Cloud] Firebase not configured, skipping cloud sync');
    return false;
  }

  // Get current auth session
  const session = await getFirebaseSession(false);
  if (!session) {
    console.log('[ZTK Cloud] No auth session, skipping cloud sync');
    return false;
  }

  try {
    console.log('[ZTK Cloud] Pushing data to Firestore…');
    await firestoreWrite(session.uid, dailyTotals, ticketLog, settings, session.idToken);
    
    // Also write to the weekly + monthly leaderboards. These write the
    // CURRENT (in-progress) period's running total — that's intentional:
    // by the time that period ends, its document holds the final total,
    // and the leaderboard always *reads* the last completed period (see
    // GET_WEEKLY_LEADERBOARD / GET_MONTHLY_LEADERBOARD below), so nobody
    // sees a still-in-progress total inflate their apparent rank mid-week.
    const weekKey = getCurrentWeekKey();
    const weekTotal = getWeeklyTotal(dailyTotals);
    const weekPeakSpeed = getWeeklyPeakSpeed(dailyTotals, ticketLog);
    await writeWeeklyLeaderboardEntry(
      session.uid,
      session.idToken,
      weekKey,
      session.email,
      settings.agentName || session.displayName || session.email,
      session.photoUrl,
      weekTotal,
      weekPeakSpeed
    );

    const monthKey = getCurrentMonthKey();
    const monthTotal = getMonthlyTotal(dailyTotals);
    const monthPeakSpeed = getMonthlyPeakSpeed(dailyTotals, ticketLog);
    await writeMonthlyLeaderboardEntry(
      session.uid,
      session.idToken,
      monthKey,
      session.email,
      settings.agentName || session.displayName || session.email,
      session.photoUrl,
      monthTotal,
      monthPeakSpeed
    );

    console.log('[ZTK Cloud] ✓ Successfully synced to Firestore + weekly/monthly leaderboards');
    return true;
  } catch (e) {
    console.error('[ZTK Cloud] ✗ Failed to push to Firestore:', e.message);
    return false;
  }
}

// ── Cloud Sync: Pull from Firestore ───────────

async function pullFromCloud() {
  if (!isFirebaseConfigured()) {
    console.log('[ZTK Cloud] Firebase not configured, skipping cloud pull');
    return null;
  }

  // Get current auth session
  const session = await getFirebaseSession(false);
  if (!session) {
    console.log('[ZTK Cloud] No auth session, skipping cloud pull');
    return null;
  }

  const localData = await getLocal();

  try {
    console.log('[ZTK Cloud] Pulling data from Firestore…');
    const remoteData = await firestoreRead(session.uid, session.idToken);

    if (!remoteData) {
      console.log('[ZTK Cloud] No data found in Firestore for this user — uploading local data');
      // First time: push local data to cloud
      await syncToCloud(localData.dailyTotals, localData.ticketLog, {
        masterLogHistory: localData.masterLogHistory,
        ticketPayeeIssues: localData.ticketPayeeIssues,
        agentName: localData.agentName,
        theme: localData.theme,
        countingEnabled: localData.countingEnabled,
        shiftConfig: localData.shiftConfig,
        weeklyShiftConfig: localData.weeklyShiftConfig
      });
      return localData.dailyTotals;
    }

    // Merge ticketLog and masterLogHistory: union of all unique entries —
    // every ticket detail handled on either device survives the merge.
    const mergedLog = mergeTicketLogs(localData.ticketLog, remoteData.ticketLog);
    const mergedHistory = mergeMasterLogHistory(localData.masterLogHistory, remoteData.masterLogHistory);
    const mergedPayeeIssues = mergeTicketPayeeIssues(localData.ticketPayeeIssues, remoteData.ticketPayeeIssues);

    // dailyTotals: recompute from the merged ticketLog wherever it has entries
    // for a date (the log is the union-merged source of truth, so this is
    // additive rather than the old max(local, remote) — which silently lost
    // counts whenever both devices logged different tickets on the same day
    // before syncing). Fall back to a max-merge for any date with no
    // ticketLog backing at all (legacy data captured before ticketLog existed).
    const maxMerged = mergeDailyTotals(localData.dailyTotals, remoteData.dailyTotals);
    const merged = reconcileDailyTotalsWithLog(maxMerged, mergedLog);

    // Save merged data locally
    const updates = {
      dailyTotals: merged,
      ticketLog: mergedLog,
      masterLogHistory: mergedHistory,
      ticketPayeeIssues: mergedPayeeIssues
    };
    if (remoteData.agentName && !localData.agentName) {
      updates.agentName = remoteData.agentName;
    }
    // Shift config is authored on whichever device the agent actually
    // configures it on (usually the extension, not this pull) — a second
    // device with no shift config of its own should still pick up the
    // cloud copy rather than staying blank forever.
    if (remoteData.shiftConfig && !localData.shiftConfig) {
      updates.shiftConfig = remoteData.shiftConfig;
    }
    if (remoteData.weeklyShiftConfig && !localData.weeklyShiftConfig) {
      updates.weeklyShiftConfig = remoteData.weeklyShiftConfig;
    }
    await saveLocal(updates);
    lastCloudSyncTime = Date.now();

    // If we changed anything, push merged result back
    const changed = dailyTotalsChanged(merged, remoteData.dailyTotals)
      || mergedLog.length !== (remoteData.ticketLog || []).length
      || mergedHistory.length !== (remoteData.masterLogHistory || []).length
      || Object.keys(mergedPayeeIssues).length !== Object.keys(remoteData.ticketPayeeIssues || {}).length;

    if (changed) {
      console.log('[ZTK Cloud] Local had data not in cloud, pushing merged result back');
      await syncToCloud(merged, mergedLog, {
        masterLogHistory: mergedHistory,
        ticketPayeeIssues: mergedPayeeIssues,
        agentName: updates.agentName || localData.agentName,
        theme: localData.theme,
        countingEnabled: localData.countingEnabled,
        shiftConfig: updates.shiftConfig || localData.shiftConfig,
        weeklyShiftConfig: updates.weeklyShiftConfig || localData.weeklyShiftConfig
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

// For every date that has ticketLog entries, replace the max-merged total
// with an aggregate recomputed straight from the (already union-merged,
// deduped) ticketLog. That log is additive and lossless, so this is what
// makes "worked 3 tickets on phone A + 2 on phone B, same day" correctly
// total 5 instead of max(3, 2) = 3. Dates with no ticketLog entries at all
// (older data captured before ticketLog existed) keep their max-merged value.
function reconcileDailyTotalsWithLog(dailyTotals, ticketLog) {
  const recomputed = {};
  for (const entry of ticketLog) {
    if (!recomputed[entry.date]) recomputed[entry.date] = emptyTotals();
    recomputed[entry.date][entry.type] = (recomputed[entry.date][entry.type] ?? 0) + 1;
  }

  const result = { ...dailyTotals };
  for (const [day, totals] of Object.entries(recomputed)) {
    result[day] = totals;
  }
  return result;
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

// Fields that Firestore actually stores (see toFirestoreDoc) — a save that
// touches any one of these should push to the cloud, not just dailyTotals.
// Previously masterLogHistory/ticketPayeeIssues-only saves (payee issue
// capture, ticket-handled logging) never triggered a push on their own —
// they only rode along the next time some other action happened to also
// save dailyTotals, so a payee issue captured right before someone closed
// their laptop could sit unsynced indefinitely.
// 'theme' is deliberately excluded — appearance is a per-device preference
// (like buttonShape/tapMode), and pullFromCloud never applied it locally
// anyway, so treating it as cloud-relevant only pushed a value nothing
// ever pulled back down.
const CLOUD_RELEVANT_KEYS = ['dailyTotals', 'ticketLog', 'masterLogHistory', 'ticketPayeeIssues', 'agentName', 'countingEnabled', 'shiftConfig', 'weeklyShiftConfig'];

// Cloud pushes run on their own serialized chain, separate from
// storageWriteQueue, so a slow/jittery network request can't let a later
// push's Firestore write land before (and get overwritten by) an earlier
// one that started first but is still in flight.
let cloudSyncQueue = Promise.resolve();

async function saveAll(data) {
  // Always save to local first — this must never fail
  await saveLocal(data);

  // Push to cloud in the background (skip the events array — too large,
  // local-only). This used to be awaited here, which meant every button tap
  // sat blocked on a Firestore network round-trip before the +1 animation
  // or the "Recorded…" toast could show — the on-page feedback should be
  // instant, since the local save above already persisted the data safely.
  if (CLOUD_RELEVANT_KEYS.some(k => data[k] !== undefined)) {
    cloudSyncQueue = cloudSyncQueue.catch(() => {}).then(async () => {
      try {
        const localData = await getLocal();
        await syncToCloud(data.dailyTotals ?? localData.dailyTotals, data.ticketLog ?? localData.ticketLog, {
          masterLogHistory: data.masterLogHistory ?? localData.masterLogHistory,
          ticketPayeeIssues: data.ticketPayeeIssues ?? localData.ticketPayeeIssues,
          agentName: data.agentName ?? localData.agentName,
          theme: data.theme ?? localData.theme,
          countingEnabled: data.countingEnabled ?? localData.countingEnabled,
          shiftConfig: data.shiftConfig ?? localData.shiftConfig,
          weeklyShiftConfig: data.weeklyShiftConfig ?? localData.weeklyShiftConfig
        });
      } catch (e) {
        console.warn('[ZTK Cloud] Cloud sync failed in saveAll, local data is safe:', e.message);
      }
    });
  }
}

// ── Serialized Storage Writer ─────────────────────────────────────────────
// chrome.storage.local has no atomic read-modify-write. Every Zendesk tab
// runs its own content.js instance (each with its own 1s refresh timer), so
// two tabs — or a click handler racing the periodic refresh — can both read
// the same stale snapshot of events/dailyTotals/ticketLog/masterLogHistory/
// ticketPayeeIssues, then write back their own version a few ms apart,
// with the later write silently clobbering whatever the earlier one added.
// This is exactly what was quietly dropping captured Payee Issue Type data
// before export. Routing every read-modify-write through this single
// promise queue — which lives in the one shared service worker context for
// every tab — makes each mutation atomic relative to all the others.
let storageWriteQueue = Promise.resolve();
function queueStorageWrite(fn) {
  storageWriteQueue = storageWriteQueue.catch(() => {}).then(fn);
  return storageWriteQueue;
}

// ── Duplicate Ticket Guard ────────────────────
// Finds the most recent ticketLog entry for this ticket on this date, so
// addEvent can tell a same-category re-click (block it, nothing to do)
// apart from a re-classification into a different category (allowed — the
// ticket just moves columns in the CSV/XLSX export, see exportData's and
// exportSingleDaySpreadsheet's per-ticket dedup, which keeps it from
// appearing under both categories there).
function findLastEntryForTicketOnDate(ticketLog, ticketNumber, dateKeyStr) {
  for (let i = ticketLog.length - 1; i >= 0; i--) {
    const entry = ticketLog[i];
    if (entry.ticketNumber === ticketNumber && entry.date === dateKeyStr) return entry;
  }
  return null;
}

// ── Add Event ─────────────────────────────────

async function addEvent(type, ticketNumber) {
  return queueStorageWrite(async () => {
    const ts = Date.now();
    const key = dateKey(ts);
    const data = await getAll();

    if (ticketNumber) {
      const prior = findLastEntryForTicketOnDate(data.ticketLog, ticketNumber, key);
      if (prior && prior.type === type) {
        return { success: false, alreadyHandled: true, priorType: prior.type };
      }
    }

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
  });
}

// ── Undo Last Event ───────────────────────────

async function undoLastEvent() {
  return queueStorageWrite(async () => {
    const data = await getAll();
    if (!data.events.length) return { success: false, message: 'No events to undo.' };

    const last = data.events.pop();
    const key = dateKey(last.timestamp);

    if (data.dailyTotals[key] && data.dailyTotals[key][last.type] > 0) {
      data.dailyTotals[key][last.type] -= 1;
    }

    // Also remove the matching ticketLog entry — previously this was left
    // behind, so an "undone" ticket still showed up in CSV/XLSX exports,
    // and a cloud sync could resurrect the undone count in dailyTotals since
    // that's now recomputed from ticketLog on merge (see reconcileDailyTotalsWithLog).
    if (last.ticketNumber) {
      for (let i = data.ticketLog.length - 1; i >= 0; i--) {
        const entry = data.ticketLog[i];
        if (entry.ticketNumber === last.ticketNumber && entry.type === last.type && entry.timestamp === last.timestamp) {
          data.ticketLog.splice(i, 1);
          break;
        }
      }
    }

    await saveAll({ events: data.events, dailyTotals: data.dailyTotals, ticketLog: data.ticketLog });
    return { success: true, undoneType: last.type };
  });
}

// ── Record Payee Issue (live-scraped, periodic) ───────────────────────────

async function recordPayeeIssue(ticketId, issueVal) {
  if (!ticketId || !issueVal || issueVal === '-') return { success: true };
  return queueStorageWrite(async () => {
    const data = await getAll();
    const mapping = data.ticketPayeeIssues || {};
    if (mapping[ticketId] !== issueVal) {
      mapping[ticketId] = issueVal;
      // saveAll (not saveLocal) so this pushes to the cloud right away —
      // otherwise it only synced whenever some other action next happened
      // to also save dailyTotals.
      await saveAll({ ticketPayeeIssues: mapping });
    }
    return { success: true };
  });
}

// ── Record Ticket Handled (masterLogHistory + payee issue, on click) ─────

async function recordTicketHandled(ticketId, category, issueVal) {
  return queueStorageWrite(async () => {
    const data = await getAll();
    const masterLogHistory = data.masterLogHistory || [];
    const ticketPayeeIssues = data.ticketPayeeIssues || {};

    masterLogHistory.push({
      ticketId,
      category,
      timestamp: new Date().toISOString()
    });

    if (issueVal && issueVal !== '-') {
      ticketPayeeIssues[ticketId] = issueVal;
    }

    await saveAll({ masterLogHistory, ticketPayeeIssues });
    return { success: true };
  });
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
  // Kick off a cloud pull in the background, but don't make the popup wait
  // on it — this used to be awaited here, so opening the popup after the
  // 10-minute cooldown had elapsed (e.g. after a while spent working with
  // the popup closed) sat blocked on a full Firestore read (sometimes
  // followed by a merge-back write) before any stats could render at all,
  // showing a blank popup until the user closed and reopened it. Local
  // storage already has everything this device has done, so return that
  // immediately; a same-device reopen never needs the cloud data to show
  // accurate history.
  pullFromCloudIfNeeded().catch(e => {
    console.warn('[ZTK Cloud] Cloud pull failed during getStats, using local data:', e.message);
  });

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

  // Get user profile for the popup
  const user = await getUserProfile();

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
    tgToken: data.tgToken,
    tgChatId: data.tgChatId,
    slackToken: data.slackToken,
    slackUserId: data.slackUserId,
    shiftConfig: data.shiftConfig,
    lastEvent: data.events.length ? data.events[data.events.length - 1] : null,
    dailyTotals: dt,
    todayKey: todayKey(),
    ticketLog: data.ticketLog,
    masterLogHistory: data.masterLogHistory,
    ticketPayeeIssues: data.ticketPayeeIssues,
    user
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

// ── Payee Issue Type series for the detail modal's line chart ────────────
// Buckets are whatever the caller defines (hour-of-day / day / 3-day group).
// A ticket contributes its issue type once — at the bucket of its first
// ticketLog entry within the range — since ticketPayeeIssues only ever
// holds one (the latest) issue value per ticket, not one per event.
function getPayeeBucketSeries(ticketLog, ticketPayeeIssues, validDates, bucketFn, bucketLabels) {
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

// ── Detailed Stats (for line chart modal) ────

async function getDetailedStats(range, dateParam) {
  const data = await getAll();
  const events = data.events;
  const dt = data.dailyTotals;
  const ticketLog = data.ticketLog || [];
  const ticketPayeeIssues = data.ticketPayeeIssues || {};
  const ALL_TYPES = ['open', 'new', 'team', 'compliance', 'escalation', 'closed'];

  if (range === 'today') {
    // Hourly breakdown for a single day — the x-axis defaults to the day's
    // shift window (e.g. 12PM-5PM) instead of all 24 hours, since a whole
    // day of mostly-empty hours around a short shift made the axis far
    // less readable. Tally every hour's counts first, then widen the shift
    // window to also cover any hour that actually has activity, so a
    // ticket logged before clock-in or after clock-out never gets silently
    // cut off the chart.
    const targetDate = dateParam || todayKey();
    const { startHour, endHour } = getShiftHourRange(targetDate, data.shiftConfig, data.weeklyShiftConfig);

    const hourCounts = {};
    for (const ev of events) {
      const evDate = dateKey(ev.timestamp);
      if (evDate === targetDate && ALL_TYPES.includes(ev.type)) {
        const hour = new Date(ev.timestamp).getHours();
        if (!hourCounts[hour]) {
          hourCounts[hour] = {};
          ALL_TYPES.forEach(t => hourCounts[hour][t] = 0);
        }
        hourCounts[hour][ev.type]++;
      }
    }

    let rangeStart = startHour, rangeEnd = endHour;
    Object.keys(hourCounts).forEach(hStr => {
      const h = parseInt(hStr, 10);
      if (h < rangeStart) rangeStart = h;
      if (h > rangeEnd) rangeEnd = h;
    });

    const hourly = [];
    for (let h = rangeStart; h <= rangeEnd; h++) {
      const entry = { label: `${h}:00`, hour: h };
      ALL_TYPES.forEach(t => entry[t] = (hourCounts[h] && hourCounts[h][t]) || 0);
      hourly.push(entry);
    }

    const payee = getPayeeBucketSeries(
      ticketLog, ticketPayeeIssues, new Set([targetDate]),
      (entry) => new Date(entry.timestamp).getHours() - rangeStart,
      hourly.map(h => h.label)
    );
    return { range: 'today', date: targetDate, data: hourly, payee };
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
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const daily = keys.map(k => {
      const d = new Date(k + 'T00:00:00');
      const entry = { label: `${dayNames[d.getDay()]} ${d.getMonth()+1}/${d.getDate()}`, date: k };
      ALL_TYPES.forEach(t => entry[t] = dt[k]?.[t] ?? 0);
      return entry;
    });
    const payee = getPayeeBucketSeries(
      ticketLog, ticketPayeeIssues, new Set(keys),
      (entry) => keys.indexOf(entry.date),
      daily.map(d => d.label)
    );
    return { range: 'week', data: daily, payee };
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
    const validMonthDates = new Set();
    for (let start = 1; start <= daysInMonth; start += 3) {
      const end = Math.min(start + 2, daysInMonth);
      const label = start === end ? `${m}/${start}` : `${m}/${start}-${end}`;
      const entry = { label };
      ALL_TYPES.forEach(t => entry[t] = 0);
      for (let d = start; d <= end; d++) {
        const k = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        validMonthDates.add(k);
        if (dt[k]) {
          ALL_TYPES.forEach(t => entry[t] += dt[k][t] ?? 0);
        }
      }
      grouped.push(entry);
    }
    const payee = getPayeeBucketSeries(
      ticketLog, ticketPayeeIssues, validMonthDates,
      (entry) => Math.floor((parseInt(entry.date.split('-')[2], 10) - 1) / 3),
      grouped.map(g => g.label)
    );
    return { range: 'month', data: grouped, payee };
  }

  return { error: 'Invalid range' };
}

// ── Export ────────────────────────────────────

// Determine shift info for a given date. Priority: the saved weekly
// template (recurring per day-of-week — the right source for a multi-day
// CSV export spanning several different shifts), then the single manual
// shiftConfig, then a hardcoded day-of-week fallback.
const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function getShiftInfo(dateStr, shiftConfig, weeklyShiftConfig) {
  if (weeklyShiftConfig) {
    const dow = DOW_NAMES[new Date(dateStr + 'T00:00:00').getDay()];
    const wd = weeklyShiftConfig[dow];
    if (wd && wd.type) {
      return {
        shift: wd.type,
        startTime: wd.start ? convertTo12Hour(wd.start) : '8:00 AM',
        endTime: wd.end ? convertTo12Hour(wd.end) : '5:00 PM'
      };
    }
  }

  // If we have saved shift config, use it
  if (shiftConfig && shiftConfig.shiftType) {
    const startTime = shiftConfig.shiftStart ? convertTo12Hour(shiftConfig.shiftStart) : '8:00 AM';
    const endTime = shiftConfig.shiftEnd ? convertTo12Hour(shiftConfig.shiftEnd) : '5:00 PM';
    return {
      shift: shiftConfig.shiftType,
      startTime,
      endTime
    };
  }
  
  // Fallback: derive from day of week
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

// Same priority order as getShiftInfo (weekly template -> manual shiftConfig
// -> day-of-week fallback), but returns raw 0-23 hour numbers instead of
// formatted 12-hour strings — what the "today" detailed-chart hourly
// breakdown actually needs to know which hours to show on its x-axis.
// An overnight shift (end <= start, e.g. 18:00 -> 02:00) is capped at hour
// 23: the events for the day AFTER midnight belong to THAT day's own
// "today" bucket, not this one, so there's nothing past hour 23 to show here.
function getShiftHourRange(dateStr, shiftConfig, weeklyShiftConfig) {
  const parseHour = (hhmm, fallback) => {
    if (!hhmm) return fallback;
    const h = parseInt(hhmm.split(':')[0], 10);
    return Number.isFinite(h) ? h : fallback;
  };

  if (weeklyShiftConfig) {
    const dow = DOW_NAMES[new Date(dateStr + 'T00:00:00').getDay()];
    const wd = weeklyShiftConfig[dow];
    if (wd && wd.type) {
      const startHour = parseHour(wd.start, 8);
      const endHour = parseHour(wd.end, 17);
      return { startHour, endHour: endHour > startHour ? endHour : 23 };
    }
  }

  if (shiftConfig && shiftConfig.shiftType) {
    const startHour = parseHour(shiftConfig.shiftStart, 8);
    const endHour = parseHour(shiftConfig.shiftEnd, 17);
    return { startHour, endHour: endHour > startHour ? endHour : 23 };
  }

  const day = new Date(dateStr + 'T00:00:00').getDay();
  if (day === 0) return { startHour: 8, endHour: 12 };  // Sunday
  if (day === 6) return { startHour: 18, endHour: 23 }; // Saturday (overnight, capped)
  return { startHour: 18, endHour: 22 };                // Mon-Fri
}

// Convert 24-hour time (HH:MM) to 12-hour format (HH:MM AM/PM)
function convertTo12Hour(timeStr) {
  if (!timeStr) return '';
  const [hours, minutes] = timeStr.split(':');
  const h = parseInt(hours, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${minutes} ${ampm}`;
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

async function exportData(format, rangeType, rangeParams) {
  const data = await getAll();
  if (format === 'json') {
    return JSON.stringify(data, null, 2);
  }

  // ── Determine the set of valid date keys for this range ───────────────────
  const dt = data.dailyTotals;
  let validDates = null; // null = all dates (fallback)

  if (rangeType === 'today') {
    // Custom date picked, or default to actual today
    const targetDate = (rangeParams && rangeParams.date) ? rangeParams.date : todayKey();
    validDates = new Set([targetDate]);
  } else if (rangeType === 'week') {
    if (rangeParams && rangeParams.weekStart) {
      // Specific week: weekStart + 6 days
      const keys = getLastNDaysKeys(7, (() => {
        const d = new Date(rangeParams.weekStart);
        d.setDate(d.getDate() + 6);
        return d;
      })());
      validDates = new Set(keys);
    } else {
      // Rolling last-7-days
      validDates = new Set(getLastNDaysKeys(7));
    }
  } else if (rangeType === 'month') {
    if (rangeParams && rangeParams.month) {
      // Specific month: all days of that YYYY-MM
      const [y, m] = rangeParams.month.split('-').map(Number);
      const daysInMonth = new Date(y, m, 0).getDate();
      const days = [];
      for (let d = 1; d <= daysInMonth; d++) {
        days.push(`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
      }
      validDates = new Set(days);
    } else {
      // Current calendar month
      const keys = getCurrentMonthKeys(dt);
      validDates = new Set(keys);
    }
  }
  // If rangeType is undefined/null, validDates stays null → export everything

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
  let sortedLog = [...data.ticketLog].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.timestamp - b.timestamp;
  });

  // ── Step 1: Range filter ──────────────────────────────────────────────────
  if (validDates !== null) {
    sortedLog = sortedLog.filter(entry => validDates.has(entry.date));
  }

  // ── Step 2: Dedup — per (ticketNumber, date), keep only latest entry ──────
  // Build a map keyed by "ticketNumber:date" → keep the entry with the
  // highest timestamp (= most recent status).
  const dedupMap = new Map();
  for (const entry of sortedLog) {
    const key = `${entry.ticketNumber}:${entry.date}`;
    // sortedLog is already sorted ascending by timestamp, so later entries
    // naturally overwrite earlier ones — last write wins.
    dedupMap.set(key, entry);
  }

  // Re-sort deduplicated entries by date then timestamp
  const dedupedLog = Array.from(dedupMap.values()).sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.timestamp - b.timestamp;
  });

  // ── Step 3: Group dedupedLog by date ─────────────────────────────────────
  // For each date, bucket tickets per column index so we can emit them
  // in a compact, gap-free layout.
  const TICKET_COL_INDICES = [
    headers.indexOf('New Handled Tickets - Moved to Open or Pending'), // col 5
    headers.indexOf('Updates to Existing'),                             // col 6
    headers.indexOf('New/Pending/Open Tickets- Moved to Compliance'),  // col 7
    headers.indexOf('New/Pending/Open Tickets - Moved to Escalations'),// col 8
    headers.indexOf('Closed Tickets if any')                           // col 10
  ];

  // Gather unique dates in sorted order
  const dateGroups = [];
  const dateGroupMap = new Map();
  for (const entry of dedupedLog) {
    if (!dateGroupMap.has(entry.date)) {
      // columns: index → array of ticket strings for that column
      const colBuckets = {};
      TICKET_COL_INDICES.forEach(i => { colBuckets[i] = []; });
      dateGroupMap.set(entry.date, colBuckets);
      dateGroups.push(entry.date);
    }
    const colName = TYPE_TO_COLUMN[entry.type];
    const colIdx = headers.indexOf(colName);
    if (colIdx !== -1 && dateGroupMap.get(entry.date)[colIdx] !== undefined) {
      dateGroupMap.get(entry.date)[colIdx].push(`#${entry.ticketNumber}`);
    }
  }

  // Emit rows: one row per "slot" within each date group
  for (const date of dateGroups) {
    const colBuckets = dateGroupMap.get(date);
    const shiftInfo = getShiftInfo(date, data.shiftConfig, data.weeklyShiftConfig);
    const [y, m, d] = date.split('-');
    const fmtDate = `${parseInt(m)}/${parseInt(d)}/${y}`;

    // Max tickets across all columns for this date
    const maxSlots = Math.max(...TICKET_COL_INDICES.map(i => colBuckets[i].length), 1);

    for (let slot = 0; slot < maxSlots; slot++) {
      // Metadata (Date, Agent, Shift, Times) only on first row of this date group
      const meta = slot === 0
        ? [fmtDate, agentName, shiftInfo.shift, shiftInfo.startTime, shiftInfo.endTime]
        : ['', '', '', '', ''];

      // Build ticket columns — blank if no ticket in this slot for that column
      const row = [...meta, '', '', '', '', '', ''];
      // col indices 5,6,7,8,9,10 → array positions after meta (offset 5)
      TICKET_COL_INDICES.forEach(colIdx => {
        const ticket = colBuckets[colIdx][slot] ?? '';
        row[colIdx] = ticket;
      });

      rows.push(row);
    }
  }

  // If no ticket log entries, fall back to daily totals summary
  if (dedupedLog.length === 0) {
    // Only show days within the valid range
    const sorted = Object.keys(data.dailyTotals)
      .filter(k => validDates === null || validDates.has(k))
      .sort();
    for (const k of sorted) {
      const dt = data.dailyTotals[k];
      const shiftInfo = getShiftInfo(k, data.shiftConfig, data.weeklyShiftConfig);
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

// ── Shift Config ───────────────────────────────
// Routed through saveAll (instead of popup.js writing straight to
// chrome.storage.local) so a shift-config change actually reaches
// CLOUD_RELEVANT_KEYS' push-to-Firestore path — the web dashboard has no
// chrome.storage access at all, so this is the only way it can ever see
// the shift type/start/end the extension has saved.
async function setShiftConfig(shiftConfig) {
  await saveAll({ shiftConfig });
  return { success: true };
}

async function setWeeklyShiftConfig(weeklyShiftConfig) {
  await saveAll({ weeklyShiftConfig });
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

// ── Slack Settings ─────────────────────────────

async function saveSlackSettings(slackToken, slackUserId) {
  await saveLocal({ slackToken, slackUserId });
  return { success: true };
}

// ── Send XLSX Report to Slack ──────────────────
// Every agent's report goes to the same boss over Slack, but as a private
// DM rather than a shared channel — conversations.open resolves the boss's
// Slack user ID into a 1:1 DM channel (reused if one already exists), so
// each agent's daily report stays visible only to them and the boss, the
// same way each agent's own Telegram note only goes to their own chat.
// Uses Slack's newer 3-step external upload flow (get an upload URL, PUT
// the raw bytes to it, then complete/share the upload) since files.upload
// is deprecated for apps created after Slack retired it in favor of this.
async function sendXlsxToSlack(base64Bytes, filename) {
  const data = await getAll();
  const token = data.slackToken;
  const userId = data.slackUserId;

  if (!token || !userId) {
    return { success: false, error: 'Slack credentials not set in Settings.' };
  }

  const jsonHeaders = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json; charset=utf-8'
  };

  try {
    // 1. Open (or reuse) the DM channel with the boss
    const openRes = await fetch('https://slack.com/api/conversations.open', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ users: userId })
    });
    const openJson = await openRes.json();
    if (!openJson.ok) {
      console.error('[Slack] conversations.open error:', openJson.error);
      return { success: false, error: `Slack Error: ${openJson.error}` };
    }
    const channelId = openJson.channel.id;

    // Decode the base64 the popup sent back into raw file bytes
    const binary = atob(base64Bytes);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    // 2. Ask Slack for a one-time upload URL
    const urlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ filename, length: String(bytes.length) })
    });
    const urlJson = await urlRes.json();
    if (!urlJson.ok) {
      console.error('[Slack] getUploadURLExternal error:', urlJson.error);
      return { success: false, error: `Slack Error: ${urlJson.error}` };
    }

    // 3. Upload the raw file bytes to that URL
    const uploadRes = await fetch(urlJson.upload_url, { method: 'POST', body: bytes });
    if (!uploadRes.ok) {
      console.error('[Slack] Upload PUT failed:', uploadRes.status);
      return { success: false, error: `Slack upload failed: ${uploadRes.status}` };
    }

    // 4. Finalize the upload and share it straight into the boss's DM
    const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        files: [{ id: urlJson.file_id, title: filename }],
        channel_id: channelId,
        initial_comment: `📊 Daily ticket report — ${filename}`
      })
    });
    const completeJson = await completeRes.json();
    if (!completeJson.ok) {
      console.error('[Slack] completeUploadExternal error:', completeJson.error);
      return { success: false, error: `Slack Error: ${completeJson.error}` };
    }

    return { success: true };
  } catch (err) {
    console.error('[Slack] Network Error:', err);
    return { success: false, error: 'Network Error' };
  }
}

// ── Auth Handlers ─────────────────────────────

// signOut() only clears the cached Google/Firebase token — it never touches
// dailyTotals/ticketLog/masterLogHistory/ticketPayeeIssues/agentName, so a
// second person signing in on the SAME device would otherwise have their
// pullFromCloud() merge the FIRST person's still-present local tickets into
// their own account, then push that contaminated result to their own
// Firestore document — permanently mixing one user's tickets into another's.
// Tracking which uid was last active on this device lets us detect an
// account switch and wipe local data first, so pullFromCloud starts from a
// clean slate and only ever restores the newly signed-in user's own cloud data.
const LAST_UID_KEY = 'lastSignedInUid';

async function handleSignIn() {
  try {
    const googleToken = await getGoogleAuthToken(true);
    const session = await exchangeForFirebaseIdToken(googleToken);

    const prior = await new Promise((resolve) => {
      chrome.storage.local.get([LAST_UID_KEY], (res) => resolve(res[LAST_UID_KEY] || null));
    });

    if (prior && prior !== session.uid) {
      console.log('[ZTK Auth] Different Google account signed in on this device — clearing local ticket data before pulling this account\'s cloud data');
      await saveLocal({
        events: [],
        dailyTotals: {},
        ticketLog: [],
        masterLogHistory: [],
        ticketPayeeIssues: {},
        agentName: '',
        tgToken: '',
        tgChatId: '',
        shiftConfig: null
      });
    }

    // Cache session + remember which account is now active on this device
    await new Promise((resolve) => {
      chrome.storage.local.set({ [AUTH_SESSION_KEY]: session, [LAST_UID_KEY]: session.uid }, resolve);
    });

    // Immediately pull from cloud after sign-in
    lastCloudSyncTime = 0;
    await pullFromCloud();

    return {
      success: true,
      user: {
        uid: session.uid,
        email: session.email,
        displayName: session.displayName,
        photoUrl: session.photoUrl
      }
    };
  } catch (e) {
    console.error('[ZTK Auth] Sign-in failed:', e.message);
    return { success: false, error: e.message };
  }
}

async function handleSignOut() {
  try {
    await signOut();
    return { success: true };
  } catch (e) {
    console.error('[ZTK Auth] Sign-out failed:', e.message);
    return { success: false, error: e.message };
  }
}

async function handleGetAuthState() {
  const session = await getFirebaseSession(false);
  if (session) {
    return {
      isSignedIn: true,
      user: {
        uid: session.uid,
        email: session.email,
        displayName: session.displayName,
        photoUrl: session.photoUrl
      }
    };
  }
  return { isSignedIn: false, user: null };
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
        case 'RECORD_PAYEE_ISSUE':
          sendResponse(await recordPayeeIssue(msg.ticketId, msg.issueVal));
          break;
        case 'RECORD_TICKET_HANDLED':
          sendResponse(await recordTicketHandled(msg.ticketId, msg.category, msg.issueVal));
          break;
        case 'GET_STATS':
          sendResponse(await getStats());
          break;
        case 'GET_STATS_FOR_RANGE':
          sendResponse(await getStatsForRange(msg.rangeType, msg.params));
          break;
        case 'EXPORT':
          sendResponse({ data: await exportData(msg.format, msg.rangeType, msg.rangeParams) });
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
        case 'SET_SHIFT_CONFIG':
          sendResponse(await setShiftConfig(msg.shiftConfig));
          break;
        case 'SET_WEEKLY_SHIFT_CONFIG':
          sendResponse(await setWeeklyShiftConfig(msg.weeklyShiftConfig));
          break;
        case 'SET_TELEGRAM':
          sendResponse(await saveTelegramSettings(msg.tgToken, msg.tgChatId));
          break;
        case 'SEND_TELEGRAM_NOTE':
          sendResponse(await sendTelegramNote(msg.text));
          break;
        case 'SET_SLACK':
          sendResponse(await saveSlackSettings(msg.slackToken, msg.slackUserId));
          break;
        case 'SEND_XLSX_TO_SLACK':
          sendResponse(await sendXlsxToSlack(msg.base64Bytes, msg.filename));
          break;
        case 'FORCE_SYNC':
          lastCloudSyncTime = 0;
          await pullFromCloud();
          sendResponse({ success: true });
          break;
        case 'GET_DETAILED_STATS':
          sendResponse(await getDetailedStats(msg.range, msg.dateParam));
          break;
        case 'GET_WEEKLY_LEADERBOARD':
          {
            // Always the last *completed* week, never the in-progress
            // current one — otherwise whoever happened to sync the most
            // tickets in the first day or two of a brand-new week looks
            // like the runaway leader with a week's worth of totals still
            // to come. A finished week's total is stable for the entire
            // following week, then rolls over once that week itself ends.
            const weekKey = msg.weekKey || getLastWeekKey();
            const session = await getFirebaseSession(false);
            if (!session) {
              sendResponse({ entries: [], weekKey });
              break;
            }
            const entries = await readWeeklyLeaderboard(session.idToken, weekKey);
            sendResponse({ entries, weekKey });
          }
          break;
        case 'GET_MONTHLY_LEADERBOARD':
          {
            // Same "always the last completed period" rule as the weekly
            // board, one calendar-month granularity up.
            const monthKey = msg.monthKey || getLastMonthKey();
            const session = await getFirebaseSession(false);
            if (!session) {
              sendResponse({ entries: [], monthKey });
              break;
            }
            const entries = await readMonthlyLeaderboard(session.idToken, monthKey);
            sendResponse({ entries, monthKey });
          }
          break;
        case 'WIPE_DATA':
          await saveLocal({
            events: [],
            dailyTotals: {},
            ticketLog: [],
            masterLogHistory: [],
            ticketPayeeIssues: {}
          });
          sendResponse({ success: true });
          break;
        // ── Auth actions ──
        case 'SIGN_IN':
          sendResponse(await handleSignIn());
          break;
        case 'SIGN_OUT':
          sendResponse(await handleSignOut());
          break;
        case 'GET_AUTH_STATE':
          sendResponse(await handleGetAuthState());
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

// ── Startup: restore session + pull latest data ──

chrome.runtime.onStartup.addListener(async () => {
  console.log('[ZTK Cloud] Browser started — checking auth and pulling cloud data…');
  const session = await getFirebaseSession(false); // silent, non-interactive
  if (session) {
    await pullFromCloud();
  } else {
    console.log('[ZTK Cloud] No auth session on startup — user must sign in via popup');
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    console.log(`[ZTK Cloud] Extension ${details.reason} — checking auth and syncing…`);
    const session = await getFirebaseSession(false);
    if (session) {
      await pullFromCloud();
    }
    console.log('[ZTK Cloud] Startup sync complete.');
  }
});
