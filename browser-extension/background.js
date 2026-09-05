const APP = 'http://127.0.0.1:17777';
const SNIFF_PREFIX = 'sniff_';
const recentDownloadDispatches = new Map();
const interestingExt = /\.(zip|7z|rar|exe|msi|iso|img|tar|gz|bz2|xz|pdf|mp4|mkv|mov|webm|mp3|wav|flac|aac|m4a|ogg|bin|gguf|safetensors|onnx|dmg|pkg|apk|m3u8|mpd)(\?|#|$)/i;

async function appOnline() {
  try {
    const r = await fetch(APP + '/ping', { cache: 'no-store' });
    return r.ok;
  } catch (_) { return false; }
}

async function cookieHeader(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    return cookies.map(x => `${x.name}=${x.value}`).join('; ');
  } catch (_) { return ''; }
}

async function sendToApp(url, filename = '', referrer = '', sourcePage = '', contentType = '', trigger = 'manual') {
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: '只支持 HTTP/HTTPS' };

  const now = Date.now();
  const key = `${trigger}|${url}`;
  const ttl = trigger === 'browser-download' ? 8000 : 2500;
  const previous = recentDownloadDispatches.get(key) || 0;
  if (now - previous < ttl) return { ok: true, deduplicated: true };
  recentDownloadDispatches.set(key, now);

  if (recentDownloadDispatches.size > 300) {
    for (const [k, time] of recentDownloadDispatches) {
      if (now - time > 30000) recentDownloadDispatches.delete(k);
    }
  }

  try {
    const cookie = await cookieHeader(url);
    const r = await fetch(APP + '/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        fileName: filename,
        referrer: referrer || sourcePage || '',
        sourcePage: sourcePage || referrer || '',
        userAgent: navigator.userAgent || '',
        cookie,
        contentType: contentType || '',
        trigger
      })
    });
    const result = await r.json();
    if (!r.ok || !result?.ok) recentDownloadDispatches.delete(key);
    return result;
  } catch (_) {
    recentDownloadDispatches.delete(key);
    return { ok: false, error: '请先启动 Penguin Downloader 3.0' };
  }
}

function headerValue(headers, name) {
  const x = (headers || []).find(h => String(h.name || '').toLowerCase() === name.toLowerCase());
  return x?.value || '';
}

async function probeUrl(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: 'invalid_url' };
  let response = null;
  try {
    response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      cache: 'no-store',
      credentials: 'include'
    });
  } catch (_) {}

  let finalUrl = response?.url || url;
  let contentType = response?.headers?.get('content-type') || '';
  let disposition = response?.headers?.get('content-disposition') || '';
  let contentLength = Number(response?.headers?.get('content-length')) || 0;

  const headLooksLikeMedia = !!response?.ok && (
    /^video\//i.test(contentType) ||
    /application\/octet-stream/i.test(contentType) ||
    /\.(mp4|webm|mov|mkv)(?:[?#]|$)/i.test(finalUrl)
  );

  // 站点下载入口经常不支持 HEAD，或 HEAD 返回的是 HTML 跳转页。
  // 这时必须用 0-0 Range GET 真正跟随到媒体文件，才能得到原始文件大小/最终地址。
  if (!contentLength || !headLooksLikeMedia) {
    try {
      const ranged = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        redirect: 'follow',
        cache: 'no-store',
        credentials: 'include'
      });
      finalUrl = ranged.url || finalUrl;
      contentType = ranged.headers.get('content-type') || contentType;
      disposition = ranged.headers.get('content-disposition') || disposition;
      const contentRange = ranged.headers.get('content-range') || '';
      const total = /\/(\d+)\s*$/.exec(contentRange);
      if (total) contentLength = Number(total[1]) || 0;
      else if (ranged.ok) contentLength = Number(ranged.headers.get('content-length')) || 0;
      try { await ranged.body?.cancel(); } catch (_) {}
    } catch (_) {}
  }

  return {
    ok: !!finalUrl,
    finalUrl,
    contentType,
    contentLength,
    fileName: guessedName(finalUrl, disposition)
  };
}

function shouldSniff(url, type, disposition) {
  if (interestingExt.test(url)) return true;
  const t = String(type || '').toLowerCase();
  const d = String(disposition || '').toLowerCase();
  if (d.includes('attachment') || d.includes('filename=')) return true;
  return t.startsWith('video/') || t.startsWith('audio/') ||
    t.includes('application/octet-stream') || t.includes('application/zip') ||
    t.includes('application/x-7z') || t.includes('application/x-rar') ||
    t.includes('application/pdf') || t.includes('application/vnd.apple.mpegurl') ||
    t.includes('application/x-mpegurl') || t.includes('application/dash+xml');
}

function guessedName(url, disposition) {
  const match = /filename\*?=(?:UTF-8''|\")?([^\";]+)/i.exec(disposition || '');
  if (match?.[1]) {
    try { return decodeURIComponent(match[1].replace(/^\"|\"$/g, '')); } catch (_) { return match[1]; }
  }
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop()) || '资源'; } catch (_) { return '资源'; }
}

function isMediaCandidate(url, type) {
  const u = String(url || '').toLowerCase();
  const t = String(type || '').toLowerCase();
  return /\.(mp4|mkv|mov|webm|m3u8|mpd|mp3|m4a|aac|flac|wav|ogg)(\?|#|$)/i.test(u) ||
    t.startsWith('video/') || t.startsWith('audio/') ||
    t.includes('mpegurl') || t.includes('dash+xml');
}

function isVideoCandidate(url, type) {
  const u = String(url || '').toLowerCase();
  const t = String(type || '').toLowerCase();
  return /\.(mp4|mkv|mov|webm|m3u8|mpd)(\?|#|$)/i.test(u) ||
    t.startsWith('video/') || t.includes('mpegurl') || t.includes('dash+xml');
}

async function pushSniffToApp(item) {
  if (!isMediaCandidate(item.url, item.contentType)) return;
  try {
    const cookie = await cookieHeader(item.url);
    await fetch(APP + '/sniff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: item.url,
        fileName: item.fileName || '',
        contentType: item.contentType || '',
        sourcePage: item.sourcePage || '',
        referrer: item.sourcePage || '',
        userAgent: navigator.userAgent || '',
        cookie,
        contentLength: item.contentLength || 0,
        seenAt: item.time || Date.now()
      })
    });
  } catch (_) {}
}

async function notifySniffUpdate(tabId, item, count) {
  if (tabId == null || tabId < 0 || !isVideoCandidate(item.url, item.contentType)) return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'sniff-update',
      item,
      count: count || 1
    });
  } catch (_) {
    // 页面可能是 chrome://、尚未注入 content script，或标签页已经关闭。
  }
}

async function addSniffed(tabId, item) {
  if (tabId == null || tabId < 0) return;
  const key = SNIFF_PREFIX + tabId;
  const old = await chrome.storage.session.get([key]);
  const list = Array.isArray(old[key]) ? old[key] : [];
  const map = new Map(list.map(x => [x.url, x]));
  map.set(item.url, item);
  const next = Array.from(map.values()).sort((a, b) => b.time - a.time).slice(0, 200);
  await chrome.storage.session.set({ [key]: next });
  await pushSniffToApp(item);
  await notifySniffUpdate(tabId, item, next.filter(x => isVideoCandidate(x.url, x.contentType)).length);
}

chrome.webRequest.onHeadersReceived.addListener(details => {
  if (!/^https?:\/\//i.test(details.url)) return;
  const type = headerValue(details.responseHeaders, 'content-type');
  const disposition = headerValue(details.responseHeaders, 'content-disposition');
  if (!shouldSniff(details.url, type, disposition)) return;
  const contentLength = Number(headerValue(details.responseHeaders, 'content-length')) || 0;
  addSniffed(details.tabId, {
    url: details.url,
    fileName: guessedName(details.url, disposition),
    contentType: type,
    contentLength,
    sourcePage: details.documentUrl || details.initiator || '',
    source: 'network',
    time: Date.now()
  }).catch(() => {});
}, { urls: ['http://*/*', 'https://*/*'] }, ['responseHeaders']);

chrome.tabs.onRemoved.addListener(tabId => {
  chrome.storage.session.remove(SNIFF_PREFIX + tabId).catch(() => {});
});

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'penguin-link', title: '使用 Penguin Downloader 3.0 下载链接', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'penguin-page', title: '使用 Penguin Downloader 3.0 下载当前页面地址', contexts: ['page'] });
  });
  const old = await chrome.storage.local.get(['intercept']);
  if (old.intercept === undefined) await chrome.storage.local.set({ intercept: true });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.menuItemId === 'penguin-link' ? info.linkUrl : (tab?.url || info.pageUrl);
  if (url) await sendToApp(url, '', info.pageUrl || tab?.url || '', tab?.url || info.pageUrl || '', '', 'context-menu');
});

chrome.downloads.onCreated.addListener(async item => {
  const cfg = await chrome.storage.local.get(['intercept']);
  if (cfg.intercept === false) return;
  if (!item.url || !/^https?:\/\//i.test(item.url)) return;
  if (!(await appOnline())) return;
  const result = await sendToApp(
    item.url,
    item.filename ? item.filename.split(/[\\/]/).pop() : '',
    item.referrer || '',
    item.referrer || '',
    item.mime || '',
    'browser-download'
  );
  if (result?.ok) {
    try { await chrome.downloads.cancel(item.id); } catch (_) {}
    try { await chrome.downloads.erase({ id: item.id }); } catch (_) {}
  }
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.type === 'send') {
    sendToApp(msg.url, msg.filename || '', msg.referrer || '', msg.sourcePage || '', msg.contentType || '', msg.trigger || 'manual').then(respond);
    return true;
  }
  if (msg?.type === 'ping') {
    appOnline().then(ok => respond({ ok }));
    return true;
  }
  if (msg?.type === 'probe-url') {
    probeUrl(msg.url).then(respond);
    return true;
  }
  if (msg?.type === 'sniffed') {
    const tabId = Number.isInteger(msg.tabId) ? msg.tabId : sender.tab?.id;
    if (!Number.isInteger(tabId)) {
      respond({ items: [] });
      return;
    }
    const key = SNIFF_PREFIX + tabId;
    chrome.storage.session.get([key]).then(x => respond({ items: x[key] || [] }));
    return true;
  }
});
