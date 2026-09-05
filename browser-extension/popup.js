const statusEl = document.getElementById('status');
const listEl = document.getElementById('list');
const intercept = document.getElementById('intercept');
let pageData = null;
let activeTab = null;

async function ping() {
  const r = await chrome.runtime.sendMessage({ type: 'ping' });
  statusEl.textContent = r?.ok ? 'Penguin Downloader 3.0 Turbo 已连接 · 网络嗅探可用' : '未连接：请先启动 Penguin Downloader 3.0 Turbo';
  statusEl.className = 'status ' + (r?.ok ? 'ok' : 'bad');
}

async function collect() {
  listEl.innerHTML = '<div class="item">正在检测页面链接与真实网络资源…</div>';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;
  if (!tab?.id) return;

  try {
    pageData = await chrome.tabs.sendMessage(tab.id, { type: 'collect' });
  } catch (_) {
    pageData = { url: tab.url || '', title: tab.title || '', resources: [] };
  }

  let sniffed = [];
  try {
    const response = await chrome.runtime.sendMessage({ type: 'sniffed', tabId: tab.id });
    sniffed = response?.items || [];
  } catch (_) {}

  const merged = new Map();
  for (const x of sniffed) merged.set(x.url, x);
  for (const url of (pageData.resources || [])) {
    if (!merged.has(url)) merged.set(url, { url, fileName: guessName(url), contentType: '', source: 'page', time: 0 });
  }
  render(Array.from(merged.values()));
}

function guessName(url) {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop()) || '资源'; } catch (_) { return '资源'; }
}

function interesting(item) {
  const url = item.url || '';
  const type = String(item.contentType || '').toLowerCase();
  return item.source === 'network' || /\.(zip|7z|rar|exe|msi|iso|img|tar|gz|bz2|xz|pdf|mp4|mkv|mov|webm|mp3|wav|flac|aac|m4a|ogg|bin|gguf|safetensors|onnx|dmg|pkg|apk|m3u8|mpd)(\?|#|$)/i.test(url) || type.startsWith('video/') || type.startsWith('audio/');
}

function render(items) {
  listEl.innerHTML = '';
  const preferred = items.filter(interesting);
  const shown = (preferred.length ? preferred : items).slice(0, 200);
  if (!shown.length) {
    listEl.innerHTML = '<div class="item">当前页面没有发现可直接下载的 HTTP/HTTPS 资源。</div>';
    return;
  }

  for (const item of shown) {
    const url = item.url;
    const name = item.fileName || guessName(url);
    const sourceLabel = item.source === 'network' ? '网络嗅探' : '页面链接';
    const typeLabel = item.contentType ? ` · ${item.contentType.split(';')[0]}` : '';
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `<div class="row"><div class="name" title="${escapeHtml(name)}">${escapeHtml(name)}</div><button>下载</button></div><div class="url" title="${escapeHtml(url)}">${escapeHtml(url)}</div><div class="url">${escapeHtml(sourceLabel + typeLabel)}</div>`;
    div.querySelector('button').onclick = async () => {
      const button = div.querySelector('button');
      button.textContent = '发送中';
      const r = await chrome.runtime.sendMessage({
        type: 'send',
        url,
        filename: name,
        referrer: pageData?.url || activeTab?.url || '',
        sourcePage: pageData?.url || activeTab?.url || '',
        contentType: item.contentType || ''
      });
      button.textContent = r?.ok ? '已发送' : '失败';
      if (!r?.ok) button.title = r?.error || '发送失败';
    };
    listEl.appendChild(div);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

document.getElementById('refresh').onclick = collect;
document.getElementById('page').onclick = async () => {
  if (!pageData) await collect();
  if (pageData?.url) await chrome.runtime.sendMessage({
    type: 'send', url: pageData.url, filename: '', referrer: pageData.url, sourcePage: pageData.url
  });
};

chrome.storage.local.get(['intercept']).then(x => intercept.checked = x.intercept !== false);
intercept.onchange = () => chrome.storage.local.set({ intercept: intercept.checked });
ping();
collect();
