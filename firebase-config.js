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

/**
 * Convert a JS object of dailyTotals into Firestore REST document format.
 * Input:  { "2026-03-13": { open: 5, new: 3, team: 2 } }
 * Output: Firestore-compatible fields object
 */
function toFirestoreDoc(dailyTotals, ticketLog, settings = {}) {
  return {
    fields: {
      dailyTotalsJson: { stringValue: JSON.stringify(dailyTotals) },
      ticketLogJson:   { stringValue: JSON.stringify(ticketLog || []) },
      masterLogHistoryJson: { stringValue: JSON.stringify(settings.masterLogHistory || []) },
      ticketPayeeIssuesJson: { stringValue: JSON.stringify(settings.ticketPayeeIssues || {}) },
      agentName: { stringValue: settings.agentName || '' },
      theme: { stringValue: settings.theme || 'dark' },
      countingEnabled: { booleanValue: settings.countingEnabled !== false },
      lastUpdated: { integerValue: String(Date.now()) }
    }
  };
}

/**
 * Convert a Firestore REST document back into a JS object.
 */
function fromFirestoreDoc(doc) {
  if (!doc || !doc.fields) {
    return { dailyTotals: {}, ticketLog: [], masterLogHistory: [], ticketPayeeIssues: {}, agentName: '', theme: 'dark', countingEnabled: true, lastUpdated: 0 };
  }

  const f = doc.fields;
  let dailyTotals = {};
  let ticketLog = [];
  let masterLogHistory = [];
  let ticketPayeeIssues = {};

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

  return {
    dailyTotals,
    ticketLog,
    masterLogHistory,
    ticketPayeeIssues,
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

// ── Firestore Read/Write (authenticated) ──────

/**
 * Write a document to Firestore using Firebase ID token auth.
 * Path: /users/{uid}/data/tracker
 * @param {string} uid - The user's Firebase UID
 * @param {object} dailyTotals - The daily totals data
 * @param {object} ticketLog - The ticket log array
 * @param {object} settings - Agent name, theme, counting toggle
 * @param {string} idToken - Firebase ID token for auth
 */
async function firestoreWrite(uid, dailyTotals, ticketLog, settings, idToken) {
  const url = `${FIRESTORE_BASE}/users/${encodeURIComponent(uid)}/data/tracker`;
  const body = toFirestoreDoc(dailyTotals, ticketLog, settings);

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

  return true;
}

/**
 * Read a document from Firestore using Firebase ID token auth.
 * Path: /users/{uid}/data/tracker
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
  return fromFirestoreDoc(doc);
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
async function writeWeeklyLeaderboardEntry(uid, idToken, weekKey, email, displayName, photoUrl, weekTotal) {
  const url = `${FIRESTORE_BASE}/weeklyLeaderboard/${weekKey}/users/${encodeURIComponent(uid)}`;
  
  const body = {
    fields: {
      email: { stringValue: email || '' },
      displayName: { stringValue: displayName || email || '' },
      photoUrl: { stringValue: photoUrl || '' },
      weekTotal: { integerValue: String(weekTotal) },
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
      weekKey: f.weekKey?.stringValue || weekKey
    };
  });
}
