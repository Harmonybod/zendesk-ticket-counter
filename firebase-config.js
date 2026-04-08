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

/**
 * Convert a JS object of dailyTotals into Firestore REST document format.
 * Input:  { "2026-03-13": { open: 5, new: 3, team: 2 } }
 * Output: Firestore-compatible fields object
 */
function toFirestoreDoc(dailyTotals, settings = {}) {
  return {
    fields: {
      dailyTotalsJson: { stringValue: JSON.stringify(dailyTotals) },
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
    return { dailyTotals: {}, agentName: '', theme: 'dark', countingEnabled: true, lastUpdated: 0 };
  }

  const f = doc.fields;
  let dailyTotals = {};
  try {
    dailyTotals = JSON.parse(f.dailyTotalsJson?.stringValue || '{}');
  } catch (e) {
    console.warn('[ZTK Firebase] Failed to parse dailyTotals from Firestore:', e.message);
  }

  return {
    dailyTotals,
    agentName: f.agentName?.stringValue || '',
    theme: f.theme?.stringValue || 'dark',
    countingEnabled: f.countingEnabled?.booleanValue !== false,
    lastUpdated: parseInt(f.lastUpdated?.integerValue || '0', 10)
  };
}

/**
 * Write a document to Firestore (create or overwrite).
 * @param {string} syncId - The sync identifier (used as document ID)
 * @param {object} dailyTotals - The daily totals data
 * @param {object} settings - Agent name, theme, counting toggle
 */
async function firestoreWrite(syncId, dailyTotals, settings) {
  const url = `${FIRESTORE_BASE}/sync/${encodeURIComponent(syncId)}?key=${FIREBASE_CONFIG.apiKey}`;
  const body = toFirestoreDoc(dailyTotals, settings);

  const response = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Firestore write failed (${response.status}): ${errorText}`);
  }

  return true;
}

/**
 * Read a document from Firestore.
 * @param {string} syncId - The sync identifier (used as document ID)
 * @returns {object|null} Parsed data or null if not found
 */
async function firestoreRead(syncId) {
  const url = `${FIRESTORE_BASE}/sync/${encodeURIComponent(syncId)}?key=${FIREBASE_CONFIG.apiKey}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' }
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
