// ============ DOM refs ============
const $ = id => document.getElementById(id);

const photosInput = $('photos');
const dropZone = $('dropZone');
const previewsEl = $('previews');
const generateBtn = $('generateBtn');
const cancelBtn = $('cancelBtn');
const statusEl = $('status');
const progressWrap = $('progressWrap');
const progressFill = $('progressFill');
const progressText = $('progressText');
const resultsEl = $('results');
const countSlider = $('countSlider');
const countValue = $('countValue');
const btnCount = $('btnCount');
const countEta = $('countEta');
const poolSize = $('poolSize');
const filterHint = $('filterHint');
const topBar = $('topBar');
const topBarStatus = $('topBarStatus');
const nameInput = $('nameInput');
const nameEnInput = $('nameEnInput');

// Customer pill / dropdown
const customerPill = $('customerPill');
const cpAvatar = $('cpAvatar');
const cpName = $('cpName');
const customerDropdown = $('customerDropdown');
const cdSearch = $('cdSearch');
const cdList = $('cdList');
const cdNewName = $('cdNewName');
const cdNewNameEn = $('cdNewNameEn');
const cdCreateBtn = $('cdCreateBtn');

// Lightbox
const lightbox = $('lightbox');
const lbImg = $('lbImg');
const lbClose = $('lbClose');
const lbPrev = $('lbPrev');
const lbNext = $('lbNext');
const lbIndex = $('lbIndex');
const lbRef = $('lbRef');
const lbFav = $('lbFav');
const lbDownload = $('lbDownload');

const toast = $('toast');

const CONCURRENCY = 3;
const SECONDS_PER_IMAGE = 45;

// ============ state ============
let selectedFiles = [];
let currentCustomer = null;           // {id, name, nameEn, photos: [...], favoriteRefIds: [...]} 或 null
let filters = { gender: '', vibe: '', tone: '', age: '' };
let activeController = null;
let activeSessionId = null;
let resultItems = [];                 // [{index, url, refName, refId, file}]
let lightboxIndex = 0;
let allCustomers = [];                // 缓存的客户列表
let activeFavRefs = new Set();        // 当前客户的 favoriteRefIds（用于实时高亮）

// ============ helpers ============
function showToast(msg, type = '') {
  toast.textContent = msg;
  toast.className = 'toast';
  if (type) toast.classList.add(type);
  toast.removeAttribute('hidden');
  requestAnimationFrame(() => toast.classList.add('show'));
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.setAttribute('hidden', ''), 250);
  }, 2400);
}

function initials(name) {
  if (!name) return '?';
  return name.trim().slice(0, 1);
}

// ============ top bar visibility on scroll ============
window.addEventListener('scroll', () => {
  if (window.scrollY > 220) topBar.classList.add('visible');
  else topBar.classList.remove('visible');
});

// ============ count slider ============
function updateCountUI() {
  const n = parseInt(countSlider.value, 10);
  countValue.textContent = n;
  btnCount.textContent = n;
  const seconds = Math.ceil(n / CONCURRENCY) * SECONDS_PER_IMAGE;
  const mins = Math.max(1, Math.round(seconds / 60));
  countEta.textContent = `≈ ${mins} 分钟`;
}
countSlider.addEventListener('input', () => { updateCountUI(); updatePoolSize(); });
updateCountUI();

// ============ filter chips ============
document.querySelectorAll('.chip-group').forEach(grp => {
  const group = grp.dataset.group;
  grp.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      grp.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      filters[group] = chip.dataset.value;
      updatePoolSize();
    });
  });
});

// ============ pool size ============
let poolFetchTimer = null;
async function updatePoolSize() {
  clearTimeout(poolFetchTimer);
  poolFetchTimer = setTimeout(async () => {
    const params = new URLSearchParams();
    if (filters.gender) params.set('gender', filters.gender);
    if (filters.vibe) params.set('vibe', filters.vibe);
    if (filters.tone) params.set('tone', filters.tone);
    if (filters.age) params.set('age', filters.age);
    try {
      const r = await fetch('/api/refs/count?' + params.toString());
      const d = await r.json();
      const requested = parseInt(countSlider.value, 10);
      poolSize.textContent = `符合 ${d.filtered} / ${d.total} 张`;
      poolSize.classList.remove('warn', 'bad');
      filterHint.textContent = '';
      if (d.filtered === 0) {
        poolSize.classList.add('bad');
        filterHint.textContent = '当前筛选无结果，将回退到全库随机';
      } else if (d.filtered < requested) {
        poolSize.classList.add('warn');
        filterHint.textContent = `池子 (${d.filtered}) 少于请求 (${requested})，将回退到全库随机`;
      }
    } catch {}
  }, 150);
}
updatePoolSize();

// ============ photo upload ============
function updatePreviews() {
  previewsEl.innerHTML = '';
  selectedFiles.forEach((file, idx) => {
    const item = document.createElement('div');
    item.className = 'preview-item';
    if (file._fromCustomer) item.classList.add('from-customer');
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    item.appendChild(img);
    const btn = document.createElement('button');
    btn.className = 'remove';
    btn.textContent = '×';
    btn.title = '移除';
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectedFiles.splice(idx, 1);
      updatePreviews();
      updateButton();
    };
    item.appendChild(btn);
    previewsEl.appendChild(item);
  });
  dropZone.classList.toggle('has-photos', selectedFiles.length > 0);
}

function updateButton() {
  const has = selectedFiles.length > 0;
  generateBtn.disabled = !has;
  statusEl.textContent = has ? `已选 ${selectedFiles.length} 张人像，准备生成` : '请先上传客户人像';
  topBarStatus.textContent = has ? `${selectedFiles.length} 张已选` : '';
}

function addFiles(files) {
  const valid = Array.from(files).filter(f => f.type.startsWith('image/'));
  selectedFiles = [...selectedFiles, ...valid].slice(0, 3);
  updatePreviews();
  updateButton();
}

photosInput.addEventListener('change', (e) => {
  addFiles(e.target.files);
  photosInput.value = '';
});

['dragenter', 'dragover'].forEach(evt => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach(evt => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
  });
});
dropZone.addEventListener('drop', (e) => {
  if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});

// ============ customer pill / dropdown ============
async function fetchCustomers() {
  try {
    const r = await fetch('/api/customers');
    allCustomers = await r.json();
  } catch {
    allCustomers = [];
  }
  renderCustomerList();
}

function renderCustomerList(filter = '') {
  cdList.innerHTML = '';

  // Guest option always on top
  const guestItem = document.createElement('div');
  guestItem.className = 'cd-item guest';
  guestItem.innerHTML = `
    <div class="cd-avatar">+</div>
    <div class="cd-text">
      <div class="cd-name">新客户 / 不归档</div>
      <div class="cd-sub">不保存历史，纯一次性生成</div>
    </div>
  `;
  guestItem.onclick = () => selectCustomer(null);
  cdList.appendChild(guestItem);

  const f = filter.toLowerCase();
  const filtered = allCustomers.filter(c => {
    if (!f) return true;
    return (c.name || '').toLowerCase().includes(f) ||
           (c.nameEn || '').toLowerCase().includes(f) ||
           c.id.toLowerCase().includes(f);
  });

  for (const c of filtered) {
    const item = document.createElement('div');
    item.className = 'cd-item';
    const subParts = [];
    if (c.photoCount) subParts.push(`${c.photoCount} 张照片`);
    if (c.favoriteCount) subParts.push(`${c.favoriteCount} 收藏`);
    if (c.lastVisit) subParts.push(`最近 ${c.lastVisit}`);
    item.innerHTML = `
      <div class="cd-avatar">${initials(c.nameEn || c.name)}</div>
      <div class="cd-text">
        <div class="cd-name">${c.name}${c.nameEn ? ' · ' + c.nameEn : ''}</div>
        <div class="cd-sub">${subParts.join(' · ') || '新建客户'}</div>
      </div>
      <div class="cd-tag">${c.id}</div>
    `;
    item.onclick = () => selectCustomer(c.id);
    cdList.appendChild(item);
  }
}

customerPill.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = !customerPill.classList.contains('active');
  customerPill.classList.toggle('active', open);
  customerDropdown.hidden = !open;
  if (open) {
    fetchCustomers();
    setTimeout(() => cdSearch.focus(), 60);
  }
});
document.addEventListener('click', (e) => {
  if (customerDropdown.hidden) return;
  if (e.target.closest('.customer-bar')) return;
  customerPill.classList.remove('active');
  customerDropdown.hidden = true;
});
cdSearch.addEventListener('input', (e) => renderCustomerList(e.target.value));
cdNewName.addEventListener('input', () => { cdCreateBtn.disabled = !cdNewName.value.trim(); });
cdCreateBtn.disabled = true;
cdCreateBtn.addEventListener('click', async () => {
  const name = cdNewName.value.trim();
  if (!name) return;
  const nameEn = cdNewNameEn.value.trim();
  cdCreateBtn.disabled = true;
  try {
    const r = await fetch('/api/customers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, nameEn }),
    });
    const c = await r.json();
    if (!r.ok) throw new Error(c.error || '创建失败');
    cdNewName.value = '';
    cdNewNameEn.value = '';
    await fetchCustomers();
    selectCustomer(c.id);
    showToast(`✓ 已创建客户 ${c.name}`, 'success');
  } catch (e) {
    showToast('✗ ' + e.message, 'error');
    cdCreateBtn.disabled = false;
  }
});

async function selectCustomer(slug) {
  // close dropdown
  customerPill.classList.remove('active');
  customerDropdown.hidden = true;

  if (!slug) {
    currentCustomer = null;
    activeFavRefs = new Set();
    cpAvatar.textContent = '+';
    cpAvatar.classList.add('guest');
    cpName.textContent = '新客户 / 不归档';
    nameInput.value = '';
    nameEnInput.value = '';
    selectedFiles = selectedFiles.filter(f => !f._fromCustomer);
    updatePreviews(); updateButton();
    return;
  }
  try {
    const r = await fetch(`/api/customers/${encodeURIComponent(slug)}`);
    if (!r.ok) throw new Error('未找到客户');
    currentCustomer = await r.json();
    activeFavRefs = new Set((currentCustomer.favoriteRefIds || []).map(String));

    cpAvatar.classList.remove('guest');
    cpAvatar.textContent = initials(currentCustomer.nameEn || currentCustomer.name);
    cpName.textContent = `${currentCustomer.name}${currentCustomer.nameEn ? ' · ' + currentCustomer.nameEn : ''}`;
    nameInput.value = currentCustomer.name || '';
    nameEnInput.value = currentCustomer.nameEn || '';

    // 移除上次客户带的照片，然后加载新客户的
    selectedFiles = selectedFiles.filter(f => !f._fromCustomer);
    for (const ph of (currentCustomer.photos || []).slice(0, 3 - selectedFiles.length)) {
      try {
        const resp = await fetch(ph.url);
        const blob = await resp.blob();
        const file = new File([blob], ph.filename, { type: blob.type });
        file._fromCustomer = true;
        selectedFiles.push(file);
      } catch {}
    }
    updatePreviews(); updateButton();

    const favMsg = currentCustomer.favoriteRefIds.length
      ? `（偏好 ${currentCustomer.favoriteRefIds.length} 张参考）`
      : '';
    showToast(`✓ 已选客户 ${currentCustomer.name} ${favMsg}`, 'success');
  } catch (e) {
    showToast('✗ ' + e.message, 'error');
  }
}

// ============ generation ============
function setRunningUI(running) {
  generateBtn.hidden = running;
  cancelBtn.hidden = !running;
  generateBtn.disabled = running || selectedFiles.length === 0;
}

cancelBtn.addEventListener('click', () => {
  if (!activeController) return;
  cancelBtn.disabled = true;
  cancelBtn.textContent = '正在停止…';
  statusEl.textContent = '已取消，正在结束后端…';
  activeController.abort();
});

generateBtn.addEventListener('click', async () => {
  if (selectedFiles.length === 0) return;

  setRunningUI(true);
  statusEl.textContent = '提交中…';
  resultsEl.innerHTML = '';
  resultItems = [];
  progressWrap.hidden = false;
  progressFill.style.width = '0%';
  progressText.textContent = '0 / ?';

  const formData = new FormData();
  selectedFiles.forEach(f => formData.append('photos', f));
  formData.append('count', countSlider.value);
  formData.append('name', nameInput.value.trim());
  formData.append('nameEn', nameEnInput.value.trim());
  formData.append('gender', filters.gender);
  formData.append('vibe', filters.vibe);
  formData.append('tone', filters.tone);
  formData.append('age', filters.age);
  if (currentCustomer) formData.append('customer', currentCustomer.id);

  activeController = new AbortController();
  let cancelled = false;

  try {
    const resp = await fetch('/api/generate', {
      method: 'POST',
      body: formData,
      signal: activeController.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    await readSSE(resp, activeController.signal);
  } catch (err) {
    if (err.name === 'AbortError') {
      cancelled = true;
      statusEl.textContent = '已取消';
      markPendingAsCancelled();
    } else {
      statusEl.textContent = '失败：' + err.message;
      showToast('✗ ' + err.message, 'error');
    }
  } finally {
    activeController = null;
    cancelBtn.disabled = false;
    cancelBtn.textContent = '取消';
    setRunningUI(false);
    if (cancelled) progressFill.style.background = 'linear-gradient(90deg, #6e6e73, #a1a1a6)';
    else progressFill.style.background = '';
  }
});

function markPendingAsCancelled() {
  document.querySelectorAll('.result-card.pending').forEach(card => {
    card.classList.remove('pending');
    card.classList.add('cancelled');
    card.innerHTML = '已取消';
  });
}

async function readSSE(resp, signal) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let total = 0;

  signal?.addEventListener('abort', () => { try { reader.cancel(); } catch {} });

  while (true) {
    let chunk;
    try { chunk = await reader.read(); } catch { break; }
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    const chunks = buf.split('\n\n');
    buf = chunks.pop();
    for (const c of chunks) handleEvent(c);
  }

  function handleEvent(chunk) {
    let event = 'message';
    let data = '';
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    if (!data) return;
    let p;
    try { p = JSON.parse(data); } catch { return; }

    if (event === 'start') {
      total = p.total;
      const fallbackNote = p.fallback ? '（池子不足，回退全库）' : '';
      const poolNote = p.poolSize != null ? `· 池 ${p.poolSize}` : '';
      statusEl.textContent = `生成中 · ${p.imageModel} ${poolNote} ${fallbackNote}`;
      topBarStatus.textContent = `生成中 0 / ${total}`;
      progressText.textContent = `0 / ${total}`;
      for (let i = 0; i < total; i++) renderPendingCard(i);
    } else if (event === 'progress') {
      const card = $(`card-${p.index}`);
      if (card) {
        const label = card.querySelector('.ref-name');
        if (label) label.textContent = p.referenceName;
      }
    } else if (event === 'image') {
      const file = p.file || ('output/' + p.url.split('/').pop());
      const refId = p.refId || p.referenceName?.replace(/\.[^.]+$/, '');
      resultItems.push({ index: p.index, url: p.url, refName: p.referenceName, refId, file });
      renderImageCard(p.index, p.url, p.referenceName, refId, file);
      updateProgress(p.completed + p.failed, total);
      topBarStatus.textContent = `生成中 ${p.completed + p.failed} / ${total}`;
    } else if (event === 'imageError') {
      renderErrorCard(p.index, p.message);
      updateProgress(p.completed + p.failed, total);
    } else if (event === 'done') {
      if (p.sessionId) activeSessionId = p.sessionId;
      statusEl.textContent = `完成 · 成功 ${p.completed}，失败 ${p.failed}`;
      topBarStatus.textContent = `✓ ${p.completed} / ${total}`;
      if (currentCustomer && p.completed > 0) {
        // refresh customer to get any auto-updates
        fetchCustomers();
      }
    } else if (event === 'error') {
      statusEl.textContent = '错误：' + p.message;
      showToast('✗ ' + p.message, 'error');
    }
  }
}

function updateProgress(done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  progressFill.style.width = pct + '%';
  progressText.textContent = `${done} / ${total}`;
}

function renderPendingCard(index) {
  if ($(`card-${index}`)) return;
  const card = document.createElement('div');
  card.className = 'result-card pending';
  card.id = `card-${index}`;
  card.style.animationDelay = `${index * 30}ms`;
  card.innerHTML = `<div class="spinner"></div><span class="ref-name">排队中…</span>`;
  resultsEl.appendChild(card);
}

function renderImageCard(index, url, refName, refId, file) {
  const card = $(`card-${index}`) || document.createElement('div');
  card.id = `card-${index}`;
  card.className = 'result-card';
  const isFav = refId && activeFavRefs.has(String(refId));
  card.innerHTML = `
    <img src="${url}" alt="generated ${index}" loading="lazy">
    <span class="ref-name" title="${refName}">${refName}</span>
    <div class="actions-row">
      ${currentCustomer ? `
        <button class="btn-mini fav ${isFav ? 'active' : ''}" data-index="${index}">
          <span class="fav-icon">${isFav ? '★' : '☆'}</span>
        </button>` : ''}
      <a class="btn-mini" href="${url}" download="poster-${index + 1}.png" onclick="event.stopPropagation()">下载</a>
    </div>
  `;
  if (!card.parentNode) resultsEl.appendChild(card);

  // 点卡片打开 lightbox
  card.onclick = (e) => {
    if (e.target.closest('.actions-row')) return;
    openLightbox(index);
  };

  // 收藏按钮
  const favBtn = card.querySelector('.btn-mini.fav');
  if (favBtn) {
    favBtn.onclick = (e) => {
      e.stopPropagation();
      toggleFavorite(index, favBtn);
    };
  }
}

function renderErrorCard(index, message) {
  const card = $(`card-${index}`) || document.createElement('div');
  card.id = `card-${index}`;
  card.className = 'result-card error';
  card.textContent = '失败：' + message;
  if (!card.parentNode) resultsEl.appendChild(card);
}

// ============ favorites ============
async function toggleFavorite(index, btn) {
  if (!currentCustomer) {
    showToast('先选一个客户才能收藏', 'error');
    return;
  }
  const item = resultItems.find(x => x.index === index);
  if (!item) return;

  const isActive = btn.classList.contains('active');
  const endpoint = isActive
    ? `/api/customers/${currentCustomer.id}/unfav`
    : `/api/customers/${currentCustomer.id}/fav`;
  const body = isActive
    ? { refIds: [String(item.refId)] }
    : { genFiles: [item.file] };

  btn.style.pointerEvents = 'none';
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '失败');

    activeFavRefs = new Set((d.favoriteRefIds || []).map(String));
    // 更新所有同 refId 的按钮显示
    refreshAllFavButtons();
    showToast(isActive ? '已取消收藏' : `✓ 已收藏（参考 ${item.refId}）`, 'success');

    // 同步 lightbox 按钮（如果开着）
    if (!lightbox.hidden) updateLightboxFavState();
  } catch (e) {
    showToast('✗ ' + e.message, 'error');
  } finally {
    btn.style.pointerEvents = '';
  }
}

function refreshAllFavButtons() {
  for (const item of resultItems) {
    const card = $(`card-${item.index}`);
    if (!card) continue;
    const btn = card.querySelector('.btn-mini.fav');
    if (!btn) continue;
    const fav = activeFavRefs.has(String(item.refId));
    btn.classList.toggle('active', fav);
    btn.querySelector('.fav-icon').textContent = fav ? '★' : '☆';
  }
}

// ============ lightbox ============
function openLightbox(index) {
  const items = resultItems.filter(x => x.url);
  if (items.length === 0) return;
  lightboxIndex = items.findIndex(x => x.index === index);
  if (lightboxIndex < 0) lightboxIndex = 0;
  renderLightbox();
  lightbox.removeAttribute('hidden');
  document.body.style.overflow = 'hidden';
}

function renderLightbox() {
  const items = resultItems.filter(x => x.url);
  if (items.length === 0) { closeLightbox(); return; }
  if (lightboxIndex < 0) lightboxIndex = items.length - 1;
  if (lightboxIndex >= items.length) lightboxIndex = 0;
  const it = items[lightboxIndex];
  lbImg.src = it.url;
  lbImg.alt = `Poster ${lightboxIndex + 1}`;
  lbIndex.textContent = `${lightboxIndex + 1} / ${items.length}`;
  lbRef.textContent = `参考 ${it.refId || it.refName}`;
  lbDownload.href = it.url;
  lbDownload.setAttribute('download', `poster-${lightboxIndex + 1}.png`);
  updateLightboxFavState();
}

function updateLightboxFavState() {
  const items = resultItems.filter(x => x.url);
  const it = items[lightboxIndex];
  if (!it) return;
  const isFav = currentCustomer && activeFavRefs.has(String(it.refId));
  lbFav.classList.toggle('active', !!isFav);
  lbFav.querySelector('.lb-fav-icon').textContent = isFav ? '★' : '☆';
  lbFav.querySelector('.lb-fav-label').textContent = isFav ? '已收藏' : '收藏';
  lbFav.style.opacity = currentCustomer ? '1' : '0.4';
  lbFav.title = currentCustomer ? '' : '先选客户才能收藏';
}

function closeLightbox() {
  lightbox.setAttribute('hidden', '');
  document.body.style.overflow = '';
}

lbClose.addEventListener('click', closeLightbox);
lbPrev.addEventListener('click', () => { lightboxIndex--; renderLightbox(); });
lbNext.addEventListener('click', () => { lightboxIndex++; renderLightbox(); });
lbFav.addEventListener('click', () => {
  if (!currentCustomer) {
    showToast('先选一个客户才能收藏', 'error');
    return;
  }
  const items = resultItems.filter(x => x.url);
  const it = items[lightboxIndex];
  if (!it) return;
  const card = $(`card-${it.index}`);
  const btn = card?.querySelector('.btn-mini.fav');
  if (btn) toggleFavorite(it.index, btn);
});

document.addEventListener('keydown', (e) => {
  if (lightbox.hidden) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') { lightboxIndex--; renderLightbox(); }
  else if (e.key === 'ArrowRight') { lightboxIndex++; renderLightbox(); }
  else if (e.key === 'f' || e.key === 'F') lbFav.click();
});

lightbox.addEventListener('click', (e) => {
  if (e.target === lightbox || e.target.classList.contains('lb-stage')) closeLightbox();
});

// ============ init ============
fetchCustomers();
updateButton();
