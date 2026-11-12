const express = require('express');
const multer = require('multer');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.OPENAI_MODEL || 'gpt-5';
const IMAGE_MODEL = process.env.IMAGE_MODEL || ''; // 留空 = 让 OpenAI 自动用最新；可填 'gpt-image-1' / 'gpt-image-2' 等
const IMAGE_SIZE = process.env.IMAGE_SIZE || 'auto'; // 'auto' / '1024x1024' / '1024x1536' / '1536x1024'
const IMAGE_QUALITY = process.env.IMAGE_QUALITY || 'high'; // 'low' / 'medium' / 'high' / 'auto'
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '3', 10);
const TOTAL_IMAGES = parseInt(process.env.TOTAL_IMAGES || '10', 10);

const REFERENCE_DIR = path.join(__dirname, '元图片');
const TAGS_FILE = path.join(REFERENCE_DIR, '_tags.json');
const OUTPUT_DIR = path.join(__dirname, 'output');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const CUSTOMERS_DIR = path.join(__dirname, 'customers');

for (const dir of [OUTPUT_DIR, UPLOAD_DIR, CUSTOMERS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

if (!process.env.OPENAI_API_KEY) {
  console.error('错误: 请在 .env 文件中设置 OPENAI_API_KEY');
  process.exit(1);
}

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
const httpAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  ...(httpAgent ? { httpAgent } : {}),
});

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 20 * 1024 * 1024 },
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/output', express.static(OUTPUT_DIR));
app.use('/customer-files', express.static(CUSTOMERS_DIR));

let TAGS = {};
let tagsMtime = 0;
function loadTags(silent = false) {
  try {
    if (fs.existsSync(TAGS_FILE)) {
      const stat = fs.statSync(TAGS_FILE);
      const raw = JSON.parse(fs.readFileSync(TAGS_FILE, 'utf8'));
      TAGS = raw.tags || raw;
      tagsMtime = stat.mtimeMs;
      if (!silent) console.log(`  ✓ 已载入 ${Object.keys(TAGS).length} 条标签`);
    } else if (!silent) {
      console.log('  ⚠ 未找到 _tags.json，所有筛选会回退到全集随机');
    }
  } catch (e) {
    console.error('载入 _tags.json 失败:', e.message);
    TAGS = {};
  }
}
loadTags();

// 每 5 秒检测 _tags.json mtime，被 ingest.js 等改了自动热加载
setInterval(() => {
  try {
    const stat = fs.statSync(TAGS_FILE);
    if (stat.mtimeMs > tagsMtime) {
      loadTags(true);
      console.log(`  ♻ 检测到 _tags.json 变化，热加载: ${Object.keys(TAGS).length} 条`);
    }
  } catch {}
}, 5000);

function listReferenceImages() {
  return fs.readdirSync(REFERENCE_DIR)
    .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f) && !f.startsWith('_'))
    .map(f => path.join(REFERENCE_DIR, f));
}

function refIdFromPath(p) {
  return path.basename(p, path.extname(p));
}

// filters: { gender, vibe, tone, age }
// 空值/undefined/'any' 视为不过滤该维度
function filterRefs(refs, filters = {}) {
  const { gender, vibe, tone, age } = filters;
  return refs.filter(p => {
    const t = TAGS[refIdFromPath(p)];
    if (!t) return false; // 没标签的不参与有筛选条件的请求
    if (gender && gender !== 'any' && t.gender !== gender && t.gender !== 'both') return false;
    if (vibe && vibe !== 'any' && t.vibe !== vibe) return false;
    if (tone && tone !== 'any' && t.tone !== tone) return false;
    if (age && age !== 'any' && t.age_target !== age && t.age_target !== 'any') return false;
    return true;
  });
}

function pickRandom(arr, n) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

function imageToDataURL(imagePath) {
  const ext = path.extname(imagePath).slice(1).toLowerCase();
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  const data = fs.readFileSync(imagePath).toString('base64');
  return `data:image/${mime};base64,${data}`;
}

const BASE_PROMPT = `Replace the face(s) in the reference poster with the person shown in the portrait. Keep the poster's composition, color, typography, and layout. No order numbers. Output one finished poster.`;

function buildPrompt({ name, nameEn }) {
  const parts = [BASE_PROMPT];
  if (name || nameEn) {
    const displayName = [name, nameEn].filter(Boolean).join(' / ');
    parts.push(
      `If the reference poster contains a name/text label on the subject, replace that text with: "${displayName}". Keep the original font style, size, and placement. Do not add the name anywhere else.`
    );
  }
  return parts.join(' ');
}

async function generateOneImage(customerPhotos, referencePath, index, opts, signal) {
  const referenceDataURL = imageToDataURL(referencePath);
  const prompt = buildPrompt(opts);

  const content = [
    { type: 'input_text', text: prompt },
  ];
  for (const photoPath of customerPhotos) {
    content.push({ type: 'input_image', image_url: imageToDataURL(photoPath) });
  }
  content.push({ type: 'input_image', image_url: referenceDataURL });

  const imageTool = { type: 'image_generation' };
  if (IMAGE_MODEL) imageTool.model = IMAGE_MODEL;
  if (IMAGE_SIZE && IMAGE_SIZE !== 'auto') imageTool.size = IMAGE_SIZE;
  if (IMAGE_QUALITY && IMAGE_QUALITY !== 'auto') imageTool.quality = IMAGE_QUALITY;

  const response = await openai.responses.create({
    model: MODEL,
    input: [{ role: 'user', content }],
    tools: [imageTool],
  }, { signal });

  const imageCall = (response.output || []).find(o => o.type === 'image_generation_call');
  if (!imageCall || !imageCall.result) {
    throw new Error('OpenAI 未返回图片');
  }
  return imageCall.result;
}

async function processWithConcurrency(items, concurrency, processItem, signal) {
  let cursor = 0;
  const workers = Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      if (signal?.aborted) return;
      const i = cursor++;
      await processItem(items[i], i);
    }
  });
  await Promise.all(workers);
}

app.post('/api/generate', upload.array('photos', 3), async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const controller = new AbortController();
  let cancelled = false;
  req.on('close', () => {
    if (!cancelled) {
      cancelled = true;
      controller.abort();
      console.log('客户端断开，已中止本次生成');
    }
  });

  const send = (event, data) => {
    if (cancelled || !res.writable) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const customerPaths = (req.files || []).map(f => f.path);
  const cleanup = () => customerPaths.forEach(p => { try { fs.unlinkSync(p); } catch {} });

  try {
    if (customerPaths.length === 0) {
      send('error', { message: '请上传至少一张客户人像照片' });
      return res.end();
    }

    const allRefs = listReferenceImages();
    if (allRefs.length === 0) {
      send('error', { message: '元图片 文件夹为空' });
      cleanup();
      return res.end();
    }

    const requestedCount = Math.max(1, Math.min(30, parseInt(req.body?.count || TOTAL_IMAGES, 10) || TOTAL_IMAGES));
    const name = (req.body?.name || '').trim().slice(0, 40);
    const nameEn = (req.body?.nameEn || '').trim().slice(0, 60);

    // refIds (CSV "12,47,89") 优先级最高：跳过筛选/随机，直接用指定 ID
    const refIdsRaw = (req.body?.refIds || '').trim();
    const explicitIds = refIdsRaw
      ? refIdsRaw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
      : [];

    let references;
    let filteredCount;
    let fallback = false;
    let mode;

    if (explicitIds.length > 0) {
      mode = 'explicit';
      const byId = new Map(allRefs.map(p => [refIdFromPath(p), p]));
      references = explicitIds.map(id => byId.get(id)).filter(Boolean);
      filteredCount = references.length;
      if (references.length === 0) {
        send('error', { message: `指定的 refIds 都不存在: ${refIdsRaw}` });
        cleanup();
        return res.end();
      }
    } else {
      mode = 'random';
      const filters = {
        gender: (req.body?.gender || '').trim() || undefined,
        vibe: (req.body?.vibe || '').trim() || undefined,
        tone: (req.body?.tone || '').trim() || undefined,
        age: (req.body?.age || '').trim() || undefined,
      };
      const hasAnyFilter = Object.values(filters).some(v => v && v !== 'any');

      let pool = allRefs;
      filteredCount = allRefs.length;
      if (hasAnyFilter && Object.keys(TAGS).length > 0) {
        const filtered = filterRefs(allRefs, filters);
        filteredCount = filtered.length;
        if (filtered.length >= requestedCount) {
          pool = filtered;
        } else {
          fallback = true;
          pool = filtered.length > 0 ? filtered : allRefs;
        }
      }
      references = pickRandom(pool, requestedCount);
    }

    send('start', {
      total: references.length,
      chatModel: MODEL,
      imageModel: IMAGE_MODEL || '(auto-latest)',
      poolSize: filteredCount,
      fallback,
      mode,
    });

    let completed = 0;
    let failed = 0;
    const sessionId = Date.now();
    const generatedEntries = []; // 收集供 manifest 用

    const customerSlug = (req.body?.customer || '').trim();

    await processWithConcurrency(references, CONCURRENCY, async (refPath, i) => {
      if (cancelled) return;
      try {
        send('progress', { index: i, status: 'started', referenceName: path.basename(refPath) });
        const base64 = await generateOneImage(customerPaths, refPath, i, { name, nameEn }, controller.signal);
        if (cancelled) return;
        const outFile = `gen_${sessionId}_${i}.png`;
        const outPath = path.join(OUTPUT_DIR, outFile);
        fs.writeFileSync(outPath, Buffer.from(base64, 'base64'));
        completed++;
        const refId = path.basename(refPath, path.extname(refPath));
        generatedEntries.push({ index: i, file: `output/${outFile}`, refId, refName: path.basename(refPath) });
        send('image', {
          index: i,
          url: `/output/${outFile}`,
          file: `output/${outFile}`,
          refId,
          referenceName: path.basename(refPath),
          completed,
          failed,
        });
      } catch (err) {
        if (cancelled || err.name === 'AbortError' || /aborted/i.test(err.message || '')) return;
        failed++;
        console.error(`[#${i}] 生成失败:`, err.message);
        send('imageError', {
          index: i,
          message: err.message || String(err),
          referenceName: path.basename(refPath),
          completed,
          failed,
        });
      }
    }, controller.signal);

    if (!cancelled) {
      // 写 manifest（让 ⭐ 收藏按钮能追溯）
      const manifestPath = path.join(OUTPUT_DIR, `manifest_${sessionId}.json`);
      const manifest = {
        sessionId: String(sessionId),
        generatedAt: new Date().toISOString(),
        customer: customerSlug || null,
        name: name || null,
        nameEn: nameEn || null,
        refIds: references.map(p => path.basename(p, path.extname(p))),
        photos: (req.files || []).map(f => f.originalname),
        generated: generatedEntries.sort((a, b) => a.index - b.index),
        errors: [],
      };
      try { fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8'); } catch {}

      // 回写客户历史
      if (customerSlug) {
        try {
          const c = readCustomerMeta(customerSlug);
          if (c) {
            c.history = c.history || [];
            c.history.push({
              date: new Date().toISOString().slice(0, 10),
              sessionId: String(sessionId),
              refIds: manifest.refIds,
              reason: '',
            });
            writeCustomerMeta(c);
          }
        } catch (e) { console.error('回写客户历史失败:', e.message); }
      }

      send('done', { completed, failed, total: references.length, sessionId: String(sessionId) });
      res.end();
    }
  } catch (err) {
    console.error('严重错误:', err);
    send('error', { message: err.message || String(err) });
    res.end();
  } finally {
    cleanup();
  }
});

// ============ Customer API ============

function slugify(name) {
  const ascii = name.toLowerCase().replace(/[^a-z0-9\s\-]+/g, '').trim().replace(/\s+/g, '-');
  if (ascii && ascii.length >= 2) return ascii.slice(0, 32);
  let h = 0;
  for (const c of name) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
  return 'c' + Math.abs(h).toString(36);
}

function readCustomerMeta(slug) {
  const f = path.join(CUSTOMERS_DIR, slug, 'customer.json');
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function writeCustomerMeta(c) {
  const dir = path.join(CUSTOMERS_DIR, c.id);
  fs.mkdirSync(path.join(dir, 'favorites'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'photos'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'generated'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'customer.json'), JSON.stringify(c, null, 2), 'utf8');
}

function findRefById(id) {
  for (const ext of ['.jpg', '.png', '.jpeg', '.webp']) {
    const p = path.join(REFERENCE_DIR, id + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

app.get('/api/customers', (req, res) => {
  if (!fs.existsSync(CUSTOMERS_DIR)) return res.json([]);
  const slugs = fs.readdirSync(CUSTOMERS_DIR)
    .filter(s => fs.existsSync(path.join(CUSTOMERS_DIR, s, 'customer.json')));
  const list = slugs.map(slug => {
    const c = readCustomerMeta(slug);
    const photoDir = path.join(CUSTOMERS_DIR, slug, 'photos');
    const photos = fs.existsSync(photoDir)
      ? fs.readdirSync(photoDir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
      : [];
    return {
      id: c.id,
      name: c.name,
      nameEn: c.nameEn || '',
      photoCount: photos.length,
      favoriteCount: (c.favoriteRefIds || []).length,
      historyCount: (c.history || []).length,
      lastVisit: c.history?.[c.history.length - 1]?.date || c.createdAt || null,
    };
  });
  list.sort((a, b) => (b.lastVisit || '').localeCompare(a.lastVisit || ''));
  res.json(list);
});

app.get('/api/customers/:slug', (req, res) => {
  const c = readCustomerMeta(req.params.slug);
  if (!c) return res.status(404).json({ error: 'not found' });
  const slug = c.id;
  const photoDir = path.join(CUSTOMERS_DIR, slug, 'photos');
  const photos = fs.existsSync(photoDir)
    ? fs.readdirSync(photoDir)
        .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
        .map(f => ({
          filename: f,
          url: `/customer-files/${encodeURIComponent(slug)}/photos/${encodeURIComponent(f)}`,
        }))
    : [];
  res.json({
    id: c.id,
    name: c.name,
    nameEn: c.nameEn || '',
    createdAt: c.createdAt,
    favoriteRefIds: c.favoriteRefIds || [],
    photos,
    historyCount: (c.history || []).length,
    lastVisit: c.history?.[c.history.length - 1]?.date || null,
  });
});

app.post('/api/customers', (req, res) => {
  const name = (req.body?.name || '').trim().slice(0, 40);
  const nameEn = (req.body?.nameEn || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'name 必填' });
  let base = slugify(nameEn || name);
  let final = base;
  let n = 0;
  while (fs.existsSync(path.join(CUSTOMERS_DIR, final, 'customer.json'))) {
    n++;
    final = `${base}-${n}`;
  }
  const customer = {
    id: final,
    name, nameEn,
    createdAt: new Date().toISOString().slice(0, 10),
    favoriteRefIds: [],
    history: [],
  };
  writeCustomerMeta(customer);
  res.json(customer);
});

app.post('/api/customers/:slug/fav', (req, res) => {
  const c = readCustomerMeta(req.params.slug);
  if (!c) return res.status(404).json({ error: 'not found' });
  const genFiles = Array.isArray(req.body?.genFiles) ? req.body.genFiles : [];
  if (genFiles.length === 0) return res.status(400).json({ error: 'genFiles required' });
  c.favoriteRefIds = c.favoriteRefIds || [];
  const favDir = path.join(CUSTOMERS_DIR, c.id, 'favorites');
  fs.mkdirSync(favDir, { recursive: true });
  const added = [];
  const skipped = [];
  for (const g of genFiles) {
    const m = path.basename(g).match(/gen_(\d+)_(\d+)\.png/);
    if (!m) { skipped.push({ g, reason: 'bad name' }); continue; }
    const [, sessionId, idxStr] = m;
    const manifestPath = path.join(OUTPUT_DIR, `manifest_${sessionId}.json`);
    if (!fs.existsSync(manifestPath)) { skipped.push({ g, reason: 'no manifest' }); continue; }
    const mani = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const entry = mani.generated.find(x => x.index === parseInt(idxStr, 10));
    if (!entry) { skipped.push({ g, reason: 'no entry' }); continue; }
    const refPath = findRefById(entry.refId);
    if (!refPath) { skipped.push({ g, reason: 'ref missing' }); continue; }
    const ext = path.extname(refPath);
    const dst = path.join(favDir, entry.refId + ext);
    if (!fs.existsSync(dst)) fs.copyFileSync(refPath, dst);
    let alreadyHad = c.favoriteRefIds.includes(entry.refId);
    if (!alreadyHad) c.favoriteRefIds.push(entry.refId);
    added.push({ gen: path.basename(g), refId: entry.refId, alreadyHad });
  }
  writeCustomerMeta(c);
  res.json({ added, skipped, favoriteRefIds: c.favoriteRefIds });
});

app.post('/api/customers/:slug/unfav', (req, res) => {
  const c = readCustomerMeta(req.params.slug);
  if (!c) return res.status(404).json({ error: 'not found' });
  const refIds = Array.isArray(req.body?.refIds) ? req.body.refIds.map(String) : [];
  c.favoriteRefIds = (c.favoriteRefIds || []).filter(id => !refIds.includes(id));
  // 可选：从 favorites/ 目录里也删掉
  const favDir = path.join(CUSTOMERS_DIR, c.id, 'favorites');
  for (const id of refIds) {
    for (const ext of ['.jpg', '.png', '.jpeg', '.webp']) {
      const p = path.join(favDir, id + ext);
      if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch {} }
    }
  }
  writeCustomerMeta(c);
  res.json({ favoriteRefIds: c.favoriteRefIds });
});

app.get('/api/health', (req, res) => {
  const refs = listReferenceImages();
  res.json({
    ok: true,
    chatModel: MODEL,
    imageModel: IMAGE_MODEL || '(auto - OpenAI 自动选最新)',
    imageSize: IMAGE_SIZE,
    imageQuality: IMAGE_QUALITY,
    proxy: proxyUrl || '(无)',
    referenceCount: refs.length,
    taggedCount: Object.keys(TAGS).length,
    totalImagesPerJob: TOTAL_IMAGES,
    concurrency: CONCURRENCY,
  });
});

app.get('/api/refs/count', (req, res) => {
  const refs = listReferenceImages();
  const filters = {
    gender: req.query.gender || undefined,
    vibe: req.query.vibe || undefined,
    tone: req.query.tone || undefined,
    age: req.query.age || undefined,
  };
  const hasAnyFilter = Object.values(filters).some(v => v && v !== 'any');
  if (!hasAnyFilter || Object.keys(TAGS).length === 0) {
    return res.json({ total: refs.length, filtered: refs.length });
  }
  const filtered = filterRefs(refs, filters);
  res.json({ total: refs.length, filtered: filtered.length });
});

app.listen(PORT, () => {
  const refs = listReferenceImages();
  console.log(`\n  ✓ AI 自动生图服务已启动`);
  console.log(`  ✓ 顶层模型 (Responses API): ${MODEL}`);
  console.log(`  ✓ 生图模型 (image_generation tool): ${IMAGE_MODEL || '(auto - OpenAI 自动选最新)'}`);
  console.log(`  ✓ 图片尺寸: ${IMAGE_SIZE}, 质量: ${IMAGE_QUALITY}`);
  console.log(`  ✓ 代理: ${proxyUrl || '(无)'}`);
  console.log(`  ✓ 元图片库: ${refs.length} 张, 已打标签: ${Object.keys(TAGS).length} 条`);
  console.log(`  ✓ 单次生成: ${TOTAL_IMAGES} 张，并发: ${CONCURRENCY}`);
  console.log(`\n  浏览器打开: http://localhost:${PORT}\n`);
});
