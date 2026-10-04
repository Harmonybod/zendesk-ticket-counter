// ─────────────────────────────────────────────
// Zendesk Ticket Tracker — Firebase Configuration
// Replace the placeholder values below with your own Firebase project config.
// See the setup guide (extension-guide.html) for instructions.
// ─────────────────────────────────────────────

const FIREBASE_CONFIG = {
  // ⚠️ FILL THESE IN from your Firebase Console → Project Settings → General → Your apps → Web app
  apiKey: 'AIzaSyCO-s0Lxohqo2tG1XzUCHh40M_h0BtVXi0',
  projectId: 'zendesk-tracker'
};

// ── Firestore REST API Helpers ────────────────

const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents`;
// Same path, without the transport (https://.../v1/) prefix — this is the
// "resource name" format Firestore's :batchGet body needs for each document
// it's asked for (a plain URL there is silently rejected as not found).
const FIRESTORE_RESOURCE_BASE = `projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents`;

// ── Auth Constants ────────────────────────────

const AUTH_SESSION_KEY = 'authSession';
const TOKEN_REFRESH_BUFFER = 5 * 60 * 1000; // refresh 5 min before expiry

// ── Google OAuth → Firebase Auth ──────────────

/**
 * Get a Google OAuth access token via chrome.identity.
 * @param {boolean} interactive - If true, shows the Google sign-in popup.
 * @returns {string} Google OAuth access token
 */
async function getGoogleAuthToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!token) {
        reject(new Error('No auth token returned'));
        return;
      }
      resolve(token);
    });
  });
}

/**
 * Exchange a Google OAuth access token for a Firebase ID token + user info.
 * Uses the Identity Toolkit REST API (signInWithIdp).
 * @param {string} googleAccessToken
 * @returns {{ idToken: string, uid: string, email: string, displayName: string, photoUrl: string, expiresAt: number }}
 */
async function exchangeForFirebaseIdToken(googleAccessToken) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${FIREBASE_CONFIG.apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      postBody: `access_token=${googleAccessToken}&providerId=google.com`,
      requestUri: 'http://localhost',
      returnSecureToken: true,
      returnIdpCredential: true
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Firebase token exchange failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  // Firebase ID tokens are valid for 1 hour
  const expiresAt = Date.now() + (parseInt(data.expiresIn || '3600', 10) * 1000);

  return {
    idToken: data.idToken,
    uid: data.localId,
    email: data.email || '',
    displayName: data.displayName || data.email || '',
    photoUrl: data.photoUrl || '',
    expiresAt
  };
}

/**
 * Get or restore a valid Firebase session.
 * Returns cached session if still valid; otherwise refreshes silently.
 * @param {boolean} interactive - If true, will prompt user to sign in if no session exists.
 * @returns {{ idToken: string, uid: string, email: string, displayName: string, photoUrl: string, expiresAt: number } | null}
 */
async function getFirebaseSession(interactive = false) {
  // 1. Try to restore from chrome.storage.local
  const stored = await new Promise((resolve) => {
    chrome.storage.local.get([AUTH_SESSION_KEY], (result) => {
      resolve(result[AUTH_SESSION_KEY] || null);
    });
  });

  // 2. If we have a valid (non-expired) cached session, return it
  if (stored && stored.idToken && stored.expiresAt > (Date.now() + TOKEN_REFRESH_BUFFER)) {
    return stored;
  }

  // 3. Try to refresh silently (or interactively if requested)
  try {
    const googleToken = await getGoogleAuthToken(interactive);
    const session = await exchangeForFirebaseIdToken(googleToken);

    // Cache the session
    await new Promise((resolve) => {
      chrome.storage.local.set({ [AUTH_SESSION_KEY]: session }, resolve);
    });

    return session;
  } catch (e) {
    console.log('[ZTK Auth] Could not obtain Firebase session:', e.message);
    return null;
  }
}

/**
 * Sign out: revoke the cached Google token and clear the stored session.
 */
async function signOut() {
  // 1. Remove the cached Google OAuth token
  try {
    const token = await new Promise((resolve) => {
      chrome.identity.getAuthToken({ interactive: false }, (t) => {
        if (chrome.runtime.lastError || !t) resolve(null);
        else resolve(t);
      });
    });
    if (token) {
      await new Promise((resolve) => {
        chrome.identity.removeCachedAuthToken({ token }, resolve);
      });
      // Also revoke on Google's end
      try { await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`); } catch (_) {}
    }
  } catch (e) {
    console.warn('[ZTK Auth] Error clearing Google token:', e.message);
  }

  // 2. Clear the stored Firebase session
  await new Promise((resolve) => {
    chrome.storage.local.remove([AUTH_SESSION_KEY], resolve);
  });

  console.log('[ZTK Auth] Signed out');
}

/**
 * Get the current user's profile from the cached session.
 * @returns {{ uid: string, email: string, displayName: string, photoUrl: string } | null}
 */
async function getUserProfile() {
  const stored = await new Promise((resolve) => {
    chrome.storage.local.get([AUTH_SESSION_KEY], (result) => {
      resolve(result[AUTH_SESSION_KEY] || null);
    });
  });

  if (!stored || !stored.uid) return null;

  return {
    uid: stored.uid,
    email: stored.email,
    displayName: stored.displayName,
    photoUrl: stored.photoUrl
  };
}

// ── Firestore Document Helpers ────────────────

// ── Keeping the tracker document under Firestore's 1 MiB cap ─────────────
// A single Firestore document maxes out at 1,048,576 bytes. ticketLog used
// to be embedded in this same document and is append-only/unbounded — that
// is exactly what silently broke every cloud write once real usage crossed
// the cap (the popup kept counting fine locally; only the cloud copy, and
// so the web dashboard, ever stopped receiving new tickets). ticketLog now
// lives in its own per-day subcollection instead (see "Full ticketLog
// history via a per-day subcollection" below), which has no realistic size
// ceiling — a single day's worth of tickets is nowhere near 1MB on its own,
// and a subcollection can hold any number of such small documents.
//
// masterLogHistory (a smaller, largely-legacy duplicate of ticketLog kept
// for backward compatibility — see popup.js's renderPremiumAnalytics) is
// still windowed here as a defensive fallback: dailyTotals (the durable,
// tiny, all-time source of totals) is never trimmed, only the detail array.
const FIRESTORE_DOC_SAFE_BYTES = 900000; // hard cap is 1,048,576 — stay well clear of it
const CLOUD_HISTORY_WINDOW_CANDIDATES_DAYS = [90, 60, 30, 14, 7];

function utf8ByteLength(str) {
  return new TextEncoder().encode(str).length;
}

// Self-contained "YYYY-MM-DD" formatter (matches ticketLog entries' own
// `date` field and background.js's identical dateKey()) — kept local to
// this file rather than relying on background.js's global, since this file
// is only ever loaded via background.js's importScripts() today but
// shouldn't silently depend on that happening to also define this name.
function localDateKeyForCloud(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Keeps only masterLogHistory entries from the last `days` days.
function windowMasterLogForCloud(settings, days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const trimmedMasterLogHistory = (settings.masterLogHistory || []).filter(e => {
    const t = Date.parse(e.timestamp);
    return Number.isFinite(t) ? t >= cutoff : true; // keep anything unparsable rather than risk losing it silently
  });
  return { ...settings, masterLogHistory: trimmedMasterLogHistory };
}

// Shrinks masterLogHistory's window step by step until the resulting main
// document fits comfortably under Firestore's cap. dailyTotals and
// ticketPayeeIssues are never trimmed — they stay small on their own even
// after years (one compact object per day; one short string per ticket).
function fitSettingsForCloud(dailyTotals, settings) {
  let candidate = settings;
  for (const days of CLOUD_HISTORY_WINDOW_CANDIDATES_DAYS) {
    const windowed = windowMasterLogForCloud(settings, days);
    const bytes = utf8ByteLength(JSON.stringify(toFirestoreDoc(dailyTotals, windowed)));
    candidate = windowed;
    if (bytes <= FIRESTORE_DOC_SAFE_BYTES) {
      if (days < CLOUD_HISTORY_WINDOW_CANDIDATES_DAYS[0]) {
        console.warn(`[ZTK Cloud] Trimmed cloud masterLogHistory to the last ${days} days (~${bytes} bytes) to stay under Firestore's 1MB document limit. Full history is unaffected locally.`);
      }
      return windowed;
    }
  }
  console.warn('[ZTK Cloud] Even the smallest masterLogHistory window exceeds Firestore\'s size limit — syncing it anyway.');
  return candidate;
}

/**
 * Convert a JS object of dailyTotals into Firestore REST document format.
 * ticketLog is NOT part of this document — see the ticketLogDays
 * subcollection helpers below. Input dailyTotals example:
 * { "2026-03-13": { open: 5, new: 3, team: 2 } }
 */
function toFirestoreDoc(dailyTotals, settings = {}) {
  return {
    fields: {
      dailyTotalsJson: { stringValue: JSON.stringify(dailyTotals) },
      masterLogHistoryJson: { stringValue: JSON.stringify(settings.masterLogHistory || []) },
      ticketPayeeIssuesJson: { stringValue: JSON.stringify(settings.ticketPayeeIssues || {}) },
      shiftConfigJson: { stringValue: JSON.stringify(settings.shiftConfig || null) },
      weeklyShiftConfigJson: { stringValue: JSON.stringify(settings.weeklyShiftConfig || null) },
      agentName: { stringValue: settings.agentName || '' },
      theme: { stringValue: settings.theme || 'dark' },
      countingEnabled: { booleanValue: settings.countingEnabled !== false },
      lastUpdated: { integerValue: String(Date.now()) }
    }
  };
}

// ── Full ticketLog history via a per-day subcollection ────────────────────
// Each calendar day's ticketLog entries live in their own small document at
// /users/{uid}/ticketLogDays/{date} (date is a "YYYY-MM-DD" key, matching
// each entry's own `date` field). A subcollection can hold any number of
// these without ever approaching the 1MB single-document cap, which is
// what makes it safe to keep FULL history in the cloud indefinitely instead
// of windowing it like the main document's other fields.
//
// Reads are still bounded on purpose: LISTING the whole subcollection would
// itself grow unbounded over months/years of daily documents, and every
// document in that list counts against Firestore's daily READ quota — so
// routine reconciliation only ever reads/rewrites the last
// CLOUD_TICKETLOG_WINDOW_DAYS days via a single :batchGet call (a fixed,
// small cost no matter how long this account has existed). The one
// deliberate exception is the FIRST-ever sync for a brand new remote
// document, which backfills a user's complete local history once (see
// pullFromCloud's "no remote data yet" branch) — a one-time cost, after
// which everything older than the window is already correctly in Firestore
// and — being an append-only log of already-finished days — never needs
// touching again.
const CLOUD_TICKETLOG_WINDOW_DAYS = 90;

function recentDateKeys(days) {
  const keys = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    keys.push(localDateKeyForCloud(d));
  }
  return keys;
}

function groupTicketLogByDay(ticketLog) {
  const byDay = new Map();
  (ticketLog || []).forEach(entry => {
    if (!entry || !entry.date) return;
    if (!byDay.has(entry.date)) byDay.set(entry.date, []);
    byDay.get(entry.date).push(entry);
  });
  return byDay;
}

// Merges `localEntriesForDay` into whatever's already remote for that one
// day, then writes the merged result back — never done as a blind
// overwrite, so this can't regress another device's entries for the same
// day. Skips the write entirely if nothing actually changed. Used by the
// regular per-action sync path, which in practice only ever touches
// "today" — so a normal ticket click costs one small targeted read +
// (usually) one small write, not a scan of the whole history.
async function syncTicketLogDay(uid, idToken, date, localEntriesForDay) {
  const url = `${FIRESTORE_BASE}/users/${encodeURIComponent(uid)}/ticketLogDays/${encodeURIComponent(date)}`;
  const headers = { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) };

  let remoteEntries = [];
  const getResp = await fetch(url, { method: 'GET', headers });
  if (getResp.ok) {
    const doc = await getResp.json();
    try { remoteEntries = JSON.parse(doc.fields?.entriesJson?.stringValue || '[]'); } catch (e) { /* treat as empty */ }
  } else if (getResp.status !== 404) {
    const errorText = await getResp.text();
    throw new Error(`ticketLogDays read failed for ${date} (${getResp.status}): ${errorText}`);
  }

  const merged = mergeTicketLogs(localEntriesForDay, remoteEntries);
  if (merged.length === remoteEntries.length) return merged; // nothing new for this day

  const body = { fields: { date: { stringValue: date }, entriesJson: { stringValue: JSON.stringify(merged) } } };
  const putResp = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(body) });
  if (!putResp.ok) {
    const errorText = await putResp.text();
    throw new Error(`ticketLogDays write failed for ${date} (${putResp.status}): ${errorText}`);
  }
  return merged;
}

// Reads the last `days` days' worth of ticketLogDays documents via a
// single :batchGet call (exact document paths, computed locally — not a
// collection listing) — a fixed, bounded number of reads no matter how
// much total history exists. Returns their union as one flat ticketLog
// array, the same shape every existing caller already expects.
async function firestoreReadRecentTicketLogDays(uid, idToken, days = CLOUD_TICKETLOG_WINDOW_DAYS) {
  const documents = recentDateKeys(days).map(
    d => `${FIRESTORE_RESOURCE_BASE}/users/${encodeURIComponent(uid)}/ticketLogDays/${encodeURIComponent(d)}`
  );
  const headers = { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) };

  const response = await fetch(`${FIRESTORE_BASE}:batchGet`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ documents })
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ticketLogDays batchGet failed (${response.status}): ${errorText}`);
  }

  const results = await response.json(); // array of { found?: {...} } | { missing?: "..." }
  const all = [];
  (results || []).forEach(r => {
    if (!r || !r.found) return;
    try {
      all.push(...JSON.parse(r.found.fields?.entriesJson?.stringValue || '[]'));
    } catch (e) {
      console.warn('[ZTK Firebase] Failed to parse a ticketLogDays document:', e.message);
    }
  });
  return all;
}

// Used after a full pull+merge (pullFromCloud): mergedTicketLog is already
// the union of every device's history, so for any given day IT COVERS, it's
// always a superset of (or equal to) what's remote — safe to write straight
// over, unlike a raw local-only array. Only days within `windowDays` of
// today are considered (matching whatever window remoteTicketLogFlat was
// actually read with) — anything older is left alone entirely, since we
// have no reliable remote-side information about it to safely diff against
// without re-reading it (which is exactly the unbounded cost this design
// avoids). Pass windowDays = Infinity for the one legitimate case where
// that's not true: the first-ever backfill of a brand new remote document,
// where remoteTicketLogFlat is `[]` for everything by definition.
async function pushChangedTicketLogDays(uid, idToken, mergedTicketLog, remoteTicketLogFlat, windowDays = CLOUD_TICKETLOG_WINDOW_DAYS) {
  const cutoffKey = Number.isFinite(windowDays)
    ? localDateKeyForCloud(new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000))
    : null;
  const mergedByDay = groupTicketLogByDay(mergedTicketLog);
  const remoteByDay = groupTicketLogByDay(remoteTicketLogFlat);
  const headers = { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) };

  for (const [day, entries] of mergedByDay) {
    if (cutoffKey && day < cutoffKey) continue; // outside the window we actually read remote for — leave it alone
    const remoteEntries = remoteByDay.get(day) || [];
    if (entries.length === remoteEntries.length) continue; // unchanged for this day
    const url = `${FIRESTORE_BASE}/users/${encodeURIComponent(uid)}/ticketLogDays/${encodeURIComponent(day)}`;
    const body = { fields: { date: { stringValue: day }, entriesJson: { stringValue: JSON.stringify(entries) } } };
    const response = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(body) });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ticketLogDays write failed for ${day} (${response.status}): ${errorText}`);
    }
  }
}

/**
 * Convert a Firestore REST document back into a JS object.
 */
function fromFirestoreDoc(doc) {
  if (!doc || !doc.fields) {
    return { dailyTotals: {}, ticketLog: [], masterLogHistory: [], ticketPayeeIssues: {}, shiftConfig: null, weeklyShiftConfig: null, agentName: '', theme: 'dark', countingEnabled: true, lastUpdated: 0 };
  }

  const f = doc.fields;
  let dailyTotals = {};
  let ticketLog = [];
  let masterLogHistory = [];
  let ticketPayeeIssues = {};
  let shiftConfig = null;
  let weeklyShiftConfig = null;

  try {
    dailyTotals = JSON.parse(f.dailyTotalsJson?.stringValue || '{}');
  } catch (e) {
    console.warn('[ZTK Firebase] Failed to parse dailyTotals from Firestore:', e.message);
  }

  try {
    ticketLog = JSON.parse(f.ticketLogJson?.stringValue || '[]');
  } catch (e) {
    console.warn('[ZTK Firebase] Failed to parse ticketLog from Firestore:', e.message);
  }

  try {
    masterLogHistory = JSON.parse(f.masterLogHistoryJson?.stringValue || '[]');
  } catch (e) {
    console.warn('[ZTK Firebase] Failed to parse masterLogHistory from Firestore:', e.message);
  }

  try {
    ticketPayeeIssues = JSON.parse(f.ticketPayeeIssuesJson?.stringValue || '{}');
  } catch (e) {
    console.warn('[ZTK Firebase] Failed to parse ticketPayeeIssues from Firestore:', e.message);
  }

  try {
    shiftConfig = JSON.parse(f.shiftConfigJson?.stringValue || 'null');
  } catch (e) {
    console.warn('[ZTK Firebase] Failed to parse shiftConfig from Firestore:', e.message);
  }

  try {
    weeklyShiftConfig = JSON.parse(f.weeklyShiftConfigJson?.stringValue || 'null');
  } catch (e) {
    console.warn('[ZTK Firebase] Failed to parse weeklyShiftConfig from Firestore:', e.message);
  }

  return {
    dailyTotals,
    ticketLog,
    masterLogHistory,
    ticketPayeeIssues,
    shiftConfig,
    weeklyShiftConfig,
    agentName: f.agentName?.stringValue || '',
    theme: f.theme?.stringValue || 'dark',
    countingEnabled: f.countingEnabled?.booleanValue !== false,
    lastUpdated: parseInt(f.lastUpdated?.integerValue || '0', 10)
  };
}

/**
 * Merge two ticketLog arrays.
 * Dedup key: ticketNumber + date + type (each unique action is preserved).
 * Entries from both sides are unioned; duplicates by composite key keep the
 * one with the later timestamp.
 * Result is sorted ascending by timestamp.
 */
function mergeTicketLogs(local, remote) {
  const map = new Map();

  const addEntries = (entries) => {
    for (const entry of entries) {
      // Composite key: same ticket + same day + same action type
      const key = `${entry.ticketNumber}:${entry.date}:${entry.type}:${entry.timestamp}`;
      if (!map.has(key) || entry.timestamp > map.get(key).timestamp) {
        map.set(key, entry);
      }
    }
  };

  addEntries(local || []);
  addEntries(remote || []);

  return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Merge two masterLogHistory arrays (entries: { ticketId, category, timestamp }).
 * Dedup key: ticketId + category + timestamp — same shape of union-merge as
 * mergeTicketLogs, so a ticket handled on two devices before either syncs
 * keeps both real entries instead of one clobbering the other.
 */
function mergeMasterLogHistory(local, remote) {
  const map = new Map();

  const addEntries = (entries) => {
    for (const entry of entries) {
      const key = `${entry.ticketId}:${entry.category}:${entry.timestamp}`;
      map.set(key, entry);
    }
  };

  addEntries(local || []);
  addEntries(remote || []);

  return Array.from(map.values()).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

/**
 * Merge two ticketPayeeIssues maps ({ ticketId: issueText }). There's no
 * per-key timestamp to arbitrate conflicts, so this is a plain key union —
 * conflicts are rare (a ticket's payee issue type doesn't normally change
 * once captured) and the local device's own just-captured value wins.
 */
function mergeTicketPayeeIssues(local, remote) {
  return { ...(remote || {}), ...(local || {}) };
}

// ── Firestore Read/Write (authenticated) ──────

/**
 * Write a document to Firestore using Firebase ID token auth.
 * Path: /users/{uid}/data/tracker (dailyTotals + settings) plus today's
 * bucket in /users/{uid}/ticketLogDays/{date} (the full ticketLog array —
 * only today's entries are pulled out of it and merge-synced; see
 * syncTicketLogDay above for why only "today" is touched here).
 * @param {string} uid - The user's Firebase UID
 * @param {object} dailyTotals - The daily totals data
 * @param {object} ticketLog - The full local ticketLog array
 * @param {object} settings - Agent name, theme, counting toggle, etc.
 * @param {string} idToken - Firebase ID token for auth
 */
async function firestoreWrite(uid, dailyTotals, ticketLog, settings, idToken) {
  const url = `${FIRESTORE_BASE}/users/${encodeURIComponent(uid)}/data/tracker`;
  // Window masterLogHistory to whatever recent history fits under
  // Firestore's 1MB document cap — see fitSettingsForCloud above.
  // dailyTotals (all-time totals) is passed through untouched either way.
  const fittedSettings = fitSettingsForCloud(dailyTotals, settings);
  const body = toFirestoreDoc(dailyTotals, fittedSettings);

  const headers = { 'Content-Type': 'application/json' };
  if (idToken) {
    headers['Authorization'] = `Bearer ${idToken}`;
  }

  const response = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Firestore write failed (${response.status}): ${errorText}`);
  }

  // Sync today's ticketLog entries into their own subcollection document —
  // see the "Full ticketLog history via a per-day subcollection" comment
  // above for why this isn't just embedded in the document above.
  const todayKey = localDateKeyForCloud(new Date());
  const todaysEntries = (ticketLog || []).filter(e => e.date === todayKey);
  if (todaysEntries.length) {
    await syncTicketLogDay(uid, idToken, todayKey, todaysEntries);
  }

  return true;
}

/**
 * Read a document from Firestore using Firebase ID token auth.
 * Path: /users/{uid}/data/tracker, plus the full ticketLogDays
 * subcollection (unioned into the returned object's `ticketLog`, along
 * with any old ticketLogJson still sitting on the main doc from before
 * this subcollection existed — a one-time, automatic migration path that
 * needs no manual step: the very next successful sync moves that legacy
 * data into the subcollection and it stops being written to the main doc).
 * @param {string} uid - The user's Firebase UID
 * @param {string} idToken - Firebase ID token for auth
 * @returns {object|null} Parsed data or null if not found
 */
async function firestoreRead(uid, idToken) {
  const url = `${FIRESTORE_BASE}/users/${encodeURIComponent(uid)}/data/tracker`;

  const headers = { 'Content-Type': 'application/json' };
  if (idToken) {
    headers['Authorization'] = `Bearer ${idToken}`;
  }

  const response = await fetch(url, {
    method: 'GET',
    headers
  });

  if (response.status === 404) {
    // Document doesn't exist yet
    return null;
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Firestore read failed (${response.status}): ${errorText}`);
  }

  const doc = await response.json();
  const parsed = fromFirestoreDoc(doc);

  // Union in the last CLOUD_TICKETLOG_WINDOW_DAYS days of the ticketLogDays
  // subcollection — bounded on purpose, see the comment above
  // firestoreReadRecentTicketLogDays. mergeTicketLogs() is a dedup-safe
  // union, so this is also what carries any legacy ticketLogJson still
  // sitting on the main doc (from before this subcollection existed, and
  // itself already capped to a similar recent window by fitSettingsForCloud
  // historically) into the subcollection on the next successful write — no
  // manual migration step needed.
  const subcollectionTicketLog = await firestoreReadRecentTicketLogDays(uid, idToken);
  parsed.ticketLog = mergeTicketLogs(parsed.ticketLog, subcollectionTicketLog);

  return parsed;
}

/**
 * Check if Firebase is configured (user has filled in credentials).
 */
function isFirebaseConfigured() {
  return (
    FIREBASE_CONFIG.apiKey !== 'YOUR_API_KEY_HERE' &&
    FIREBASE_CONFIG.projectId !== 'YOUR_PROJECT_ID_HERE' &&
    FIREBASE_CONFIG.apiKey.length > 0 &&
    FIREBASE_CONFIG.projectId.length > 0
  );
}


// ── Weekly Leaderboard Helpers ─────────────────────────────────────────────

/**
 * Get ISO week key (YYYY-WW) for Monday-based weeks.
 * @returns {string} Week key like "2026-34"
 */
function getCurrentWeekKey() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun
  const monday = new Date(now);
  // Find Monday of current week
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  monday.setHours(0, 0, 0, 0);
  
  const year = monday.getFullYear();
  const startOfYear = new Date(year, 0, 1);
  // ISO week number: days since start of year, adjusted for day of week
  const days = Math.floor((monday - startOfYear) / 86400000);
  const weekNum = Math.ceil((days + startOfYear.getDay() + 1) / 7);
  
  return `${year}-${String(weekNum).padStart(2, '0')}`;
}

/**
 * Get the week key for last week.
 * @returns {string} Week key like "2026-33"
 */
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

/**
 * Write user's weekly total to the shared leaderboard.
 * @param {string} uid - Firebase user ID
 * @param {string} idToken - Firebase ID token
 * @param {string} weekKey - Week key like "2026-34"
 * @param {string} email - User email
 * @param {string} displayName - User display name
 * @param {string} photoUrl - User profile photo URL
 * @param {number} weekTotal - Total tickets for the week
 */
async function writeWeeklyLeaderboardEntry(uid, idToken, weekKey, email, displayName, photoUrl, weekTotal, weekPeakSpeed) {
  const url = `${FIRESTORE_BASE}/weeklyLeaderboard/${weekKey}/users/${encodeURIComponent(uid)}`;

  const body = {
    fields: {
      email: { stringValue: email || '' },
      displayName: { stringValue: displayName || email || '' },
      photoUrl: { stringValue: photoUrl || '' },
      weekTotal: { integerValue: String(weekTotal) },
      weekPeakSpeed: { doubleValue: weekPeakSpeed || 0 },
      weekKey: { stringValue: weekKey },
      lastUpdated: { integerValue: String(Date.now()) }
    }
  };
  
  const headers = { 'Content-Type': 'application/json' };
  if (idToken) headers['Authorization'] = `Bearer ${idToken}`;
  
  const response = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body)
  });
  
  if (!response.ok) {
    throw new Error(`Leaderboard write failed (${response.status})`);
  }
  
  return true;
}

/**
 * Read all users' entries for a given week.
 * @param {string} idToken - Firebase ID token
 * @param {string} weekKey - Week key like "2026-34"
 * @returns {Array} Array of user entries sorted by weekTotal descending
 */
async function readWeeklyLeaderboard(idToken, weekKey) {
  const url = `${FIRESTORE_BASE}/weeklyLeaderboard/${weekKey}/users`;
  
  const headers = { 'Content-Type': 'application/json' };
  if (idToken) headers['Authorization'] = `Bearer ${idToken}`;
  
  const response = await fetch(url, {
    method: 'GET',
    headers
  });
  
  if (response.status === 404 || response.status === 400) return [];
  if (!response.ok) return [];
  
  const data = await response.json();
  if (!data.documents) return [];
  
  return data.documents.map(doc => {
    const f = doc.fields || {};
    return {
      uid: doc.name.split('/').pop(),
      email: f.email?.stringValue || '',
      displayName: f.displayName?.stringValue || '',
      photoUrl: f.photoUrl?.stringValue || '',
      weekTotal: parseInt(f.weekTotal?.integerValue || '0', 10),
      weekPeakSpeed: parseFloat(f.weekPeakSpeed?.doubleValue ?? f.weekPeakSpeed?.integerValue ?? 0),
      weekKey: f.weekKey?.stringValue || weekKey
    };
  });
}

// ── Monthly Leaderboard Helpers ─────────────────────────────────────────────
// Same shape/mechanics as the weekly leaderboard above, one calendar-month
// granularity up. Kept as separate functions/collection (monthlyLeaderboard)
// rather than parameterizing the weekly ones, since the key format and
// Firestore path differ enough that sharing code would need as much
// branching as just writing it twice — this stays simpler to read.

/**
 * Get the current calendar month's key.
 * @returns {string} Month key like "2026-09"
 */
function getCurrentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Get last calendar month's key (handles the January -> December/year
 * rollover correctly via Date's own month-overflow normalization).
 * @returns {string} Month key like "2026-08"
 */
function getLastMonthKey() {
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Write user's monthly total to the shared leaderboard.
 * @param {string} uid - Firebase user ID
 * @param {string} idToken - Firebase ID token
 * @param {string} monthKey - Month key like "2026-09"
 * @param {string} email - User email
 * @param {string} displayName - User display name
 * @param {string} photoUrl - User profile photo URL
 * @param {number} monthTotal - Total tickets for the month
 */
async function writeMonthlyLeaderboardEntry(uid, idToken, monthKey, email, displayName, photoUrl, monthTotal, monthPeakSpeed) {
  const url = `${FIRESTORE_BASE}/monthlyLeaderboard/${monthKey}/users/${encodeURIComponent(uid)}`;

  const body = {
    fields: {
      email: { stringValue: email || '' },
      displayName: { stringValue: displayName || email || '' },
      photoUrl: { stringValue: photoUrl || '' },
      monthTotal: { integerValue: String(monthTotal) },
      monthPeakSpeed: { doubleValue: monthPeakSpeed || 0 },
      monthKey: { stringValue: monthKey },
      lastUpdated: { integerValue: String(Date.now()) }
    }
  };

  const headers = { 'Content-Type': 'application/json' };
  if (idToken) headers['Authorization'] = `Bearer ${idToken}`;

  const response = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Monthly leaderboard write failed (${response.status})`);
  }

  return true;
}

/**
 * Read all users' entries for a given month.
 * @param {string} idToken - Firebase ID token
 * @param {string} monthKey - Month key like "2026-09"
 * @returns {Array} Array of user entries
 */
async function readMonthlyLeaderboard(idToken, monthKey) {
  const url = `${FIRESTORE_BASE}/monthlyLeaderboard/${monthKey}/users`;

  const headers = { 'Content-Type': 'application/json' };
  if (idToken) headers['Authorization'] = `Bearer ${idToken}`;

  const response = await fetch(url, {
    method: 'GET',
    headers
  });

  if (response.status === 404 || response.status === 400) return [];
  if (!response.ok) return [];

  const data = await response.json();
  if (!data.documents) return [];

  return data.documents.map(doc => {
    const f = doc.fields || {};
    return {
      uid: doc.name.split('/').pop(),
      email: f.email?.stringValue || '',
      displayName: f.displayName?.stringValue || '',
      photoUrl: f.photoUrl?.stringValue || '',
      monthTotal: parseInt(f.monthTotal?.integerValue || '0', 10),
      monthPeakSpeed: parseFloat(f.monthPeakSpeed?.doubleValue ?? f.monthPeakSpeed?.integerValue ?? 0),
      monthKey: f.monthKey?.stringValue || monthKey
    };
  });
}
