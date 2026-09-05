const PENGUIN_FLOAT_ID = 'penguin-downloader-video-float';
const PENGUIN_PANEL_ID = 'penguin-downloader-video-panel';
const candidates = new Map();
let floatingButton = null;
let panel = null;
let positionQueued = false;
let manualPanelPosition = null;
let lastVideoInteractionAt = 0;
let lastInteractedVideo = null;
let panelActivationRequested = false;

// 扩展升级/热重载后，旧 content script 可能遗留一个已经展开的面板。
// 新版本启动时先清掉残留；以后只有用户主动点击悬浮入口才允许创建面板。
document.getElementById(PENGUIN_PANEL_ID)?.remove();

function isHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

function isPlaylist(url, type = '') {
  const u = String(url || '').toLowerCase();
  const t = String(type || '').toLowerCase();
  return /\.(m3u8|mpd)(\?|#|$)/i.test(u) || t.includes('mpegurl') || t.includes('dash+xml');
}

function isVideoUrl(url, type = '') {
  const u = String(url || '').toLowerCase();
  const t = String(type || '').toLowerCase();
  return /\.(mp4|mkv|mov|webm|m3u8|mpd)(\?|#|$)/i.test(u) || t.startsWith('video/') || isPlaylist(u, t);
}

function guessedName(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return name || '网页视频';
  } catch (_) {
    return '网页视频';
  }
}

function cleanTitle(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length < 2 || text.length > 140) return '';
  if (/^(video|视频|play|播放|media|媒体|download|下载|免费下载|free download|save|保存)$/i.test(text)) return '';
  return text;
}

function pageTitle() {
  const og = document.querySelector('meta[property="og:title"]')?.content;
  const twitter = document.querySelector('meta[name="twitter:title"]')?.content;
  const h1 = document.querySelector('h1')?.textContent;
  return cleanTitle(og) || cleanTitle(twitter) || cleanTitle(h1) || cleanTitle(document.title) || '当前网页视频';
}

function findNearbyTitle(video) {
  const direct = cleanTitle(video.getAttribute('aria-label')) || cleanTitle(video.getAttribute('title'));
  if (direct) return direct;
  let node = video.parentElement;
  for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
    const titleNode = node.querySelector?.('[data-video-title], [data-testid*="title" i], figcaption, h1, h2, h3, a[title]');
    const title = cleanTitle(titleNode?.getAttribute?.('title')) || cleanTitle(titleNode?.textContent);
    if (title) return title;
  }
  return pageTitle();
}

function candidateMetrics(item) {
  const text = `${item?.fileName || ''} ${item?.url || ''} ${item?.resolvedUrl || ''}`;
  const resolution = /(?:^|[_\-/.])(\d{3,4})[_x-](\d{3,4})(?:[_-](\d{2,3})fps)?/i.exec(text);
  const width = Number(item?.width || (resolution ? Number(resolution[1]) : 0));
  const height = Number(item?.height || (resolution ? Number(resolution[2]) : 0));
  const fps = Number(item?.fps || (resolution?.[3] ? Number(resolution[3]) : 0));
  const lower = text.toLowerCase();
  let qualityRank = 0;
  if (item?.source === 'site-original-download' || item?.quality === 'original') qualityRank = 9;
  else if (/(?:^|[_\-.])(original|source|raw)(?:[_\-.]|$)/i.test(lower)) qualityRank = 8;
  else if (/(?:4k|2160p|uhd)/i.test(lower)) qualityRank = 6;
  else if (/(?:1440p|2k|qhd)/i.test(lower)) qualityRank = 5;
  else if (/(?:1080p|fullhd|fhd)/i.test(lower)) qualityRank = 4;
  else if (/(?:720p|\bhd\b)/i.test(lower)) qualityRank = 3;
  else if (/(?:480p|\bsd\b)/i.test(lower)) qualityRank = 2;
  else if (/(?:360p|240p)/i.test(lower)) qualityRank = 1;
  return { width, height, fps, pixels: width * height, qualityRank };
}

function stableMediaKey(url) {
  try {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname);

    // Pexels：播放器 CDN 与 www.pexels.com/download/video/{id}/ 都视为同一个视频资产。
    const pexelsCdn = /\/video-files\/(\d{5,})\//i.exec(path);
    if (pexelsCdn) return `pexels|video|${pexelsCdn[1]}`;
    const pexelsDownload = /\/download\/video\/(\d{5,})\/?/i.exec(path);
    if (pexelsDownload && /(^|\.)pexels\.com$/i.test(u.hostname)) return `pexels|video|${pexelsDownload[1]}`;

    // UUID 或较长数字 ID 通常比“同页同时间”更能可靠表示同一媒体资产。
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.exec(path);
    if (uuid) return `${u.host}|uuid|${uuid[0].toLowerCase()}`;
    const ids = path.match(/\d{6,}/g);
    if (ids?.length) return `${u.host}|id|${ids[0]}`;

    const parts = path.split('/').filter(Boolean);
    const file = (parts.pop() || '').replace(/\.[^.]+$/, '');
    const normalized = file
      .replace(/(?:^|[_\-.])(original|source|raw|uhd|4k|2160p|1440p|2k|qhd|1080p|fullhd|fhd|720p|hd|480p|sd|360p|240p)(?=[_\-.]|$)/ig, '')
      .replace(/(?:^|[_\-.])\d{3,4}[_x-]\d{3,4}(?:[_-]\d{2,3}fps)?/ig, '')
      .replace(/[_\-.]+/g, '-').replace(/^-|-$/g, '');
    if (normalized.length >= 8) return `${u.host}|stem|${parts.join('/')}|${normalized}`;
  } catch (_) {}
  return '';
}

function genericMediaSignature(url) {
  try {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname);
    const parts = path.split('/').filter(Boolean);
    const file = (parts.pop() || '').replace(/\.[^.]+$/, '');
    const ids = new Set((path.match(/[0-9a-f]{8}-[0-9a-f-]{20,}|\d{6,}/ig) || [])
      .filter(x => !/^(?:240|360|480|540|720|1080|1440|2160|3840|4096)$/.test(x))
      .map(x => x.toLowerCase()));
    const stem = file
      .replace(/(?:^|[_\-.])(original|source|raw|master|uhd|4k|2k|qhd|fullhd|fhd|hd|sd)(?=[_\-.]|$)/ig, '')
      .replace(/(?:^|[_\-.])(?:240|360|480|540|720|1080|1440|2160|3840|4096)p?(?=[_\-.]|$)/ig, '')
      .replace(/(?:^|[_\-.])\d{3,4}[_x-]\d{3,4}(?:[_-]\d{2,3}fps)?/ig, '')
      .replace(/(?:^|[_\-.])\d{2,3}fps(?=[_\-.]|$)/ig, '')
      .replace(/[_\-.]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    return { host: u.host.toLowerCase(), dir: parts.join('/').toLowerCase(), stem, ids };
  } catch (_) {
    return { host: '', dir: '', stem: '', ids: new Set() };
  }
}

function pageMediaTokens() {
  const values = [location.href];
  const canonical = document.querySelector('link[rel="canonical"]')?.href;
  const ogUrl = document.querySelector('meta[property="og:url"]')?.content;
  if (canonical) values.push(canonical);
  if (ogUrl) values.push(ogUrl);

  const ids = new Set();
  for (const raw of values) {
    try {
      const u = new URL(raw, location.href);
      const text = `${u.pathname} ${u.search}`;
      for (const token of text.match(/[0-9a-f]{8}-[0-9a-f-]{20,}|\d{6,}/ig) || []) {
        if (!/^(?:240|360|480|540|720|1080|1440|2160|3840|4096)$/.test(token)) ids.add(token.toLowerCase());
      }
    } catch (_) {}
  }
  return ids;
}

function candidateAffinity(item, active) {
  if (!active) return 0;
  const candidateUrl = item.resolvedUrl || item.url;
  if (active.urls.has(item.url) || active.urls.has(candidateUrl)) return 10000;

  const cs = genericMediaSignature(candidateUrl);
  const pageIds = pageMediaTokens();
  let best = 0;

  // 通用页面身份：当前详情页 URL / canonical / og:url 中的长数字 ID 或 UUID，
  // 如果也出现在媒体 URL 中，这是比 DOM 距离更强的“当前页面视频”证据。
  const pageMatches = [...cs.ids].filter(id => pageIds.has(id));
  if (pageMatches.length) best = 7200 + Math.min(800, pageMatches.length * 200);

  for (const activeUrl of active.urls) {
    const as = genericMediaSignature(activeUrl);
    let score = 0;
    if (cs.host && as.host && cs.host === as.host) score += 300;
    const sharedIds = [...cs.ids].filter(id => as.ids.has(id));
    if (sharedIds.length) score += 5000 + Math.min(1000, sharedIds.length * 250);
    if (cs.stem && as.stem && cs.stem.length >= 6 && as.stem.length >= 6) {
      if (cs.stem === as.stem) score += 4200;
      else if (cs.stem.includes(as.stem) || as.stem.includes(cs.stem)) score += 2600;
    }
    if (cs.dir && as.dir && cs.dir === as.dir) score += 900;
    const m = candidateMetrics(item);
    if (m.width && m.height && active.width && active.height) {
      const ar1 = m.width / m.height;
      const ar2 = active.width / active.height;
      if (Math.abs(ar1 - ar2) / Math.max(ar1, ar2) < 0.035) score += 900;
    }
    // “播放器附近”只作为弱辅助，绝不能单独让候选进入当前视频列表。
    if (item.scope === 'near-active') score += 350;
    best = Math.max(best, score);
  }
  return best;
}

function compareVideoQuality(a, b) {
  const ap = isPlaylist(a.url, a.contentType) ? 1 : 0;
  const bp = isPlaylist(b.url, b.contentType) ? 1 : 0;
  if (ap !== bp) return ap - bp;
  const qa = candidateMetrics(a);
  const qb = candidateMetrics(b);
  return (qb.qualityRank - qa.qualityRank) ||
    (qb.pixels - qa.pixels) ||
    (qb.fps - qa.fps) ||
    ((Number(b.contentLength) || 0) - (Number(a.contentLength) || 0)) ||
    ((Number(b.time) || 0) - (Number(a.time) || 0));
}

function mediaMeta(item) {
  const m = candidateMetrics(item);
  const parts = [];
  if (m.width && m.height) {
    parts.push(`${m.width}×${m.height}`);
    if (m.fps) parts.push(`${m.fps} fps`);
  }
  const size = formatBytes(item.contentLength);
  if (size) parts.push(size);
  if (!parts.length && item.contentType) parts.push(item.contentType);
  return parts.join(' · ');
}

function visibleArea(rect) {
  const w = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
  const h = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
  return w * h;
}

function currentVideoInfo() {
  let best = null;
  let bestScore = -1;
  for (const video of document.querySelectorAll('video')) {
    const rect = video.getBoundingClientRect();
    const area = visibleArea(rect);
    if (area < 120 * 70) continue;

    // 通用选择规则：用户最后交互的视频 > 正在播放的视频 > 当前可见面积最大的播放器。
    // 这样同一网页连续切换不同视频时，不会一直黏在第一个/最大的播放器上。
    const interacted = video === lastInteractedVideo ? 300000000 : 0;
    const playing = !video.paused && !video.ended ? 150000000 : 0;
    const score = interacted + playing + area;
    if (score <= bestScore) continue;

    const urls = new Set();
    if (isHttpUrl(video.currentSrc)) urls.add(video.currentSrc);
    if (isHttpUrl(video.src)) urls.add(video.src);
    video.querySelectorAll('source[src]').forEach(source => { if (isHttpUrl(source.src)) urls.add(source.src); });
    best = {
      video,
      rect,
      urls,
      title: findNearbyTitle(video),
      width: video.videoWidth || Math.round(rect.width),
      height: video.videoHeight || Math.round(rect.height)
    };
    bestScore = score;
  }
  return best;
}

function getCandidateGroups() {
  const active = currentVideoInfo();
  const all = Array.from(candidates.values()).sort(compareVideoQuality);
  const activeKeys = new Set();
  if (active) {
    for (const url of active.urls) {
      const key = stableMediaKey(url);
      if (key) activeKeys.add(key);
    }
  }

  let primary = [];
  if (active) {
    const scored = all.map(item => ({ item, score: candidateAffinity(item, active) }));
    // 至少需要页面ID、共享媒体ID、规范化文件名等强证据。
    // 同站点 + 同宽高比 + DOM 距离这类弱证据不能单独把推荐视频混进当前列表。
    primary = scored
      .filter(x => x.score >= 2200)
      .sort((a, b) => (b.score - a.score) || compareVideoQuality(a.item, b.item))
      .map(x => x.item);

    if (!primary.length) {
      primary = all.filter(item => active.urls.has(item.url) || active.urls.has(item.resolvedUrl || ''));
    }
  } else {
    primary = all.slice(0, 4);
  }

  primary.sort(compareVideoQuality);
  const primaryUrls = new Set(primary.map(x => x.url));
  const extra = all.filter(x => !primaryUrls.has(x.url));
  return { active, activeKeys, primary, extra, all };
}

function penguinSvg() {
  return `<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true"><defs><linearGradient id="pdg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#37d6ff"/><stop offset="1" stop-color="#0867f2"/></linearGradient></defs><circle cx="16" cy="16" r="15" fill="url(#pdg)"/><path d="M8 18c0-7 3.4-12 8-12s8 5 8 12c0 5.1-3.6 8-8 8s-8-2.9-8-8Z" fill="#082757"/><ellipse cx="13.1" cy="14.1" rx="3.3" ry="4.5" fill="#fff"/><ellipse cx="18.9" cy="14.1" rx="3.3" ry="4.5" fill="#fff"/><circle cx="13.7" cy="14.4" r="1.2" fill="#0b1b35"/><circle cx="19.5" cy="14.4" r="1.2" fill="#0b1b35"/><path d="M13 18.1 16 16.6l3 1.5-3 2.2Z" fill="#ffb11b"/><path d="M16 21v6m0 0-3-3m3 3 3-3" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function formatBytes(value) {
  const n = Number(value) || 0;
  if (n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let x = n;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x >= 100 ? x.toFixed(0) : x.toFixed(1)} ${units[i]}`;
}

function upsertCandidate(item) {
  if (!item || !isHttpUrl(item.url)) return false;
  if (!isVideoUrl(item.url, item.contentType) && !item.probeOnly) return false;
  const prior = candidates.get(item.url) || {};
  candidates.set(item.url, {
    url: item.url,
    fileName: item.fileName || prior.fileName || guessedName(item.url),
    contentType: item.contentType || prior.contentType || '',
    contentLength: Number(item.contentLength || prior.contentLength || 0),
    sourcePage: item.sourcePage || prior.sourcePage || location.href,
    source: item.source || prior.source || 'page',
    time: Number(item.time || prior.time || Date.now()),
    title: cleanTitle(item.title) || prior.title || '',
    quality: item.quality || prior.quality || '',
    width: Number(item.width || prior.width || 0),
    height: Number(item.height || prior.height || 0),
    fps: Number(item.fps || prior.fps || 0),
    resolvedUrl: item.resolvedUrl || prior.resolvedUrl || '',
    assetKey: item.assetKey || prior.assetKey || '',
    scope: item.scope || prior.scope || '',
    probeOnly: Boolean(item.probeOnly || prior.probeOnly)
  });
  return true;
}

function collectResources() {
  const urls = new Set();
  const add = u => {
    try {
      const x = new URL(u, location.href);
      if (/^https?:$/.test(x.protocol)) urls.add(x.href);
    } catch (_) {}
  };

  document.querySelectorAll('a[href]').forEach(x => add(x.href));
  document.querySelectorAll('source[src],video[src],audio[src]').forEach(x => add(x.currentSrc || x.src));
  document.querySelectorAll('video,audio').forEach(x => add(x.currentSrc));

  try {
    performance.getEntriesByType('resource').forEach(x => add(x.name));
  } catch (_) {}

  return {
    url: location.href,
    title: document.title,
    resources: Array.from(urls).slice(0, 500)
  };
}

function collectDomVideos() {
  let added = false;
  document.querySelectorAll('video').forEach(video => {
    const title = findNearbyTitle(video);
    const urls = [];
    if (video.currentSrc) urls.push({ url: video.currentSrc, type: video.getAttribute('type') || '' });
    if (video.src) urls.push({ url: video.src, type: video.getAttribute('type') || '' });
    video.querySelectorAll('source[src]').forEach(source => {
      urls.push({ url: source.src, type: source.type || '' });
    });
    for (const x of urls) {
      if (upsertCandidate({
        url: x.url,
        fileName: guessedName(x.url),
        contentType: x.type,
        sourcePage: location.href,
        source: 'video-element',
        title,
        time: Date.now()
      })) added = true;
    }
  });
  return added;
}

function collectEmbeddedVideoCandidates() {
  let added = false;
  const active = currentVideoInfo();
  const title = active?.title || pageTitle();

  const addUrl = (raw, scope = '', hint = '') => {
    if (!raw) return;
    let value = String(raw)
      .replace(/\\u002[fF]/g, '/')
      .replace(/\\u003[aA]/g, ':')
      .replace(/\\\//g, '/')
      .replace(/&amp;/g, '&');
    try { value = new URL(value, location.href).href; } catch (_) { return; }
    if (!isHttpUrl(value)) return;

    const clue = `${hint} ${value}`;
    const looksOriginal = /(original|source|master|raw|download|原始|原文件|最高画质|下载)/i.test(clue);
    const probeOnly = !isVideoUrl(value, '') && scope === 'near-active' && looksOriginal;
    if (!isVideoUrl(value, '') && !probeOnly) return;

    let quality = '';
    if (/(original|source|master|raw|原始|原文件|最高画质)/i.test(clue)) quality = 'original';
    else if (/(4k|2160|uhd)/i.test(clue)) quality = '4k';
    else if (/(1440|2k|qhd)/i.test(clue)) quality = '2k';
    else if (/(1080|fhd|fullhd)/i.test(clue)) quality = '1080p';
    else if (/(720|\bhd\b)/i.test(clue)) quality = '720p';

    if (upsertCandidate({
      url: value,
      fileName: guessedName(value),
      contentType: '',
      sourcePage: location.href,
      source: scope === 'near-active' ? 'near-active-page-link' : 'embedded-page-data',
      scope,
      quality,
      probeOnly,
      title,
      time: Date.now()
    })) added = true;
  };

  // 通用第一优先级：只在用户点击悬浮入口后，从当前播放器向上找有限层级，
  // 收集它附近的下载按钮/高清链接/data-url。这个关系比“同页最近请求”可靠得多。
  let node = active?.video?.parentElement || null;
  for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
    node.querySelectorAll?.('a[href],source[src],[data-src],[data-video-url],[data-download-url],[data-url]').forEach(el => {
      const raw = el.href || el.src || el.getAttribute('data-src') || el.getAttribute('data-video-url') || el.getAttribute('data-download-url') || el.getAttribute('data-url');
      const hint = `${el.textContent || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('download') || ''}`;
      addUrl(raw, 'near-active', hint);
    });
  }

  // 第二层：页面公开的媒体地址，靠媒体指纹再和当前视频做关联，不直接全部展示。
  document.querySelectorAll('a[href],source[src],[data-src],[data-video-url],[data-download-url]').forEach(el => {
    const raw = el.href || el.src || el.getAttribute('data-src') || el.getAttribute('data-video-url') || el.getAttribute('data-download-url');
    const hint = `${el.textContent || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('aria-label') || ''}`;
    addUrl(raw, '', hint);
  });

  // 第三层：React/Next/Vue 等公开页面状态里的直链。限制扫描体积和候选数，避免拖慢网页。
  let budget = 2_000_000;
  for (const script of document.scripts) {
    if (budget <= 0) break;
    const raw = script.textContent || '';
    if (!raw || !/(?:\.mp4|\.webm|\.mov|\.mkv|video|media)/i.test(raw)) continue;
    const text = raw.slice(0, Math.min(raw.length, budget))
      .replace(/\\u002[fF]/g, '/')
      .replace(/\\u003[aA]/g, ':')
      .replace(/\\\//g, '/');
    budget -= text.length;
    const matches = text.match(/https?:\/\/[^"'\s<>]+?\.(?:mp4|webm|mov|mkv)(?:\?[^"'\s<>]*)?/ig) || [];
    for (const url of matches.slice(0, 120)) addUrl(url);
  }
  return added;
}

function derivePexelsVideoId(active) {
  // 官方下载接口使用的是页面 video_id，所以在 Pexels 页面上先从地址栏取 ID。
  if (/(^|\.)pexels\.com$/i.test(location.hostname)) {
    const page = /\/video\/(?:[^/]*-)?(\d{5,})\/?$/i.exec(location.pathname);
    if (page) return page[1];
  }

  const urls = [];
  if (active?.urls) urls.push(...active.urls);
  for (const item of candidates.values()) urls.push(item.url, item.resolvedUrl || '');

  // Pexels CDN 示例：/video-files/34788277/14749667_360_640_60fps.mp4
  // 真正的 Pexels video id 是文件名前缀 14749667，不是目录 34788277。
  for (const raw of urls) {
    const text = String(raw || '');
    const fileId = /\/(\d{5,})_(?:\d{3,4})_(?:\d{3,4})(?:_\d{2,3}fps)?\.(?:mp4|webm)(?:[?#]|$)/i.exec(text);
    if (fileId) return fileId[1];
  }

  // 仅在页面/文件名都拿不到正式 video id 时才退回 CDN 目录 id。
  for (const raw of urls) {
    const folderId = /\/video-files\/(\d{5,})\//i.exec(String(raw || ''));
    if (folderId) return folderId[1];
  }
  return '';
}

function addSiteOriginalCandidate(active = currentVideoInfo()) {
  const id = derivePexelsVideoId(active);
  if (!id) return null;

  const url = `https://www.pexels.com/download/video/${id}/`;
  const activeKey = active?.urls ? Array.from(active.urls).map(stableMediaKey).find(Boolean) || '' : '';
  upsertCandidate({
    url,
    fileName: `pexels-${id}-original.mp4`,
    contentType: 'video/mp4',
    sourcePage: location.href,
    source: 'site-original-download',
    quality: 'original',
    assetKey: activeKey,
    title: active?.title || pageTitle(),
    time: Date.now()
  });
  return candidates.get(url) || null;
}

async function probeOriginalCandidate(item) {
  if (!item?.url) return;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'probe-url', url: item.url });
    if (!result?.ok) return;
    const current = candidates.get(item.url);
    if (!current) return;
    const finalUrl = String(result.finalUrl || '');
    const finalType = String(result.contentType || '');
    const verifiedMedia = isVideoUrl(finalUrl, finalType);
    if (current.probeOnly && !verifiedMedia) {
      candidates.delete(item.url);
      return;
    }
    if (Number(result.contentLength) > 0) current.contentLength = Number(result.contentLength);
    if (finalUrl) current.resolvedUrl = finalUrl;
    if (finalType) current.contentType = finalType;
    if (result.fileName && /\.(mp4|webm|mov|mkv)$/i.test(result.fileName)) current.fileName = result.fileName;
    current.probeOnly = false;
  } catch (_) {}
}

async function prepareManualVideoChoices() {
  collectDomVideos();
  collectEmbeddedVideoCandidates();
  await refreshNetworkCandidates();

  // 站点专用适配器只能作为补充，通用主链仍然依赖当前播放器 + DOM/网络/页面状态候选。
  const adapterOriginal = addSiteOriginalCandidate(currentVideoInfo());
  const groups = getCandidateGroups();
  const unique = new Map();
  if (adapterOriginal) unique.set(adapterOriginal.url, adapterOriginal);
  for (const item of groups.primary) {
    if (!isPlaylist(item.url, item.contentType)) unique.set(item.url, item);
    if (unique.size >= 8) break;
  }
  await Promise.all(Array.from(unique.values()).map(probeOriginalCandidate));
}

async function refreshNetworkCandidates() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'sniffed' });
    const items = Array.isArray(response?.items) ? response.items : [];
    let changed = false;
    for (const item of items) {
      if (upsertCandidate(item)) changed = true;
    }
    if (changed || candidates.size) ensureFloatingButton();
    updateLauncher();
  } catch (_) {}
}

function bestVisibleVideo() {
  let best = null;
  let bestArea = 0;
  document.querySelectorAll('video').forEach(video => {
    const r = video.getBoundingClientRect();
    const visibleW = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    const visibleH = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    const area = visibleW * visibleH;
    if (area > bestArea && visibleW >= 160 && visibleH >= 90) {
      best = r;
      bestArea = area;
    }
  });
  return best;
}

function schedulePosition() {
  if (positionQueued) return;
  positionQueued = true;
  requestAnimationFrame(() => {
    positionQueued = false;
    positionFloatingButton();
    if (panel?.isConnected && !manualPanelPosition) positionPanel();
  });
}

function positionFloatingButton() {
  if (!floatingButton?.isConnected) return;
  const active = currentVideoInfo();
  const width = floatingButton.offsetWidth || 138;
  const height = floatingButton.offsetHeight || 40;
  const gap = 10;
  let left = innerWidth - width - 14;
  let top = 14;
  let outside = false;

  if (active) {
    const r = active.rect;
    if (innerWidth - r.right >= width + gap + 8) {
      left = r.right + gap;
      top = Math.max(10, Math.min(innerHeight - height - 10, r.top + 10));
      outside = true;
    } else if (r.top >= height + gap + 4) {
      left = Math.max(10, Math.min(innerWidth - width - 10, r.right - width));
      top = r.top - height - gap;
      outside = true;
    } else if (innerHeight - r.bottom >= height + gap + 4) {
      left = Math.max(10, Math.min(innerWidth - width - 10, r.right - width));
      top = r.bottom + gap;
      outside = true;
    } else {
      left = innerWidth - width - 8;
      top = Math.max(8, Math.min(innerHeight - height - 8, r.top + 8));
    }
  }

  floatingButton.style.opacity = outside || !active ? '1' : '.72';
  floatingButton.style.left = `${Math.round(left)}px`;
  floatingButton.style.top = `${Math.round(top)}px`;
  floatingButton.style.right = 'auto';
  floatingButton.style.bottom = 'auto';
}

function ensureFloatingButton() {
  if (floatingButton?.isConnected) {
    updateLauncher();
    schedulePosition();
    return;
  }

  floatingButton = document.createElement('button');
  floatingButton.id = PENGUIN_FLOAT_ID;
  floatingButton.type = 'button';
  floatingButton.setAttribute('aria-label', 'Penguin Downloader 选择视频');
  floatingButton.title = 'Penguin Downloader：选择当前视频';
  Object.assign(floatingButton.style, {
    position: 'fixed', zIndex: '2147483647', height: '40px', minWidth: '132px', maxWidth: '176px',
    borderRadius: '12px', border: '1px solid rgba(50,130,230,.5)',
    background: 'rgba(17,27,43,.96)', color: '#f7fbff', boxShadow: '0 8px 24px rgba(0,0,0,.24)',
    cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '7px', padding: '5px 9px 5px 6px',
    font: '600 13px/1 Segoe UI, Microsoft YaHei, sans-serif', userSelect: 'none',
    transition: 'opacity .15s ease, transform .15s ease'
  });

  floatingButton.innerHTML = `<span style="width:28px;height:28px;display:flex;align-items:center;justify-content:center;flex:none">${penguinSvg()}</span><span data-penguin-label style="white-space:nowrap">选择视频</span><span data-penguin-badge style="margin-left:auto;min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:#1e95ff;color:#fff;font:700 11px/20px Segoe UI;text-align:center;box-sizing:border-box">0</span>`;

  floatingButton.addEventListener('mouseenter', () => { floatingButton.style.transform = 'translateY(-1px)'; floatingButton.style.opacity = '1'; });
  floatingButton.addEventListener('mouseleave', () => { floatingButton.style.transform = 'none'; schedulePosition(); });
  floatingButton.addEventListener('click', async e => {
    e.preventDefault();
    e.stopPropagation();
    panelActivationRequested = true;
    await prepareManualVideoChoices();
    togglePanel();
  }, true);

  document.documentElement.appendChild(floatingButton);
  updateLauncher();
  schedulePosition();
}

function updateLauncher() {
  if (!floatingButton) return;
  const groups = getCandidateGroups();
  const count = groups.primary.length || Math.min(4, groups.all.length);
  const badge = floatingButton.querySelector('[data-penguin-badge]');
  const label = floatingButton.querySelector('[data-penguin-label]');
  if (badge) badge.textContent = String(Math.min(99, count));
  if (label) label.textContent = groups.active ? '选择当前视频' : '选择视频';
}

function closePanel(resetActivation = true) {
  if (panel?.isConnected) panel.remove();
  panel = null;
  manualPanelPosition = null;
  if (resetActivation) panelActivationRequested = false;
}

function positionPanel() {
  if (!panel?.isConnected || manualPanelPosition) return;
  const buttonRect = floatingButton?.getBoundingClientRect();
  const width = panel.offsetWidth || 420;
  const height = panel.offsetHeight || 440;
  const gap = 10;
  let left = Math.max(8, innerWidth - width - 8);
  let top = Math.max(8, buttonRect?.top || 18);

  if (buttonRect) {
    if (buttonRect.right + gap + width <= innerWidth - 8) left = buttonRect.right + gap;
    else if (buttonRect.left - gap - width >= 8) left = buttonRect.left - gap - width;
    else left = Math.max(8, Math.min(innerWidth - width - 8, buttonRect.left));
    top = Math.max(8, Math.min(innerHeight - height - 8, buttonRect.top));
  }

  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
}

function makeDraggable(handle) {
  let start = null;
  handle.style.cursor = 'move';
  handle.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const r = panel.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
    handle.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  handle.addEventListener('pointermove', e => {
    if (!start || !panel?.isConnected) return;
    const left = Math.max(6, Math.min(innerWidth - panel.offsetWidth - 6, start.left + e.clientX - start.x));
    const top = Math.max(6, Math.min(innerHeight - panel.offsetHeight - 6, start.top + e.clientY - start.y));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    manualPanelPosition = { left, top };
  });
  const stop = () => { start = null; };
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
}

function togglePanel() {
  if (panel?.isConnected) {
    closePanel();
    return;
  }
  buildPanel();
}

function buildPanel() {
  if (!panelActivationRequested) return;
  closePanel(false);
  const groups = getCandidateGroups();
  panel = document.createElement('div');
  panel.id = PENGUIN_PANEL_ID;
  Object.assign(panel.style, {
    position: 'fixed',
    zIndex: '2147483647',
    width: 'min(420px, calc(100vw - 24px))',
    maxHeight: 'min(520px, calc(100vh - 110px))',
    overflow: 'hidden',
    borderRadius: '16px',
    border: '1px solid rgba(120,160,210,.38)',
    background: 'rgba(20,28,40,.97)',
    color: '#f5f8ff',
    boxShadow: '0 18px 55px rgba(0,0,0,.38)',
    font: '13px/1.35 Segoe UI, Microsoft YaHei, sans-serif'
  });

  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 14px',
    borderBottom: '1px solid rgba(255,255,255,.09)'
  });
  const currentTitle = document.createElement('strong');
  currentTitle.style.fontSize = '14px';
  currentTitle.style.maxWidth = '265px';
  currentTitle.style.overflow = 'hidden';
  currentTitle.style.textOverflow = 'ellipsis';
  currentTitle.style.whiteSpace = 'nowrap';
  currentTitle.textContent = groups.active?.title || pageTitle();
  currentTitle.title = currentTitle.textContent;
  const currentHint = document.createElement('span');
  currentHint.style.opacity = '.62';
  currentHint.style.fontSize = '11px';
  currentHint.textContent = '当前视频 · 可拖动';
  header.append(currentTitle, currentHint);
  const x = document.createElement('button');
  x.textContent = '×';
  Object.assign(x.style, { marginLeft: 'auto', border: '0', background: 'transparent', color: '#fff', fontSize: '22px', cursor: 'pointer' });
  x.onclick = closePanel;
  header.appendChild(x);
  panel.appendChild(header);
  makeDraggable(header);

  const body = document.createElement('div');
  Object.assign(body.style, { maxHeight: '360px', overflow: 'auto', padding: '8px 10px' });

  const list = groups.primary;

  if (!list.length) {
    const empty = document.createElement('div');
    empty.textContent = '暂时没有发现可下载的视频直链。';
    empty.style.padding = '18px 10px';
    body.appendChild(empty);
  } else {
    list.forEach((item, index) => {
      const playlist = isPlaylist(item.url, item.contentType);
      const row = document.createElement('label');
      Object.assign(row.style, {
        display: 'grid', gridTemplateColumns: '22px 1fr', gap: '8px',
        padding: '9px 7px', borderBottom: '1px solid rgba(255,255,255,.07)',
        cursor: playlist ? 'not-allowed' : 'pointer', opacity: playlist ? '.58' : '1'
      });
      const check = document.createElement('input');
      check.type = 'radio';
      check.name = 'penguin-video-choice';
      check.dataset.penguinUrl = item.url;
      check.disabled = playlist;
      check.checked = !playlist && index === 0;
      check.style.marginTop = '4px';
      row.appendChild(check);

      const info = document.createElement('div');
      const name = document.createElement('div');
      const exactCurrent = groups.active?.urls?.has(item.url);
      const itemKey = item.assetKey || stableMediaKey(item.url);
      const sameAsset = !!itemKey && groups.activeKeys?.has(itemKey);
      name.textContent = (sameAsset ? groups.active?.title : '') || cleanTitle(item.title) || pageTitle();
      name.title = name.textContent;
      Object.assign(name.style, { fontWeight: '600', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
      const meta = document.createElement('div');
      const affinity = groups.active ? candidateAffinity(item, groups.active) : 0;
      const currentPageMatch = affinity >= 5000;
      const qualityPrefix = item.source === 'site-original-download' && !playlist
        ? '当前页面原始文件 · '
        : index === 0 && currentPageMatch && !playlist
          ? '★ 当前页面视频 · 最高画质 · '
          : exactCurrent && !playlist
            ? '当前播放源 · '
            : currentPageMatch && !playlist ? '当前页面视频 · ' : '';
      meta.textContent = playlist
        ? '分段流播放清单 · 已识别，当前版本暂不做分段合并'
        : `${qualityPrefix}${mediaMeta(item) || item.contentType || '网页视频'}`;
      Object.assign(meta.style, { opacity: '.7', marginTop: '3px', fontSize: '12px' });
      const url = document.createElement('div');
      url.textContent = item.resolvedUrl || item.url;
      Object.assign(url.style, { opacity: '.48', marginTop: '3px', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
      info.append(name, meta, url);
      row.appendChild(info);
      body.appendChild(row);
    });
    if (groups.extra.length) {
      const hidden = document.createElement('div');
      hidden.textContent = `已自动隐藏其他 ${groups.extra.length} 个非当前视频资源`;
      Object.assign(hidden.style, { padding: '9px 7px 6px', opacity: '.52', fontSize: '11px', textAlign: 'center' });
      body.appendChild(hidden);
    }
  }
  panel.appendChild(body);

  const footer = document.createElement('div');
  Object.assign(footer.style, {
    display: 'flex', alignItems: 'center', gap: '8px', padding: '11px 12px',
    borderTop: '1px solid rgba(255,255,255,.09)'
  });
  const hint = document.createElement('span');
  hint.textContent = '默认只勾选最可能对应当前画面的视频。';
  Object.assign(hint.style, { opacity: '.6', fontSize: '11px', flex: '1' });
  const download = document.createElement('button');
  download.textContent = '下载选中';
  Object.assign(download.style, {
    border: '0', borderRadius: '10px', padding: '8px 15px', cursor: 'pointer',
    background: 'linear-gradient(145deg,#34c6ff,#0877f9)', color: '#fff', fontWeight: '700'
  });
  download.onclick = async () => {
    const selected = Array.from(panel.querySelectorAll('input[data-penguin-url]:checked'));
    if (!selected.length) {
      download.textContent = '请先选择';
      setTimeout(() => { if (download) download.textContent = '下载选中'; }, 1200);
      return;
    }
    download.disabled = true;
    download.textContent = `发送 ${selected.length} 项…`;
    let ok = 0;
    for (const input of selected) {
      const item = candidates.get(input.dataset.penguinUrl);
      if (!item) continue;
      try {
        const sendUrl = item.resolvedUrl || item.url;
        const result = await chrome.runtime.sendMessage({
          type: 'send',
          url: sendUrl,
          filename: item.fileName || guessedName(sendUrl),
          referrer: item.sourcePage || location.href,
          sourcePage: location.href,
          contentType: item.contentType || '',
          trigger: 'video-picker'
        });
        if (result?.ok) ok++;
        else if (result?.error) download.dataset.lastError = String(result.error);
      } catch (error) {
        download.dataset.lastError = String(error?.message || '下载器未响应');
      }
    }
    if (ok) {
      download.textContent = `已发送 ${ok} 项`;
    } else {
      const error = download.dataset.lastError || '请先启动 Penguin Downloader 3.0';
      download.textContent = error.includes('启动') ? '请先启动下载器' : '发送失败';
      download.title = error;
    }
    setTimeout(() => closePanel(), ok ? 900 : 1800);
  };
  footer.append(hint, download);
  panel.appendChild(footer);
  document.documentElement.appendChild(panel);
  requestAnimationFrame(positionPanel);
}

function scanAndRefresh() {
  const domAdded = collectDomVideos();
  if (domAdded || candidates.size) {
    ensureFloatingButton();
    updateLauncher();
  }
  // 被动状态只做轻量嗅探；页面 JSON/官方下载源等深度解析只在用户点击悬浮入口时执行。
  refreshNetworkCandidates();
}

const observer = new MutationObserver(mutations => {
  let relevant = false;
  for (const mutation of mutations) {
    if (mutation.type === 'attributes') { relevant = true; break; }
    for (const node of mutation.addedNodes || []) {
      if (node.nodeType === 1 && (node.matches?.('video,source') || node.querySelector?.('video,source'))) {
        relevant = true;
        break;
      }
    }
    if (relevant) break;
  }
  if (relevant) scanAndRefresh();
});

observer.observe(document.documentElement, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ['src']
});

addEventListener('scroll', schedulePosition, { passive: true, capture: true });
addEventListener('resize', schedulePosition, { passive: true });

document.addEventListener('play', e => {
  if (e.target instanceof HTMLVideoElement) {
    lastVideoInteractionAt = Date.now();
    lastInteractedVideo = e.target;
    scanAndRefresh();
  }
}, true);

document.addEventListener('pointerdown', e => {
  const video = e.target instanceof HTMLVideoElement ? e.target : e.target?.closest?.('video');
  if (video instanceof HTMLVideoElement) {
    lastVideoInteractionAt = Date.now();
    lastInteractedVideo = video;
    schedulePosition();
  }
}, true);

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.type === 'collect') {
    respond(collectResources());
    return;
  }
  if (msg?.type === 'sniff-update') {
    if (msg.item) upsertCandidate(msg.item);
    ensureFloatingButton();
    updateLauncher();
    schedulePosition();
    respond?.({ ok: true });
  }
});

scanAndRefresh();
