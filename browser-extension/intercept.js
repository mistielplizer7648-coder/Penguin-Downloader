(() => {
  const DIRECT_DOWNLOAD_EXT = /\.(zip|7z|rar|exe|msi|iso|img|tar|gz|bz2|xz|pdf|mp4|mkv|mov|webm|mp3|wav|flac|aac|m4a|ogg|bin|gguf|safetensors|onnx|dmg|pkg|apk)(?:[?#]|$)/i;
  const DOWNLOAD_TEXT = /(download|下载|本地下载|高速下载|电信下载|联通下载|网通下载|移动下载|镜像下载|立即下载|点击下载)/i;
  const DOWNLOAD_PATH = /\/(?:download|downloads|down|dl|get|fetch|attachment|file)(?:\/|$)/i;
  const PAGE_EXT = /\.(?:html?|shtml|php|asp|aspx|jsp)(?:[?#]|$)/i;

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

  function downloadText(anchor) {
    return [
      anchor.textContent,
      anchor.getAttribute('title'),
      anchor.getAttribute('aria-label'),
      anchor.getAttribute('class'),
      anchor.querySelector?.('[title]')?.getAttribute?.('title'),
      anchor.querySelector?.('[aria-label]')?.getAttribute?.('aria-label')
    ].filter(Boolean).join(' ');
  }

  function querySignalsDownload(url) {
    try {
      const u = new URL(url, location.href);
      for (const key of ['download', 'attachment', 'dl']) {
        if (!u.searchParams.has(key)) continue;
        const value = String(u.searchParams.get(key) || '').toLowerCase();
        if (value === '' || value === '1' || value === 'true' || value === 'yes') return true;
      }
      return u.searchParams.has('filename') || u.searchParams.has('file_name');
    } catch (_) {
      return false;
    }
  }

  function isLikelyDownload(anchor, url) {
    if (!anchor || !isHttpUrl(url)) return false;
    if (anchor.hasAttribute('download')) return true;
    if (DIRECT_DOWNLOAD_EXT.test(url)) return true;
    if (querySignalsDownload(url)) return true;

    let pathLooksDownload = false;
    let crossOrigin = false;
    try {
      const u = new URL(url, location.href);
      pathLooksDownload = DOWNLOAD_PATH.test(u.pathname);
      crossOrigin = u.origin !== location.origin;
    } catch (_) {}

    const textLooksDownload = DOWNLOAD_TEXT.test(downloadText(anchor));
    if (pathLooksDownload && !PAGE_EXT.test(url)) return true;
    if (textLooksDownload && pathLooksDownload) return true;
    if (textLooksDownload && crossOrigin && !PAGE_EXT.test(url)) return true;
    return false;
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

    // Capture before site JavaScript/default navigation can create a native Chrome download.
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

    // Downloader unavailable/disabled: preserve normal browser behavior.
    nativeFallback(anchor, url);
  }, true);
})();
