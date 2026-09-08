// ─────────────────────────────────────────────
// Zendesk Ticket Tracker — Content Script (v4.1.0)
// Premium slender draggable overlay + Payee Issue scraper + live event logging
// ─────────────────────────────────────────────

(function () {
    'use strict';

    const OVERLAY_ID = 'zd-tracker-overlay';
    let overlayCreationInProgress = false;

    // Guard: avoid duplicate injection
    if (document.getElementById(OVERLAY_ID)) return;

    // ── Ticket ID Extraction ─────────────────────
    function getTicketIdFromPage() {
        const url = window.location.href;
        const match = url.match(/\/tickets\/(\d+)/);
        if (match && match[1]) return match[1];

        const activeTabElement = document.querySelector('ul.tabs li.active, div[data-test-id="workspace-tab-active"]');
        if (activeTabElement) {
            const tabText = activeTabElement.innerText;
            const tabMatch = tabText.match(/#(\d+)/);
            if (tabMatch && tabMatch[1]) return tabMatch[1];
        }

        const tabList = document.querySelectorAll('div[role="tab"]');
        for (let tab of tabList) {
            if (tab.getAttribute('aria-selected') === 'true') {
                const idMatch = tab.innerText.match(/#(\d+)/);
                if (idMatch && idMatch[1]) return idMatch[1];
            }
        }
        return null;
    }

    // ── Payee Issue Scraper ───────────────────────
    function scrapeLivePayeeIssue() {
        let payeeIssueVal = "-";
        const labels = Array.from(document.querySelectorAll('label'));
        const targetLabel = labels.find(el => {
            const rect = el.getBoundingClientRect();
            return el.textContent.includes('Payee Issue Type') && rect.width > 0 && rect.height > 0;
        });

        if (targetLabel && targetLabel.parentElement) {
            const dropdownElement = targetLabel.parentElement.querySelector('[aria-haspopup="listbox"], [aria-haspopup="true"], select, button, .role-select');
            if (dropdownElement) {
                const rawText = dropdownElement.innerText || dropdownElement.textContent || dropdownElement.value || "";
                let cleanText = rawText.trim().split('\n')[0].trim();

                if (cleanText && cleanText !== "-" && !cleanText.toLowerCase().includes('select')) {
                    if (cleanText.includes('::')) {
                        const parts = cleanText.split('::');
                        cleanText = parts[parts.length - 1].trim();
                    }
                    payeeIssueVal = cleanText;
                }
            }
        }
        return payeeIssueVal;
    }

    function generateShortCode(text) {
        if (!text || text === "-") return "";
        return text
            .split(/\s+/)
            .map(word => word.charAt(0).toUpperCase())
            .join('')
            .replace(/[^A-Z]/g, '')
            .substring(0, 4);
    }

    // ── Color Helpers (used to shade floater buttons) ──────
    function hexToRgbParts(hex) {
        const h = hex.replace('#', '');
        const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
        const num = parseInt(full, 16);
        return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
    }

    function mixHexColors(hexA, hexB, ratio) {
        const a = hexToRgbParts(hexA), b = hexToRgbParts(hexB);
        const mix = (x, y) => Math.round(x + (y - x) * ratio);
        const toHex = (v) => v.toString(16).padStart(2, '0');
        return `#${toHex(mix(a.r, b.r))}${toHex(mix(a.g, b.g))}${toHex(mix(a.b, b.b))}`;
    }

    // Mirrors popup.js's THEME_NAMES/normalizeThemeKey — the overlay applies
    // the same 'theme' setting the popup's Appearance picker writes, so
    // legacy 'dark'/'light' values map onto their closest new theme instead
    // of falling through to an unstyled/mismatched attribute value.
    const VALID_THEME_KEYS = [
        'moody', 'minimalist', 'vibrant', 'organic', 'vintage',
        'blue-light', 'blue-dark', 'emerald-forest', 'crisp-light', 'crisp-dark', 'crimson-light', 'crimson-dark'
    ];
    function normalizeThemeKey(theme) {
        if (theme === 'light') return 'minimalist';
        if (VALID_THEME_KEYS.includes(theme)) return theme;
        return 'moody';
    }

    // ── Animated Toast Notifications ─────────────
    function showToastNotification(message, actionType, category) {
        const oldToast = document.querySelector('.zd-toast-notification');
        if (oldToast) oldToast.remove();

        const toast = document.createElement('div');
        toast.className = 'zd-toast-notification';
        toast.innerText = message;

        if (actionType === 'remove') {
            toast.style.backgroundColor = '#ef4444';
            toast.style.boxShadow = '0 0 15px rgba(239, 68, 68, 0.6)';
        } else {
            switch (category) {
                case 'open':
                case 'openPending':
                    toast.style.backgroundColor = '#ff6b6b';
                    toast.style.boxShadow = '0 0 15px rgba(255, 107, 107, 0.6)';
                    break;
                case 'new':
                case 'updates':
                    toast.style.backgroundColor = '#ffd93d';
                    toast.style.color = '#0f172a';
                    toast.style.boxShadow = '0 0 15px rgba(255, 217, 61, 0.6)';
                    break;
                case 'team':
                    toast.style.backgroundColor = '#74b9ff';
                    toast.style.boxShadow = '0 0 15px rgba(116, 185, 255, 0.6)';
                    break;
                case 'compliance':
                    toast.style.backgroundColor = '#2ecc71';
                    toast.style.boxShadow = '0 0 15px rgba(46, 204, 113, 0.6)';
                    break;
                case 'escalation':
                case 'escalations':
                    toast.style.backgroundColor = '#b5723e';
                    toast.style.boxShadow = '0 0 15px rgba(181, 114, 62, 0.6)';
                    break;
                case 'closed':
                    toast.style.backgroundColor = '#95a5a6';
                    toast.style.boxShadow = '0 0 15px rgba(149, 165, 166, 0.6)';
                    break;
                default:
                    toast.style.backgroundColor = '#2ecc71';
                    toast.style.boxShadow = '0 0 15px rgba(46, 204, 113, 0.6)';
            }
        }

        document.body.appendChild(toast);
        setTimeout(() => { toast.remove(); }, 2500);
    }

    // ── Floating "+1" Tap Feedback ─────────────────
    const FLOAT_COLOR_CLASS = {
        open: 'ztk-float-red',
        new: 'ztk-float-yellow',
        team: 'ztk-float-blue',
        compliance: 'ztk-float-green',
        escalation: 'ztk-float-brown',
        closed: 'ztk-float-gray'
    };

    function showPlusAnimation(button, type) {
        const rect = button.getBoundingClientRect();
        const label = document.createElement('div');
        label.className = `ztk-float-label ${FLOAT_COLOR_CLASS[type] || 'ztk-float-red'}`;
        label.textContent = '+1';
        label.style.left = `${rect.left + rect.width / 2}px`;
        label.style.top = `${rect.top}px`;
        label.style.transform = 'translate(-50%, 0)';
        document.body.appendChild(label);
        setTimeout(() => label.remove(), 900);
    }

    // ── Draggable Feature ─────────────────────────
    function makeElementDraggable(elmnt) {
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
        const handle = elmnt.querySelector('.zd-drag-handle');
        if (handle) {
            handle.onmousedown = dragMouseDown;

            // Double-click the handle to flip between vertical and horizontal layout
            handle.addEventListener('dblclick', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const isHorizontal = elmnt.classList.toggle('horizontal-mode');
                if (chrome.runtime && chrome.runtime.id && chrome.storage && chrome.storage.local) {
                    chrome.storage.local.set({ floaterLayout: isHorizontal ? 'horizontal' : 'vertical' });
                }
            });
        }

        function dragMouseDown(e) {
            e = e || window.event;
            if (e.target !== handle && !handle.contains(e.target)) return;
            e.preventDefault();
            pos3 = e.clientX;
            pos4 = e.clientY;
            document.onmouseup = closeDragElement;
            document.onmousemove = elementDrag;
        }

        function elementDrag(e) {
            e = e || window.event;
            e.preventDefault();
            pos1 = pos3 - e.clientX;
            pos2 = pos4 - e.clientY;
            pos3 = e.clientX;
            pos4 = e.clientY;
            elmnt.style.top = (elmnt.offsetTop - pos2) + "px";
            elmnt.style.left = (elmnt.offsetLeft - pos1) + "px";
        }

        function closeDragElement() {
            document.onmouseup = null;
            document.onmousemove = null;
        }
    }

    // ── Overlay Display Refresher ─────────────────
    function refreshOverlayDisplay() {
        if (!chrome.runtime || !chrome.runtime.id || !chrome.storage || !chrome.storage.local) return;

        const ticketId = getTicketIdFromPage();
        const displayContainer = document.getElementById('zd-current-ticket');
        const issuePreviewBox = document.getElementById('zd-issue-preview-container');

        if (displayContainer) {
            if (ticketId) {
                displayContainer.innerHTML = `<span class="zd-ticket-badge">#${ticketId}</span>`;

                const liveIssue = scrapeLivePayeeIssue();
                if (issuePreviewBox) {
                    if (liveIssue !== "-") {
                        const shortCode = generateShortCode(liveIssue);
                        issuePreviewBox.innerHTML = `<span class="zd-issue-preview-badge" title="${liveIssue}">${shortCode}</span>`;

                        // Routed through background.js's serialized write queue —
                        // this fires every second across every open Zendesk tab,
                        // so a direct get/set here would race with itself and with
                        // the click handler below, silently dropping captured data.
                        chrome.runtime.sendMessage({ action: 'RECORD_PAYEE_ISSUE', ticketId, issueVal: liveIssue });
                    } else {
                        issuePreviewBox.innerHTML = "";
                    }
                }
            } else {
                displayContainer.innerHTML = `<span class="zd-ticket-none">None</span>`;
                if (issuePreviewBox) issuePreviewBox.innerHTML = "";
            }
        }
    }

    // ── Category Definitions ──────────────────────
    const CATEGORIES = [
        { type: 'open', label: 'Open', title: 'Open Ticket', cls: 'btn-pending', base: '#ff6b6b' },
        { type: 'new', label: 'New', title: 'New Ticket', cls: 'btn-updates', base: '#ffd93d' },
        { type: 'team', label: 'Team', title: 'Team Ticket', cls: 'btn-team', base: '#74b9ff', optional: true },
        { type: 'compliance', label: 'Comp', title: 'Compliance', cls: 'btn-compliance', base: '#2ecc71' },
        { type: 'escalation', label: 'Esc', title: 'Escalation', cls: 'btn-escalations', base: '#b5723e' },
        { type: 'closed', label: 'Clsd', title: 'Closed', cls: 'btn-closed', base: '#95a5a6' }
    ];

    const UNDO_TYPE_LABELS = { open: 'Open', new: 'New', team: 'Team', compliance: 'Compliance', escalation: 'Escalation', closed: 'Closed' };

    // ── Button "Level" FX Profiles ────────────────
    // Per-category thresholds, off *today's* count for that specific button
    // (not a combined total) — each button levels up independently and
    // resets naturally every day along with dailyTotals.
    //   glass (baseline) → cracking → smoke → fire → buzzer → crowned
    // fireStart/fireEnd are null for categories with no fire stage
    // (Compliance goes straight from smoke to buzzer).
    const BUTTON_FX_PROFILES = {
        open: { crackStart: 15, crackFull: 21, smokeEnd: 25, fireStart: 25, fireEnd: 35, buzzerStart: 35, crown: 50, buzzerColor: '#ffd700' },
        new: { crackStart: 15, crackFull: 21, smokeEnd: 25, fireStart: 25, fireEnd: 35, buzzerStart: 35, crown: 50, buzzerColor: '#ffd700' },
        team: { crackStart: 15, crackFull: 21, smokeEnd: 25, fireStart: 25, fireEnd: 35, buzzerStart: 35, crown: 50, buzzerColor: '#ffd700' },
        compliance: { crackStart: 3, crackFull: 5, smokeEnd: 15, fireStart: null, fireEnd: null, buzzerStart: 15, crown: 25, buzzerColor: '#2ecc71' },
        escalation: { crackStart: 6, crackFull: 10, smokeEnd: 15, fireStart: 15, fireEnd: 20, buzzerStart: 20, crown: 30, buzzerColor: '#ffd700' },
        closed: { crackStart: 6, crackFull: 10, smokeEnd: 15, fireStart: 15, fireEnd: 20, buzzerStart: 20, crown: 30, buzzerColor: '#ffd700' }
    };

    function getButtonFxStage(profile, n) {
        if (n < profile.crackStart) return { stage: 'glass', progress: 0 };
        if (n < profile.crackFull) return { stage: 'cracking', progress: (n - profile.crackStart) / (profile.crackFull - profile.crackStart) };
        if (n < profile.smokeEnd) return { stage: 'smoke', progress: (n - profile.crackFull) / (profile.smokeEnd - profile.crackFull) };
        if (profile.fireStart != null && n < profile.fireEnd) return { stage: 'fire', progress: (n - profile.fireStart) / (profile.fireEnd - profile.fireStart) };
        if (n < profile.crown) return { stage: 'buzzer', progress: (n - profile.buzzerStart) / (profile.crown - profile.buzzerStart) };
        return { stage: 'crowned', progress: 1 };
    }

    function localDateKey(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    // ── Level / Rank System (mirrors popup.js's LEVELS/LEVEL_UP_MESSAGES —
    // keep both in sync if thresholds or copy change) ────────────────────
    const LEVELS = [
        { level: 1, name: 'Novice', min: 0, color: '#ED7D31' },
        { level: 2, name: 'Initiate', min: 15, color: '#F1C40F' },
        { level: 3, name: 'Apprentice', min: 30, color: '#A9DFBF' },
        { level: 4, name: 'Adept', min: 45, color: '#1D8348' },
        { level: 5, name: 'Elite', min: 60, color: '#AED6F1' },
        { level: 6, name: 'Veteran', min: 70, color: '#2E86C1' },
        { level: 7, name: 'Master', min: 80, color: '#1B4F72' },
        { level: 8, name: 'Grandmaster', min: 90, color: '#922B21' },
        { level: 9, name: 'Champion', min: 100, color: '#76448A' },
        { level: 10, name: 'Paragon', min: 120, color: '#5D6D7E' }
    ];
    const LEVEL_UP_MESSAGES = {
        2: "The fog lifts — you're no longer a Novice. Welcome, Initiate!",
        3: 'Skills sharpening fast. Apprentice rank achieved — the real climb begins!',
        4: 'Adept status unlocked! Your hands move faster than doubt can catch up.',
        5: 'Elite tier reached. The queue trembles at your name.',
        6: 'Veteran rank earned — scars of a thousand tickets, worn with pride.',
        7: 'Mastery achieved! Few ever get to see this rank up close.',
        8: 'Grandmaster! Legends are being written in your ticket log.',
        9: 'Champion of the Queue! Triple digits — the crowd roars.',
        10: 'PARAGON. The pinnacle. You are the standard others chase.'
    };
    const LAST_SEEN_LEVEL_KEY = 'lastSeenLevel';

    function getLevelForTotal(total) {
        let current = LEVELS[0];
        for (let i = 0; i < LEVELS.length; i++) {
            if (total >= LEVELS[i].min) current = LEVELS[i];
        }
        return current;
    }

    // Storage is shared across every open Zendesk tab and the popup, so
    // whichever context notices the level increase first wins the write —
    // the others see the already-updated value and simply don't re-fire.
    function checkLevelUpOnPage(currentLevel) {
        if (!chrome.storage || !chrome.storage.local) return;
        const todayKey = localDateKey(new Date());
        chrome.storage.local.get([LAST_SEEN_LEVEL_KEY], (res) => {
            if (chrome.runtime.lastError) return;
            const stored = res[LAST_SEEN_LEVEL_KEY];
            const lastLevel = (stored && stored.dateKey === todayKey) ? stored.level : 1;

            if (currentLevel.level > lastLevel) {
                chrome.storage.local.set({ [LAST_SEEN_LEVEL_KEY]: { level: currentLevel.level, dateKey: todayKey } });
                showPageLevelUpCelebration(currentLevel);
            } else if (!stored || stored.dateKey !== todayKey) {
                chrome.storage.local.set({ [LAST_SEEN_LEVEL_KEY]: { level: currentLevel.level, dateKey: todayKey } });
            }
        });
    }

    function showPageLevelUpCelebration(levelInfo) {
        const msg = LEVEL_UP_MESSAGES[levelInfo.level];
        if (!msg) return; // level 1 — nothing to celebrate about being there

        const old = document.querySelector('.ztk-levelup-celebration');
        if (old) old.remove();

        const box = document.createElement('div');
        box.className = 'ztk-levelup-celebration';
        box.innerHTML = `
            <div class="ztk-levelup-buzzer"></div>
            <div class="ztk-levelup-crown">👑</div>
            <div class="ztk-levelup-headline">LEVEL UP</div>
            <div class="ztk-levelup-rank" style="color:${levelInfo.color};">${levelInfo.name.toUpperCase()}</div>
            <p class="ztk-levelup-msg">${msg}</p>
        `;
        document.body.appendChild(box);

        const buzzerContainer = box.querySelector('.ztk-levelup-buzzer');
        const count = 10 + levelInfo.level * 3;
        const baseDuration = 1.2 + levelInfo.level * 0.08;
        for (let i = 0; i < count; i++) {
            const span = document.createElement('span');
            span.style.left = `${Math.random() * 100}%`;
            span.style.background = levelInfo.color;
            span.style.boxShadow = `0 0 6px ${levelInfo.color}`;
            span.style.animationDuration = `${(baseDuration + Math.random() * 0.6).toFixed(2)}s`;
            span.style.animationDelay = `${(Math.random() * 0.5).toFixed(2)}s`;
            buzzerContainer.appendChild(span);
        }

        requestAnimationFrame(() => box.classList.add('show'));
        const lifespan = 3600 + levelInfo.level * 150;
        setTimeout(() => {
            box.classList.remove('show');
            setTimeout(() => box.remove(), 400);
        }, lifespan);
    }

    function updateButtonFx(btn, type, count) {
        const profile = BUTTON_FX_PROFILES[type];
        if (!profile) return;
        const { stage, progress } = getButtonFxStage(profile, count || 0);
        btn.dataset.fxStage = stage;
        btn.style.setProperty('--fx-progress', progress.toFixed(3));
    }

    // Updates each button's level FX stage *and* its count badge/daily-total
    // (the "Widget Counting" setting) off the same single dailyTotals read.
    function refreshButtonFxAll() {
        const overlay = document.getElementById(OVERLAY_ID);
        if (!overlay || !chrome.storage || !chrome.storage.local) return;
        chrome.storage.local.get(['dailyTotals'], (res) => {
            if (chrome.runtime.lastError) return;
            const todayTotals = (res.dailyTotals && res.dailyTotals[localDateKey(new Date())]) || {};
            let dayTotal = 0;
            overlay.querySelectorAll('.zd-btn[data-type]').forEach(btn => {
                const type = btn.getAttribute('data-type');
                if (!BUTTON_FX_PROFILES[type]) return;
                const count = todayTotals[type] || 0;
                dayTotal += count;
                updateButtonFx(btn, type, count);
                updateButtonCountBadge(btn, count);
            });
            const totalEl = overlay.querySelector('#zd-daily-total-num');
            if (totalEl) totalEl.textContent = dayTotal;

            checkLevelUpOnPage(getLevelForTotal(dayTotal));
        });
    }

    function updateButtonCountBadge(btn, count) {
        const slot = btn.closest('.zd-btn-slot');
        const badge = slot && slot.querySelector('.zd-count-badge');
        if (badge) badge.textContent = count;
    }

    // ── Create Overlay DOM ────────────────────────
    function createOverlay() {
        if (!chrome.runtime || !chrome.runtime.id || !chrome.storage || !chrome.storage.local) {
            const deadOverlay = document.getElementById(OVERLAY_ID);
            if (deadOverlay) deadOverlay.remove();
            return;
        }

        if (document.getElementById(OVERLAY_ID) || overlayCreationInProgress) return;
        overlayCreationInProgress = true;

        chrome.storage.local.get(
            ['tapMode', 'buttonShape', 'teamButtonEnabled', 'floaterLayout', 'categoryColors', 'theme', 'countingEnabled'],
            (settings) => {
                overlayCreationInProgress = false;
                if (chrome.runtime.lastError) return;
                if (document.getElementById(OVERLAY_ID)) return;

                const tapMode = settings.tapMode === 'double' ? 'double' : 'single';
                const isCircle = settings.buttonShape === 'circle';
                const teamEnabled = !!settings.teamButtonEnabled;
                const isHorizontal = settings.floaterLayout === 'horizontal';
                const categoryColors = settings.categoryColors || {};
                const themeKey = normalizeThemeKey(settings.theme);

                const visibleCategories = CATEGORIES.filter(c => !c.optional || teamEnabled);

                const buttonsHtml = visibleCategories.map(c => {
                    // Per-category color picked in Settings (falls back to the
                    // built-in base hue) drives a light/dark two-stop gradient,
                    // matching the popup's stat dots and chart colors.
                    const base = categoryColors[c.type] || c.base;
                    const tintLight = mixHexColors(base, '#ffffff', 0.18);
                    const tintDark = mixHexColors(base, '#000000', 0.22);
                    const fxProfile = BUTTON_FX_PROFILES[c.type];
                    const buzzerColor = fxProfile ? fxProfile.buzzerColor : '#ffd700';
                    const styleAttr = ` style="background: linear-gradient(135deg, ${tintLight} 0%, ${tintDark} 100%); --fx-buzzer-color: ${buzzerColor};"`;
                    const label = isCircle ? '' : c.label;
                    const circleCls = isCircle ? ' circle-mode' : '';
                    const fxHtml = `<span class="zd-fx" aria-hidden="true">
              <span class="fx-glass"></span>
              <span class="fx-crack"></span>
              <span class="fx-smoke"></span>
              <span class="fx-fire"></span>
              <span class="fx-buzzer"></span>
            </span>`;
                    return `<span class="zd-btn-slot${circleCls}">
            <button class="zd-btn ${c.cls}${circleCls}" data-type="${c.type}" title="${c.title}"${styleAttr} data-fx-stage="glass">${label}${fxHtml}</button>
            <span class="fx-crown" aria-hidden="true">👑</span>
            <span class="zd-count-badge" aria-hidden="true">0</span>
          </span>`;
                }).join('');

                const undoBtnHtml = `<button class="zd-btn btn-undo${isCircle ? ' circle-mode' : ''}" data-type="undo" title="Undo Last Recorded Ticket">↩</button>`;

                const overlay = document.createElement('div');
                overlay.id = OVERLAY_ID;
                overlay.setAttribute('data-theme', themeKey);
                if (isHorizontal) overlay.classList.add('horizontal-mode');
                if (settings.countingEnabled === false) overlay.classList.add('counts-hidden');

                overlay.innerHTML = `
      <div class="zd-drag-handle" title="Drag to Move · Double-click to flip layout">
        <span></span><span></span><span></span>
      </div>
      <div id="zd-current-ticket"><span class="zd-ticket-none">None</span></div>
      <div id="zd-issue-preview-container"></div>
      <div class="zd-buttons${isCircle ? ' circle-mode' : ''}">
        ${buttonsHtml}
        ${undoBtnHtml}
      </div>
      <div id="zd-daily-total">Today: <span id="zd-daily-total-num">0</span></div>
    `;

                document.body.appendChild(overlay);
                makeElementDraggable(overlay);

                // ── Category Action Buttons ──
                overlay.querySelectorAll('.zd-btn[data-type]').forEach(button => {
                    const type = button.getAttribute('data-type');
                    const eventName = (type !== 'undo' && tapMode === 'double') ? 'dblclick' : 'click';

                    button.addEventListener(eventName, () => {
                        if (!chrome.runtime || !chrome.runtime.id || !chrome.storage || !chrome.storage.local) {
                            const deadOverlay = document.getElementById(OVERLAY_ID);
                            if (deadOverlay) deadOverlay.remove();
                            showToastNotification("Extension reloaded. Re-clicking will sync!", 'remove', '');
                            return;
                        }

                        // Undo isn't tied to the page's current ticket — it removes
                        // whichever ticket was most recently recorded, from anywhere.
                        if (type === 'undo') {
                            chrome.runtime.sendMessage({ action: 'UNDO' }, (response) => {
                                if (response && response.success) {
                                    const label = UNDO_TYPE_LABELS[response.undoneType] || response.undoneType;
                                    showToastNotification(`↩ Undone: ${label}`, 'remove', '');
                                } else {
                                    showToastNotification((response && response.message) || 'Nothing to undo', 'remove', '');
                                }
                            });
                            return;
                        }

                        const labelName = button.getAttribute('title');
                        const ticketId = getTicketIdFromPage();

                        if (!ticketId) {
                            showToastNotification("No active ticket found in URL or tab!", 'remove', '');
                            return;
                        }

                        // Send ADD_EVENT message to background
                        chrome.runtime.sendMessage({ action: 'ADD_EVENT', type, ticketNumber: ticketId }, (response) => {
                            if (response && response.alreadyHandled) {
                                // Same ticket, same category, already recorded today — don't
                                // double-count it, just tell the agent it's already logged.
                                const priorLabel = UNDO_TYPE_LABELS[response.priorType] || response.priorType;
                                showToastNotification(`Ticket #${ticketId} already handled as ${priorLabel}`, 'remove', '');
                                return;
                            }

                            if (response && response.success) {
                                showPlusAnimation(button, type);
                                if (response.totals) {
                                    updateButtonFx(button, type, response.totals[type] || 0);
                                    updateButtonCountBadge(button, response.totals[type] || 0);
                                    const totalEl = document.getElementById('zd-daily-total-num');
                                    if (totalEl) {
                                        const dayTotal = Object.values(response.totals).reduce((s, v) => s + (v || 0), 0);
                                        totalEl.textContent = dayTotal;
                                    }
                                }

                                // Store to masterLogHistory & ticketPayeeIssues for Excel/Inspectors.
                                // Routed through background.js's serialized write queue instead of
                                // a direct storage get/set here — this used to race against the
                                // periodic refresh's own get/set on the same keys (and against other
                                // open tabs), silently dropping captured Payee Issue Type data.
                                const payeeIssueVal = scrapeLivePayeeIssue();
                                chrome.runtime.sendMessage(
                                    { action: 'RECORD_TICKET_HANDLED', ticketId, category: type, issueVal: payeeIssueVal },
                                    () => {
                                        showToastNotification(`Recorded Ticket #${ticketId} as ${labelName}!`, 'add', type);
                                    }
                                );
                            } else {
                                showToastNotification('Failed to record event', 'remove', '');
                            }
                        });
                    });
                });
            }
        );
    }

    // ── Rebuild overlay when relevant settings change from the popup ──
    if (chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            const watched = ['tapMode', 'buttonShape', 'teamButtonEnabled', 'categoryColors', 'theme', 'countingEnabled'];
            if (watched.some(k => k in changes)) {
                const existing = document.getElementById(OVERLAY_ID);
                if (existing) existing.remove();
            }
        });
    }

    // ── Run Loop ──────────────────────────────────
    setInterval(() => {
        if (!chrome.runtime || !chrome.runtime.id || !chrome.storage || !chrome.storage.local) {
            const deadOverlay = document.getElementById(OVERLAY_ID);
            if (deadOverlay) deadOverlay.remove();
            return;
        }
        createOverlay();
        refreshOverlayDisplay();
        refreshButtonFxAll();
    }, 1000);

})();
