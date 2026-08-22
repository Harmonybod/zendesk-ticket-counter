// ─────────────────────────────────────────────
// Zendesk Ticket Tracker — Content Script
// Injects floating widget, handles double-click counting
// ─────────────────────────────────────────────

(function () {
    'use strict';

    const WIDGET_ID = 'ztk-widget';
    const DOUBLE_CLICK_DELAY = 350; // ms window for double-click detection

    // ── Guard: prevent duplicate injection ───────
    if (document.getElementById(WIDGET_ID)) return;

    // ── State ────────────────────────────────────
    let clickTimers = { open: null, new: null, team: null, compliance: null, escalation: null, closed: null };
    let clickCounts = { open: 0, new: 0, team: 0, compliance: 0, escalation: 0, closed: 0 };
    let logoClicks = 0;
    let logoTimer = null;
    let isHorizontal = false;
    let isDragging = false;
    let dragOffset = { x: 0, y: 0 };

    // ── Build Widget DOM ─────────────────────────
    function buildWidget() {
        const widget = document.createElement('div');
        widget.id = WIDGET_ID;
        widget.innerHTML = `
      <div id="ztk-header">
        <div id="ztk-logo">TT</div>
        <div id="ztk-title">Tracker</div>
      </div>
      <div class="ztk-divider"></div>

      <!-- Red: Open -->
      <div class="ztk-btn-wrap" data-tip="Double-click: Open Ticket" id="ztk-wrap-open">
        <button class="ztk-btn ztk-btn-red" id="ztk-btn-open" data-type="open" title=""></button>
        <span class="ztk-count" id="ztk-count-open">0</span>
        <span class="ztk-btn-label">Open</span>
      </div>

      <!-- Yellow: New -->
      <div class="ztk-btn-wrap" data-tip="Double-click: New Ticket" id="ztk-wrap-new">
        <button class="ztk-btn ztk-btn-yellow" id="ztk-btn-new" data-type="new" title=""></button>
        <span class="ztk-count" id="ztk-count-new">0</span>
        <span class="ztk-btn-label">New</span>
      </div>

      <!-- Blue: Team -->
      <div class="ztk-btn-wrap" data-tip="Double-click: Team Ticket" id="ztk-wrap-team">
        <button class="ztk-btn ztk-btn-blue" id="ztk-btn-team" data-type="team" title=""></button>
        <span class="ztk-count" id="ztk-count-team">0</span>
        <span class="ztk-btn-label">Team</span>
      </div>

      <!-- Green: Compliance -->
      <div class="ztk-btn-wrap" data-tip="Double-click: Compliance" id="ztk-wrap-compliance">
        <button class="ztk-btn ztk-btn-green" id="ztk-btn-compliance" data-type="compliance" title=""></button>
        <span class="ztk-count" id="ztk-count-compliance">0</span>
        <span class="ztk-btn-label">Cmpl</span>
      </div>

      <!-- Brown: Escalation -->
      <div class="ztk-btn-wrap" data-tip="Double-click: Escalation" id="ztk-wrap-escalation">
        <button class="ztk-btn ztk-btn-brown" id="ztk-btn-escalation" data-type="escalation" title=""></button>
        <span class="ztk-count" id="ztk-count-escalation">0</span>
        <span class="ztk-btn-label">Esc</span>
      </div>

      <!-- Gray: Closed -->
      <div class="ztk-btn-wrap" data-tip="Double-click: Closed Ticket" id="ztk-wrap-closed">
        <button class="ztk-btn ztk-btn-gray" id="ztk-btn-closed" data-type="closed" title=""></button>
        <span class="ztk-count" id="ztk-count-closed">0</span>
        <span class="ztk-btn-label">Close</span>
      </div>

      <div class="ztk-divider"></div>
      
      <!-- Telegram Note Button -->
      <div class="ztk-btn-wrap ztk-note-wrap" data-tip="Send Note" id="ztk-wrap-note">
        <button class="ztk-btn ztk-btn-note" id="ztk-btn-note">
          <svg viewBox="0 0 24 24"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
        </button>
        
        <!-- Expandable Note Input -->
        <div id="ztk-note-container">
          <textarea id="ztk-note-input" placeholder="Type a note..." rows="1"></textarea>
          <button id="ztk-note-send" title="Send">
            <svg viewBox="0 0 24 24"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
          </button>
        </div>
      </div>

      <div class="ztk-divider"></div>
      <div id="ztk-daily-total">Today <span id="ztk-total-num">0</span></div>

      <!-- Warning toast for missing ticket number -->
      <div id="ztk-warning-toast"></div>
    `;

        return widget;
    }

    // ── Apply counting visibility ─────────────────
    function applyCountingState(widget, enabled) {
        if (enabled) {
            widget.classList.remove('ztk-counts-hidden');
        } else {
            widget.classList.add('ztk-counts-hidden');
        }
    }

    // ── Update daily total on widget ──────────────
    function updateWidgetTotal(totals) {
        const totalEl = document.getElementById('ztk-total-num');
        if (totalEl && totals) {
            const sum = (totals.open || 0) + (totals.new || 0) + (totals.team || 0) +
                        (totals.compliance || 0) + (totals.escalation || 0) + (totals.closed || 0);
            totalEl.textContent = sum;
        }
    }

    // ── Pulse animation on button ─────────────────
    function triggerPulse(btn) {
        btn.classList.remove('ztk-pulsing');
        void btn.offsetWidth; // force reflow
        btn.classList.add('ztk-pulsing');
        btn.addEventListener('animationend', () => {
            btn.classList.remove('ztk-pulsing');
        }, { once: true });
    }

    // ── Floating +1 feedback label ────────────────
    const FLOAT_COLOR_MAP = {
        open: 'red', new: 'yellow', team: 'blue',
        compliance: 'green', escalation: 'brown', closed: 'gray'
    };

    function spawnFloatLabel(btn, type) {
        const rect = btn.getBoundingClientRect();
        const label = document.createElement('div');
        label.className = `ztk-float-label ztk-float-${FLOAT_COLOR_MAP[type] || 'blue'}`;
        label.textContent = '+1';
        // Center the label over the button (28px font, roughly 28px wide)
        label.style.left = `${rect.left + rect.width / 2 - 18}px`;
        label.style.top = `${rect.top - 14}px`;
        document.body.appendChild(label);
        label.addEventListener('animationend', () => label.remove());
    }

    // ── Extract ticket number from Zendesk URL ───
    function extractTicketNumber() {
        const url = window.location.href;
        const match = url.match(/\/tickets\/(\d+)/);
        return match ? match[1] : null;
    }

    // ── Show warning toast on widget ─────────────
    function showWidgetWarning(msg) {
        const toast = document.getElementById('ztk-warning-toast');
        if (!toast) return;
        toast.textContent = msg;
        toast.classList.add('ztk-show');
        setTimeout(() => toast.classList.remove('ztk-show'), 3000);
    }

    // ── Handle double-click recording ────────────
    function handleClick(btn, type) {
        clickCounts[type] = (clickCounts[type] || 0) + 1;

        if (clickTimers[type]) {
            clearTimeout(clickTimers[type]);
            clickTimers[type] = null;
        }

        if (clickCounts[type] >= 2) {
            // Double-click detected — extract ticket number first
            clickCounts[type] = 0;

            const ticketNumber = extractTicketNumber();
            if (!ticketNumber) {
                showWidgetWarning('⚠ No ticket number found in URL!');
                return;
            }

            triggerPulse(btn);
            spawnFloatLabel(btn, type);
            chrome.runtime.sendMessage({ action: 'ADD_EVENT', type, ticketNumber }, (response) => {
                if (response && response.success) {
                    updateWidgetTotal(response.totals);
                    // Update the specific badge count
                    const badgeEl = document.getElementById(`ztk-count-${type}`);
                    if (badgeEl) badgeEl.textContent = response.totals[type] || 0;
                }
            });
        } else {
            // Wait for potential second click
            clickTimers[type] = setTimeout(() => {
                clickCounts[type] = 0;
                clickTimers[type] = null;
            }, DOUBLE_CLICK_DELAY);
        }
    }

    // ── Logo double-click: toggle horizontal / vertical layout ───────────
    function handleLogoClick() {
        logoClicks++;
        if (logoTimer) clearTimeout(logoTimer);

        if (logoClicks >= 2) {
            logoClicks = 0;
            isHorizontal = !isHorizontal;
            const widget = document.getElementById(WIDGET_ID);
            if (widget) widget.classList.toggle('ztk-horizontal', isHorizontal);
        } else {
            logoTimer = setTimeout(() => { logoClicks = 0; }, DOUBLE_CLICK_DELAY);
        }
    }

    // ── Drag Logic ────────────────────────────────
    function initDrag(widget) {
        widget.addEventListener('mousedown', (e) => {
            // Don't drag if clicking a button
            if (e.target.classList.contains('ztk-btn')) return;
            isDragging = true;
            const rect = widget.getBoundingClientRect();
            dragOffset.x = e.clientX - rect.left;
            dragOffset.y = e.clientY - rect.top;
            widget.style.transition = 'none';
            widget.style.transform = 'none';
            widget.style.top = `${rect.top}px`;
            widget.style.bottom = 'auto'; // clear any bottom anchor (e.g. from horizontal mode)
            widget.style.right = 'auto';
            widget.style.left = `${rect.left}px`;
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const x = e.clientX - dragOffset.x;
            const y = e.clientY - dragOffset.y;
            widget.style.left = `${Math.max(0, Math.min(x, window.innerWidth - widget.offsetWidth))}px`;
            widget.style.top = `${Math.max(0, Math.min(y, window.innerHeight - widget.offsetHeight))}px`;
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
        });
    }

    // ── Inject Widget ─────────────────────────────
    function injectWidget() {
        if (document.getElementById(WIDGET_ID)) return;
        const widget = buildWidget();
        document.body.appendChild(widget);

        // Read settings and apply counting state
        chrome.runtime.sendMessage({ action: 'GET_STATS' }, (response) => {
            if (response) {
                applyCountingState(widget, response.countingEnabled !== false);
                updateWidgetTotal(response.today);

                // Also update individual badge counts for today
                if (response.today) {
                    ['open', 'new', 'team', 'compliance', 'escalation', 'closed'].forEach(t => {
                        const el = document.getElementById(`ztk-count-${t}`);
                        if (el) el.textContent = response.today[t] || 0;
                    });
                }
            }
        });

        // Logo double-click → collapse/expand
        const logo = document.getElementById('ztk-logo');
        if (logo) {
            logo.addEventListener('click', (e) => {
                e.stopPropagation();
                handleLogoClick();
            });
        }

        // Ticket button click handlers
        ['open', 'new', 'team', 'compliance', 'escalation', 'closed'].forEach(type => {
            const btn = document.getElementById(`ztk-btn-${type}`);
            if (btn) {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    handleClick(btn, type);
                });
            }
        });

        // ── Telegram Note Logic ──────────────────
        const noteBtn = document.getElementById('ztk-btn-note');
        const noteContainer = document.getElementById('ztk-note-container');
        const noteInput = document.getElementById('ztk-note-input');
        const noteSendBtn = document.getElementById('ztk-note-send');

        if (noteBtn && noteContainer && noteInput && noteSendBtn) {
            noteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const isOpen = noteContainer.classList.contains('ztk-show');
                if (isOpen) {
                    noteContainer.classList.remove('ztk-show');
                } else {
                    noteContainer.classList.add('ztk-show');
                    noteInput.value = '';
                    noteInput.focus();
                }
            });

            // Hide note input when clicking outside
            document.addEventListener('click', (e) => {
                if (!noteContainer.contains(e.target) && e.target !== noteBtn && !noteBtn.contains(e.target)) {
                    noteContainer.classList.remove('ztk-show');
                }
            });

            // Prevent drag from closing the widget input
            noteContainer.addEventListener('mousedown', (e) => e.stopPropagation());

            // Prevent Zendesk page from intercepting keyboard events in the note input
            // (Zendesk uses keyboard shortcuts that steal focus and block symbols like # @ !)
            ['keydown', 'keyup', 'keypress'].forEach(evt => {
                noteInput.addEventListener(evt, (e) => {
                    e.stopPropagation();
                });
            });

            // Auto-expand textarea
            noteInput.addEventListener('input', () => {
                noteInput.style.height = '36px'; // reset
                noteInput.style.height = Math.min(noteInput.scrollHeight, 120) + 'px';
            });

            // Send note function
            const sendNote = () => {
                const text = noteInput.value.trim();
                if (!text) return;

                // Prepend current Zendesk ticket URL context if helpful
                const url = window.location.href;
                const finalNote = `📝 **Zendesk Note**\n\n${text}\n\n🔗 [View Ticket](${url})`;

                noteSendBtn.classList.add('ztk-loading');
                noteInput.disabled = true;

                chrome.runtime.sendMessage({ action: 'SEND_TELEGRAM_NOTE', text: finalNote }, (response) => {
                    noteSendBtn.classList.remove('ztk-loading');
                    noteInput.disabled = false;
                    
                    if (response && response.success) {
                        noteContainer.classList.remove('ztk-show');
                        triggerPulse(noteBtn); // Visual success feedback
                    } else {
                        // Show error briefly in input
                        const origValue = noteInput.value;
                        noteInput.value = response?.error || 'Failed to send...';
                        noteInput.style.color = '#ff6b6b';
                        setTimeout(() => {
                            noteInput.value = origValue;
                            noteInput.style.color = '#fff';
                            noteInput.focus();
                        }, 2000);
                    }
                });
            };

            // Send on Enter (Shift+Enter for new line)
            noteInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault(); // prevent new line
                    sendNote();
                }
            });

            // Send on button click
            noteSendBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                sendNote();
            });
        }

        initDrag(widget);
    }

    // ── Listen for counting toggle from storage changes ─────
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local' && changes.countingEnabled !== undefined) {
            const widget = document.getElementById(WIDGET_ID);
            if (widget) applyCountingState(widget, changes.countingEnabled.newValue !== false);
        }
    });

    // ── Watch for SPA navigation (Zendesk is a SPA) ──
    function watchNavigation() {
        const observer = new MutationObserver(() => {
            if (!document.getElementById(WIDGET_ID)) {
                injectWidget();
            }
        });
        observer.observe(document.body, { childList: true, subtree: false });
    }

    // ── Init ──────────────────────────────────────
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            injectWidget();
            watchNavigation();
        });
    } else {
        injectWidget();
        watchNavigation();
    }
})();
