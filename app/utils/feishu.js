/**
 * 飞书企业自建应用 - 上传图片 + 发消息
 *
 * 用法:
 *   const feishu = require('./utils/feishu');
 *   await feishu.sendImages({
 *     to: 'oc_xxx',           // chat_id 群 or open_id 个人
 *     toType: 'chat_id',       // chat_id / open_id / user_id / email / union_id
 *     header: '客户: 示例用户, 共 10 张',
 *     images: ['output/gen_xxx_0.png', 'output/gen_xxx_1.png'],
 *   });
 */

const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');

const FEISHU_BASE = 'https://open.feishu.cn';

let cachedToken = null;
let cachedTokenExpireAt = 0;

function getProxyAgent() {
  const url = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  // 飞书 API 在国内可直连，默认不走代理；如需强制可设 FEISHU_USE_PROXY=1
  if (url && process.env.FEISHU_USE_PROXY === '1') return new HttpsProxyAgent(url);
  return undefined;
}

async function feishuFetch(urlPath, options = {}) {
  const agent = getProxyAgent();
  const opts = { ...options };
  if (agent) opts.dispatcher = undefined; // node 24 native fetch 不直接支持 https-proxy-agent
  // 用原生 fetch；如要走代理，建议用 undici ProxyAgent
  const r = await fetch(FEISHU_BASE + urlPath, opts);
  return r;
}

async function getTenantToken() {
  const now = Date.now();
  if (cachedToken && cachedTokenExpireAt - now > 60_000) return cachedToken;

  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) throw new Error('FEISHU_APP_ID / FEISHU_APP_SECRET 未配置');

  const r = await feishuFetch('/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await r.json();
  if (data.code !== 0) throw new Error(`获取 tenant_access_token 失败: ${JSON.stringify(data)}`);
  cachedToken = data.tenant_access_token;
  cachedTokenExpireAt = now + data.expire * 1000;
  return cachedToken;
}

async function uploadImage(imagePath) {
  const token = await getTenantToken();
  const buf = fs.readFileSync(imagePath);
  const filename = path.basename(imagePath);

  const boundary = '----feishu' + Date.now() + Math.random().toString(36).slice(2);
  const parts = [];
  const push = (s) => parts.push(Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8'));

  push(`--${boundary}\r\n`);
  push(`Content-Disposition: form-data; name="image_type"\r\n\r\nmessage\r\n`);
  push(`--${boundary}\r\n`);
  push(`Content-Disposition: form-data; name="image"; filename="${filename}"\r\n`);
  push(`Content-Type: image/png\r\n\r\n`);
  push(buf);
  push(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat(parts);

  const r = await feishuFetch('/open-apis/im/v1/images', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  const data = await r.json();
  if (data.code !== 0) throw new Error(`上传图片失败 (${filename}): ${JSON.stringify(data)}`);
  return data.data.image_key;
}

async function sendMessage(to, toType, msgType, content) {
  const token = await getTenantToken();
  const r = await feishuFetch(`/open-apis/im/v1/messages?receive_id_type=${toType}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      receive_id: to,
      msg_type: msgType,
      content: typeof content === 'string' ? content : JSON.stringify(content),
    }),
  });
  const data = await r.json();
  if (data.code !== 0) throw new Error(`发消息失败: ${JSON.stringify(data)}`);
  return data.data;
}

async function sendText(to, toType, text) {
  return sendMessage(to, toType, 'text', { text });
}

async function sendImage(to, toType, imageKey) {
  return sendMessage(to, toType, 'image', { image_key: imageKey });
}

async function sendCard(to, toType, card) {
  return sendMessage(to, toType, 'interactive', card);
}

/**
 * 构造 2 列网格的图墙互动卡片
 * imageKeys: 上传完拿到的 image_key 数组
 * meta: { title, customer, reason, refIds, footerNote }
 */
function buildImageGridCard(imageKeys, meta = {}) {
  const elements = [];

  // 头部说明区
  if (meta.customer || meta.reason || (meta.refIds && meta.refIds.length)) {
    const lines = [];
    if (meta.customer) lines.push(`**客户**　${meta.customer}`);
    if (meta.reason) lines.push(`**选图**　${meta.reason}`);
    if (meta.refIds && meta.refIds.length) lines.push(`**参考**　${meta.refIds.join(', ')}`);
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: lines.join('\n') },
    });
    elements.push({ tag: 'hr' });
  }

  // 2 列网格：每两张一行
  for (let i = 0; i < imageKeys.length; i += 2) {
    const columns = [];
    for (let j = 0; j < 2; j++) {
      const k = imageKeys[i + j];
      columns.push({
        tag: 'column',
        width: 'weighted',
        weight: 1,
        vertical_align: 'top',
        elements: k ? [{
          tag: 'img',
          img_key: k,
          alt: { tag: 'plain_text', content: `#${i + j + 1}` },
          mode: 'fit_horizontal',
          preview: true,
        }] : [{
          tag: 'div',
          text: { tag: 'plain_text', content: ' ' },
        }],
      });
    }
    elements.push({
      tag: 'column_set',
      flex_mode: 'none',
      background_style: 'default',
      columns,
    });
  }

  if (meta.footerNote) {
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: meta.footerNote }],
    });
  }

  return {
    config: { wide_screen_mode: true, enable_forward: true },
    header: {
      template: 'indigo',
      title: { tag: 'plain_text', content: meta.title || `AI 自动生图 · ${imageKeys.length} 张` },
    },
    elements,
  };
}

/**
 * 上传 N 张图，发一条互动卡片
 * 返回 { uploadedKeys: [...], messageId }
 */
async function sendImages({ to, toType = 'chat_id', header, images, meta = {} }) {
  if (!to) throw new Error('to 不能为空');
  if (!images || images.length === 0) throw new Error('images 不能为空');

  const uploadedKeys = [];
  for (const img of images) {
    const key = await uploadImage(img);
    uploadedKeys.push(key);
  }

  // header（文字版兼容旧调用）→ 解析进卡片 meta
  const cardMeta = { ...meta };
  if (header && !meta.customer && !meta.reason) {
    // 旧 header 是多行文本，解析成卡片元素
    const lines = String(header).split('\n');
    cardMeta.title = lines[0];
    const sub = lines.slice(1).join(' · ');
    if (sub) cardMeta.footerNote = sub;
  }

  const card = buildImageGridCard(uploadedKeys, cardMeta);
  const r = await sendCard(to, toType, card);
  return { uploadedKeys, messageId: r.message_id };
}

/**
 * 列出 bot 加入的群（前 100 个）—— 用于查 chat_id
 */
async function listChats() {
  const token = await getTenantToken();
  const r = await feishuFetch('/open-apis/im/v1/chats?page_size=100', {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const data = await r.json();
  if (data.code !== 0) throw new Error(`列群失败: ${JSON.stringify(data)}`);
  return data.data.items || [];
}

module.exports = { getTenantToken, uploadImage, sendText, sendImage, sendCard, sendImages, buildImageGridCard, listChats };
