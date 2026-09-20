(() => {
  // Only pre-intercept links that are unambiguously downloads.
  // Do NOT use button text, generic /download|/get|/file paths, query names,
  // or cross-origin navigation as takeover signals: modern sites commonly use
  // those patterns for ordinary HTML routes and SPA navigation.
  const DIRECT_DOWNLOAD_EXT = /\.(zip|7z|rar|exe|msi|iso|img|tar|gz|bz2|xz|bin|gguf|safetensors|onnx|dmg|pkg|apk)(?:[?#]|$)/i;

  function isHttpUrl(value) {
    return /^https?:\/\//i.test(String(value || ''));
  }

  function anchorFromEvent(event) {
    for (const node of event.composedPath?.() || []) {
      if (node instanceof HTMLAnchorElement && node.href) return node;
    }
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    return target?.closest?.('a[href]') || null;
  }

  function isLikelyDownload(anchor, url) {
    if (!anchor || !isHttpUrl(url)) return false;

    // Explicit author intent is always safe to treat as a download.
    if (anchor.hasAttribute('download')) return true;

    // Pre-intercept only clearly non-page file types. Browser-confirmed downloads
    // (including PDF/media, attachment responses and extensionless downloads)
    // are still handled by background.js via chrome.downloads.onDeterminingFilename.
    return DIRECT_DOWNLOAD_EXT.test(url);
  }

  function suggestedFilename(anchor, url) {
    const explicit = String(anchor.getAttribute('download') || '').trim();
    if (explicit && explicit.toLowerCase() !== 'true') return explicit;
    if (!DIRECT_DOWNLOAD_EXT.test(url)) return '';
    try {
      return decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    } catch (_) {
      return '';
    }
  }

  function nativeFallback(anchor, url) {
    const fallback = document.createElement('a');
    fallback.href = url;
    fallback.dataset.penguinBypass = '1';
    const explicit = anchor.getAttribute('download');
    if (explicit !== null) fallback.setAttribute('download', explicit);
    if (anchor.target) fallback.target = anchor.target;
    if (anchor.rel) fallback.rel = anchor.rel;
    fallback.style.display = 'none';
    const parent = document.documentElement || document.body;
    if (parent) parent.appendChild(fallback);
    try {
      fallback.click();
    } finally {
      fallback.remove();
    }
  }

  window.addEventListener('click', async event => {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;

    const anchor = anchorFromEvent(event);
    if (!anchor || anchor.dataset.penguinBypass === '1') return;

    const url = anchor.href;
    if (!isLikelyDownload(anchor, url)) return;

    // Only strong download signals reach this point, so ordinary page navigation
    // is never prevented by Penguin Downloader.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'intercept-link',
        url,
        filename: suggestedFilename(anchor, url),
        referrer: location.href,
        sourcePage: location.href
      });
      if (response?.handled) return;
    } catch (_) {}

    // Downloader unavailable/disabled: preserve native browser download/navigation.
    nativeFallback(anchor, url);
  }, true);
})();
