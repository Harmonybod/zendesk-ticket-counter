// Applied the instant storage read resolves, straight from
// chrome.storage.local — not routed through the background service
// worker like the rest of popup.js's init does (GET_AUTH_STATE then
// GET_STATS), which was slow enough that the popup visibly flashed the
// default "moody" theme every time before switching to the saved one.
//
// This lives in its own file rather than an inline <script> in popup.html:
// MV3's default CSP for extension pages is script-src 'self', which blocks
// inline scripts outright, so as an inline block it never actually ran.
chrome.storage.local.get(['theme'], (res) => {
    if (res && res.theme) document.documentElement.setAttribute('data-theme', res.theme);
});
