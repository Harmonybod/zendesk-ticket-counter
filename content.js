// ─────────────────────────────────────────────
// Zendesk Ticket Tracker — Content Script (v4.0.0)
// Premium slender draggable overlay + Payee Issue scraper + Telegram notes + live event logging
// ─────────────────────────────────────────────

(function () {
    'use strict';

    const OVERLAY_ID = 'zd-tracker-overlay';

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

    // ── Draggable Feature ─────────────────────────
    function makeElementDraggable(elmnt) {
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
        const handle = elmnt.querySelector('.zd-drag-handle');
        if (handle) handle.onmousedown = dragMouseDown;

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

                        chrome.storage.local.get(['ticketPayeeIssues'], (res) => {
                            if (chrome.runtime.lastError) return;
                            let mapping = res.ticketPayeeIssues || {};
                            if (mapping[ticketId] !== liveIssue) {
                                mapping[ticketId] = liveIssue;
                                chrome.storage.local.set({ ticketPayeeIssues: mapping });
                            }
                        });
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

    // ── Create Overlay DOM ────────────────────────
    function createOverlay() {
        if (!chrome.runtime || !chrome.runtime.id || !chrome.storage || !chrome.storage.local) {
            const deadOverlay = document.getElementById(OVERLAY_ID);
            if (deadOverlay) deadOverlay.remove();
            return;
        }

        if (document.getElementById(OVERLAY_ID)) return;

        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;

        overlay.innerHTML = `
      <div class="zd-drag-handle" title="Drag to Move">
        <span></span><span></span><span></span>
      </div>
      <div id="zd-current-ticket"><span class="zd-ticket-none">None</span></div>
      <div id="zd-issue-preview-container"></div>
      <div class="zd-buttons">
        <button class="zd-btn btn-pending" data-type="open" title="Open Ticket">Open</button>
        <button class="zd-btn btn-updates" data-type="new" title="New Ticket">New</button>
        <button class="zd-btn btn-compliance" data-type="compliance" title="Compliance">Comp</button>
        <button class="zd-btn btn-escalations" data-type="escalation" title="Escalation">Esc</button>
        <button class="zd-btn btn-closed" data-type="closed" title="Closed">Clsd</button>
        <button class="zd-btn btn-remove-all" data-type="removeAll" title="Remove Ticket From All Groups">X</button>
      </div>

      <!-- Telegram Note Button & Container -->
      <div class="ztk-btn-wrap ztk-note-wrap" style="width:100%; margin-top:2px;" id="ztk-wrap-note">
        <button class="zd-btn ztk-btn-note" id="ztk-btn-note" title="Send Telegram Note" style="background: radial-gradient(circle at 35% 35%, #9b59b6, #8e44ad); margin-top:0;">
          <svg viewBox="0 0 24 24" style="width:14px; height:14px; fill:none; stroke:#fff; stroke-width:2.5;"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
        </button>
        <div id="ztk-note-container">
          <textarea id="ztk-note-input" placeholder="Type a note..." rows="1"></textarea>
          <button id="ztk-note-send" title="Send">
            <svg viewBox="0 0 24 24"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
          </button>
        </div>
      </div>
    `;

        document.body.appendChild(overlay);
        makeElementDraggable(overlay);

        // ── Telegram Note Handler ──
        const noteBtn = overlay.querySelector('#ztk-btn-note');
        const noteContainer = overlay.querySelector('#ztk-note-container');
        const noteInput = overlay.querySelector('#ztk-note-input');
        const noteSendBtn = overlay.querySelector('#ztk-note-send');

        if (noteBtn && noteContainer) {
            noteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                noteContainer.classList.toggle('ztk-show');
                if (noteContainer.classList.contains('ztk-show')) {
                    noteInput.focus();
                }
            });

            document.addEventListener('click', (e) => {
                if (noteContainer.classList.contains('ztk-show') && !noteContainer.contains(e.target) && !noteBtn.contains(e.target)) {
                    noteContainer.classList.remove('ztk-show');
                }
            });

            const sendNote = () => {
                const text = noteInput.value.trim();
                if (!text) return;
                const ticketId = getTicketIdFromPage();
                const ticketUrl = window.location.href;

                let messageText = `📝 **Zendesk Note**\n${text}`;
                if (ticketId) {
                    messageText = `📝 **Zendesk Note** (#${ticketId})\n${text}\n\n🔗 [View Ticket](${ticketUrl})`;
                }

                noteSendBtn.classList.add('ztk-loading');
                chrome.runtime.sendMessage({ action: 'SEND_TELEGRAM_NOTE', text: messageText }, (response) => {
                    noteSendBtn.classList.remove('ztk-loading');
                    if (response && response.success) {
                        noteInput.value = '';
                        noteContainer.classList.remove('ztk-show');
                        showToastNotification('✓ Telegram note sent!', 'add', 'compliance');
                    } else {
                        showToastNotification(`⚠ ${response?.error || 'Failed to send note'}`, 'remove', '');
                    }
                });
            };

            noteSendBtn.addEventListener('click', sendNote);
            noteInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendNote();
                }
            });
        }

        // ── Category Action Buttons ──
        overlay.querySelectorAll('.zd-btn[data-type]').forEach(button => {
            button.addEventListener('click', () => {
                if (!chrome.runtime || !chrome.runtime.id || !chrome.storage || !chrome.storage.local) {
                    const deadOverlay = document.getElementById(OVERLAY_ID);
                    if (deadOverlay) deadOverlay.remove();
                    showToastNotification("Extension reloaded. Re-clicking will sync!", 'remove', '');
                    return;
                }

                const type = button.getAttribute('data-type');
                const labelName = button.innerText;
                const ticketId = getTicketIdFromPage();

                if (!ticketId) {
                    showToastNotification("No active ticket found in URL or tab!", 'remove', '');
                    return;
                }

                if (type === 'removeAll') {
                    showToastNotification(`Cleared Ticket #${ticketId}`, 'remove', '');
                    return;
                }

                // Send ADD_EVENT message to background
                chrome.runtime.sendMessage({ action: 'ADD_EVENT', type, ticketNumber: ticketId }, (response) => {
                    if (response && response.success) {
                        // Store to masterLogHistory & ticketPayeeIssues for Excel/Inspectors
                        chrome.storage.local.get(['masterLogHistory', 'ticketPayeeIssues'], (res) => {
                            let masterLogHistory = res.masterLogHistory || [];
                            let ticketPayeeIssues = res.ticketPayeeIssues || {};
                            const nowString = new Date().toISOString();

                            masterLogHistory.push({
                                ticketId: ticketId,
                                category: type,
                                timestamp: nowString
                            });

                            const payeeIssueVal = scrapeLivePayeeIssue();
                            if (payeeIssueVal !== "-") {
                                ticketPayeeIssues[ticketId] = payeeIssueVal;
                            }

                            chrome.storage.local.set({ masterLogHistory, ticketPayeeIssues }, () => {
                                showToastNotification(`Recorded Ticket #${ticketId} as ${labelName}!`, 'add', type);
                            });
                        });
                    } else {
                        showToastNotification('Failed to record event', 'remove', '');
                    }
                });
            });
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
    }, 1000);

})();
