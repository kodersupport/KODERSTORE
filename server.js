require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const crypto = require('crypto');

const required = ['BOT_TOKEN','JSONBIN_BIN_ID','JSONBIN_MASTER_KEY','ADMIN_PASSWORD','JWT_SECRET','BANK_ID','BANK_ACCOUNT','BANK_ACCOUNT_NAME'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error('Missing environment variables:', missing.join(', '));
  process.exit(1);
}
if (process.env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET must be at least 32 characters.');
  process.exit(1);
}

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false }));

const BIN_URL = `https://api.jsonbin.io/v3/b/${process.env.JSONBIN_BIN_ID}`;
const headers = { 'X-Master-Key': process.env.JSONBIN_MASTER_KEY, 'Content-Type': 'application/json' };
const blankDB = () => ({ version: 1, products: [], orders: [], adminIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
let db = blankDB();
let writeQueue = Promise.resolve();
let bot;
let telegramIdentity = null;
let jsonbinConnected = false;

async function loadDB() {
  try {
    const res = await axios.get(`${BIN_URL}/latest`, { headers, timeout: 15000 });
    const record = res.data && res.data.record;
    if (record && typeof record === 'object') db = { ...blankDB(), ...record };
    else await saveDB();
    jsonbinConnected = true;
  } catch (e) {
    if (e.response && e.response.status === 404) {
      // Initialize an empty bin record; a wrong Bin ID will fail on PUT too.
      await saveDB();
      jsonbinConnected = true;
    } else {
      throw new Error(`JSONBIN_CONNECT_ERROR: ${e.response?.data?.message || e.message}`);
    }
  }
}
function saveDB() {
  // Recover the queue after a failed write so later saves can still succeed.
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    db.updatedAt = new Date().toISOString();
    await axios.put(BIN_URL, db, { headers, timeout: 15000 });
    jsonbinConnected = true;
  });
  return writeQueue;
}
function id(prefix='id') { return `${prefix}_${crypto.randomBytes(6).toString('hex')}`; }
function money(n) { return new Intl.NumberFormat('vi-VN').format(Number(n) || 0) + 'đ'; }
function cleanText(v, max=160) { return String(v ?? '').trim().slice(0, max); }
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  try { req.admin = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Phiên đăng nhập hết hạn hoặc không hợp lệ.' }); }
}
function findVariant(productId, variantId) {
  const p = db.products.find(x => x.id === productId);
  const v = p && p.variants.find(x => x.id === variantId);
  return { p, v };
}
function makeQr(amount, orderId) {
  const bank = encodeURIComponent(process.env.BANK_ID);
  const account = encodeURIComponent(process.env.BANK_ACCOUNT);
  const name = encodeURIComponent(process.env.BANK_ACCOUNT_NAME);
  const info = encodeURIComponent(`DH ${orderId}`);
  return `https://img.vietqr.io/image/${bank}-${account}-compact2.png?amount=${Math.round(amount)}&addInfo=${info}&accountName=${name}`;
}
async function notifyAdmins(text) {
  const ids = [...new Set((db.adminIds || []).map(String))];
  for (const chatId of ids) {
    try { await bot.sendMessage(chatId, text); } catch (e) { console.warn('Admin notify failed for', chatId, e.message); }
  }
}

app.post('/api/login', (req, res) => {
  const password = Buffer.from(String(req.body?.password || ''));
  const expected = Buffer.from(String(process.env.ADMIN_PASSWORD));
  const valid = password.length === expected.length && crypto.timingSafeEqual(password, expected);
  if (!valid) return res.status(401).json({ error: 'Mật khẩu không đúng.' });
  const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, expiresIn: 43200 });
});
app.get('/api/health', (req,res) => res.status(jsonbinConnected && telegramIdentity ? 200 : 503).json({
  ok: Boolean(jsonbinConnected && telegramIdentity), service: 'koder-shop',
  jsonbin: jsonbinConnected ? 'connected' : 'disconnected',
  telegram: telegramIdentity ? 'connected' : 'disconnected',
  botUsername: telegramIdentity?.username || null,
  products: db.products.length, orders: db.orders.length
}));

app.get('/api/admin/data', auth, (req,res) => {
  res.json({ products: db.products, orders: db.orders, adminIds: db.adminIds, bank: { displayName: process.env.BANK_DISPLAY_NAME || process.env.BANK_ID, account: process.env.BANK_ACCOUNT, accountName: process.env.BANK_ACCOUNT_NAME } });
});
app.post('/api/admin/products', auth, async (req,res) => {
  const name = cleanText(req.body?.name, 100);
  if (!name) return res.status(400).json({ error: 'Tên sản phẩm không được để trống.' });
  const raw = Array.isArray(req.body.variants) ? req.body.variants : [];
  const variants = raw.map(v => ({ id: v.id || id('var'), name: cleanText(v.name,80), price: Math.max(0, Math.round(Number(v.price)||0)), stock: Math.max(0, Math.floor(Number(v.stock)||0)) })).filter(v => v.name && v.price > 0);
  if (!variants.length) return res.status(400).json({ error: 'Cần ít nhất một phân loại có giá hợp lệ.' });
  const product = { id: id('prd'), name, description: cleanText(req.body.description,500), downloadLink: cleanText(req.body.downloadLink,500), variants, active: req.body.active !== false, createdAt: new Date().toISOString() };
  db.products.unshift(product); await saveDB(); res.json({ product });
});
app.put('/api/admin/products/:id', auth, async (req,res) => {
  const p = db.products.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Không tìm thấy sản phẩm.' });
  const name = cleanText(req.body?.name,100);
  const variants = (Array.isArray(req.body.variants) ? req.body.variants : []).map(v => { const variantName = cleanText(v.name,80); const old = p.variants.find(x => x.name === variantName); return { id: v.id || old?.id || id('var'), name: variantName, price: Math.max(0,Math.round(Number(v.price)||0)), stock: Math.max(0,Math.floor(Number(v.stock)||0)) }; }).filter(v => v.name && v.price > 0);
  if (!name || !variants.length) return res.status(400).json({ error: 'Tên và ít nhất một phân loại hợp lệ là bắt buộc.' });
  p.name = name; p.description = cleanText(req.body.description,500); p.downloadLink = cleanText(req.body.downloadLink,500); p.variants = variants; p.active = req.body.active !== false;
  await saveDB(); res.json({ product: p });
});
app.delete('/api/admin/products/:id', auth, async (req,res) => {
  db.products = db.products.filter(x => x.id !== req.params.id); await saveDB(); res.json({ ok: true });
});
app.post('/api/admin/admin-ids', auth, async (req,res) => {
  const value = cleanText(req.body?.telegramId,40);
  if (!/^\d{5,20}$/.test(value)) return res.status(400).json({ error: 'Telegram ID phải là dãy số hợp lệ.' });
  if (!db.adminIds.includes(value)) db.adminIds.push(value);
  await saveDB(); res.json({ adminIds: db.adminIds });
});
app.delete('/api/admin/admin-ids/:telegramId', auth, async (req,res) => {
  db.adminIds = db.adminIds.filter(x => x !== req.params.telegramId); await saveDB(); res.json({ adminIds: db.adminIds });
});
app.post('/api/admin/orders/:id/approve', auth, async (req,res) => {
  const order = db.orders.find(x => x.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng.' });
  if (order.status !== 'awaiting_admin') return res.status(400).json({ error: 'Đơn chưa ở trạng thái chờ Admin duyệt.' });
  const key = cleanText(req.body?.key,500);
  if (!key) return res.status(400).json({ error: 'Vui lòng nhập KEY.' });
  const { p, v } = findVariant(order.productId, order.variantId);
  if (!p || !v) return res.status(409).json({ error: 'Sản phẩm hoặc phân loại không còn tồn tại.' });
  if (v.stock < 1) return res.status(409).json({ error: 'Kho đang bằng 0. Hãy cập nhật tồn kho trước khi duyệt.' });
  order.status = 'approved'; order.key = key; order.approvedAt = new Date().toISOString(); order.approvedBy = 'admin';
  v.stock -= 1;
  await saveDB();
  try {
    await bot.sendMessage(order.chatId, `🎉 MUA HÀNG THÀNH CÔNG! 🎉\n\n📦 Sản phẩm: ${order.productName}\n🏷 Phân loại: ${order.variantName}\n💰 Tổng tiền: ${money(order.amount)}\n📥 Link tải: ${order.downloadLink || 'IB ADMIN ĐỂ LẤY LINK TẢI'}\n\n🔑 KEY CỦA BẠN:\n${key}`);
  } catch (e) {
    order.deliveryError = e.message; await saveDB();
    return res.status(502).json({ error: 'Đã duyệt và lưu KEY nhưng Telegram gửi thất bại: ' + e.message });
  }
  res.json({ ok: true, order });
});
app.post('/api/admin/orders/:id/reject', auth, async (req,res) => {
  const order = db.orders.find(x => x.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng.' });
  if (!['awaiting_admin','pending_payment'].includes(order.status)) return res.status(400).json({ error: 'Không thể từ chối đơn ở trạng thái này.' });
  order.status = 'rejected'; order.rejectedAt = new Date().toISOString(); order.rejectReason = cleanText(req.body?.reason,200);
  await saveDB();
  try { await bot.sendMessage(order.chatId, `Đơn hàng ${order.id} chưa được duyệt.${order.rejectReason ? '\nLý do: '+order.rejectReason : ''}\nVui lòng liên hệ Admin nếu cần hỗ trợ.`); } catch {}
  res.json({ ok: true });
});

function productKeyboard() {
  const rows = db.products.filter(p => p.active).map(p => [{ text: p.name, callback_data: `prd:${p.id}` }]);
  return { inline_keyboard: rows.length ? rows : [[{ text: 'Hiện chưa có sản phẩm', callback_data: 'noop' }]] };
}
function variantKeyboard(p) {
  return { inline_keyboard: p.variants.map(v => [{ text: `${v.name} — ${money(v.price)} (Kho: ${v.stock})`, callback_data: `var:${p.id}:${v.id}` }]) };
}
async function createOrder(chatId, from, p, v) {
  const order = { id: id('DH'), chatId: String(chatId), telegramUserId: String(from.id), username: from.username || '', firstName: from.first_name || '', productId: p.id, productName: p.name, variantId: v.id, variantName: v.name, amount: v.price, downloadLink: p.downloadLink || '', status: 'pending_payment', createdAt: new Date().toISOString() };
  db.orders.unshift(order); await saveDB(); return order;
}
async function initBot() {
  // Validate the token before polling. Telegram 404 usually means invalid/revoked token.
  bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });
  telegramIdentity = await bot.getMe();
  console.log(`Telegram token valid: @${telegramIdentity.username} (id ${telegramIdentity.id})`);
  bot.onText(/^\/start(?:@\w+)?$/, async msg => {
    await bot.sendMessage(msg.chat.id, '🛍 Chào mừng bạn đến shop!\nVui lòng chọn sản phẩm muốn mua:', { reply_markup: productKeyboard() });
  });
  bot.onText(/^\/id(?:@\w+)?$/, msg => bot.sendMessage(msg.chat.id, `🆔 Telegram ID của bạn: ${msg.from.id}`));
  bot.onText(/^\/help(?:@\w+)?$/, msg => bot.sendMessage(msg.chat.id, 'Dùng /start để xem sản phẩm. Dùng /id để xem Telegram ID. Sau khi chuyển khoản, bấm “Tôi đã thanh toán” để Admin kiểm tra.'));
  bot.on('callback_query', async q => {
    const data = q.data || ''; const chatId = q.message.chat.id;
    try {
      if (data === 'noop') return bot.answerCallbackQuery(q.id, { text: 'Chưa có sản phẩm.' });
      if (data.startsWith('prd:')) {
        const p = db.products.find(x => x.id === data.slice(4) && x.active);
        if (!p) return bot.answerCallbackQuery(q.id, { text: 'Sản phẩm không còn khả dụng.' });
        await bot.answerCallbackQuery(q.id);
        return bot.sendMessage(chatId, `📦 ${p.name}\n${p.description || 'Chọn phân loại bên dưới:'}`, { reply_markup: variantKeyboard(p) });
      }
      if (data.startsWith('var:')) {
        const [, pid, vid] = data.split(':'); const { p, v } = findVariant(pid,vid);
        if (!p || !v || !p.active) return bot.answerCallbackQuery(q.id, { text: 'Sản phẩm không còn khả dụng.' });
        if (v.stock < 1) return bot.answerCallbackQuery(q.id, { text: 'Phân loại đã hết hàng.' , show_alert: true });
        const order = await createOrder(chatId, q.from, p, v);
        const qr = makeQr(order.amount, order.id);
        await bot.answerCallbackQuery(q.id, { text: 'Đã tạo đơn hàng.' });
        return bot.sendPhoto(chatId, qr, { caption: `🧾 ĐƠN HÀNG: ${order.id}\n📦 ${p.name}\n🏷 ${v.name}\n💰 Số tiền: ${money(v.price)}\n🏦 ${process.env.BANK_DISPLAY_NAME || process.env.BANK_ID}\n👤 ${process.env.BANK_ACCOUNT_NAME}\n💳 ${process.env.BANK_ACCOUNT}\n\nNội dung chuyển khoản: DH ${order.id}\nSau khi chuyển khoản, nhấn nút bên dưới.`, reply_markup: { inline_keyboard: [[{ text: '✅ Tôi đã thanh toán', callback_data: `paid:${order.id}` }]] } });
      }
      if (data.startsWith('paid:')) {
        const orderId = data.slice(5); const order = db.orders.find(x => x.id === orderId && x.chatId === String(chatId));
        if (!order) return bot.answerCallbackQuery(q.id, { text: 'Không tìm thấy đơn hàng.', show_alert: true });
        if (order.status === 'awaiting_admin') return bot.answerCallbackQuery(q.id, { text: 'Đơn đã được gửi Admin kiểm tra.' });
        if (order.status !== 'pending_payment') return bot.answerCallbackQuery(q.id, { text: 'Đơn không còn chờ thanh toán.' , show_alert: true });
        order.status = 'awaiting_admin'; order.paidClickedAt = new Date().toISOString(); await saveDB();
        await bot.answerCallbackQuery(q.id, { text: 'Đã gửi yêu cầu.' });
        await bot.sendMessage(chatId, '⏳ VUI LÒNG CHỜ ADMIN DUYỆT TRONG ÍT PHÚT…');
        const note = `🔔 CÓ KHÁCH BÁO ĐÃ THANH TOÁN\n\nMã đơn: ${order.id}\nKhách: ${order.firstName} (@${order.username || 'không có'})\nTelegram ID: ${order.telegramUserId}\nSản phẩm: ${order.productName}\nPhân loại: ${order.variantName}\nSố tiền: ${money(order.amount)}\n\nVui lòng kiểm tra giao dịch trong ngân hàng trước khi duyệt.`;
        await notifyAdmins(note);
      }
    } catch (e) {
      console.error('Callback error:', e.message);
      try { await bot.answerCallbackQuery(q.id, { text: 'Có lỗi, vui lòng thử lại sau.', show_alert: true }); } catch {}
    }
  });
  bot.on('polling_error', e => console.error('TELEGRAM_POLLING_ERROR:', e.response?.body?.description || e.message));
  await bot.deleteWebHook({ drop_pending_updates: false });
  await bot.startPolling();
  console.log(`Telegram polling started for @${telegramIdentity.username}`);
}

(async () => {
  try {
    await loadDB();
    await initBot();
    const port = Number(process.env.PORT || 3000);
    app.listen(port, () => console.log(`Shop Admin Light V1 listening on ${port}`));
  } catch (e) {
    console.error(e.message); process.exit(1);
  }
})();
