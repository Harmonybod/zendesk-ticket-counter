# Ticket Tracker Dashboard — Deployment Guide

A mobile-friendly, installable (PWA) web dashboard that reads the same
Firebase project the Chrome extension already syncs to. No build step —
it's plain HTML/CSS/JS, so deploying it is just "point Vercel at this folder."

## What you need to provide

Nothing secret. The only thing this app needs is already public:
- The Firebase project's `apiKey` and `projectId` — already hardcoded in
  `app.js` (same values the extension uses in `firebase-config.js`). A
  Firebase Web `apiKey` is a client identifier, not a password; real access
  control comes from Firestore's security rules, which is why step 1 below
  matters more than anything else here.
- A Vercel account (free tier is enough — you get a free `*.vercel.app`
  domain automatically, no custom domain purchase required).

## Step 1 — Deploy the Firestore security rules (do this first)

This project already has a `firestore.rules` file at the repo root, written
but never published. Without it, this dashboard (and the extension) are
either wide open to anyone, or Firestore's default rules block all reads —
either way, this has to happen before the dashboard can work correctly.

1. Go to https://console.firebase.google.com/ → project **zendesk-tracker**.
2. Firestore Database → **Rules** tab.
3. Paste in the contents of `firestore.rules` (from the repo root), replacing
   whatever is there now.
4. Click **Publish**.

## Step 2 — Confirm Google Sign-In is enabled

The extension already signs in with Google, so this is almost certainly
already on, but double-check:

1. Firebase Console → **Authentication** → **Sign-in method**.
2. Confirm **Google** is listed as "Enabled." If not, enable it (you don't
   need to fill in anything else — Firebase auto-provisions what it needs).

## Step 3 — Deploy to Vercel

1. Push this repo to GitHub (or GitLab/Bitbucket) if it isn't already.
2. Go to https://vercel.com → **Add New... → Project** → import the repo.
3. When configuring the project:
   - **Root Directory**: set this to `web` (this is the one setting that
     matters — it tells Vercel to serve this folder, not the extension code).
   - **Framework Preset**: "Other" (there's no framework/build step).
   - **Build Command**: leave empty.
   - **Output Directory**: leave as default (`.` / root of the folder above).
4. Click **Deploy**. You'll get a URL like `https://your-project.vercel.app`.

## Step 4 — Authorize the new domain in Firebase

1. Firebase Console → **Authentication** → **Settings** → **Authorized domains**.
2. Click **Add domain** and add your new `*.vercel.app` domain (and any
   custom domain you later attach in Vercel).

Without this step, Google Sign-In on the dashboard will fail with an
`auth/unauthorized-domain` error — this is the step people most often miss.

## Step 5 — Point the extension's Home button at it

In `popup.js`, find:
```js
const DASHBOARD_URL = 'https://zendesk-tracker-dashboard.vercel.app';
```
Replace it with your actual Vercel URL from Step 3, then reload the
extension (`chrome://extensions` → reload).

## Step 6 — Install it as an app (optional, for mobile)

- **Android (Chrome)**: open the URL, tap the menu (⋮) → "Add to Home screen" /
  "Install app." Chrome shows an install prompt automatically once the PWA
  criteria (manifest + service worker, both already set up) are met.
- **iPhone (Safari)**: open the URL, tap Share → "Add to Home Screen." iOS
  doesn't support the automatic install prompt Android does, but the result
  is the same: a home-screen icon that opens full-screen, no browser chrome.

## How it stays in sync with the extension

Both the extension and this dashboard read/write the exact same Firestore
document (`/users/{uid}/data/tracker`), keyed by the signed-in Google
account's UID. Sign in with the same Google account here as in the
extension and you'll see the same tickets, payee issue types, and totals —
there's no separate account or data store to manage.

## If you'd rather I do the Vercel/GitHub steps myself

I can walk through this with you interactively, but I can't complete Steps
3 and 4 unilaterally — they require your Vercel/GitHub/Firebase Console
login, which I have no access to. Steps 1, 2, and 5 are things I can either
do directly (if you give the go-ahead) or you can follow above.
