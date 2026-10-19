const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 4;
const recentRequests = new Map();
const clean = (value, max = 180) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

module.exports = async function handler(req, res) {
  const siteOrigin = process.env.SITE_ORIGIN || 'https://loza-serhiia.vercel.app';
  res.setHeader('Access-Control-Allow-Origin', siteOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (req.headers.origin && req.headers.origin !== siteOrigin) return res.status(403).json({ ok: false, error: 'Forbidden origin' });

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return res.status(503).json({ ok: false, error: 'Telegram is not configured' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  // Quietly accept honeypot submissions without forwarding them.
  if (clean(body.website, 200)) return res.status(200).json({ ok: true });

  const ip = clean((req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0], 80);
  const now = Date.now();
  const bucket = recentRequests.get(ip);
  if (bucket && now - bucket.started < WINDOW_MS && bucket.count >= MAX_PER_WINDOW) {
    return res.status(429).json({ ok: false, error: 'Too many requests. Try again shortly.' });
  }
  if (!bucket || now - bucket.started >= WINDOW_MS) recentRequests.set(ip, { started: now, count: 1 });
  else bucket.count += 1;

  const buyer = clean(body.buyer, 100);
  const phone = clean(body.phone, 30);
  const city = clean(body.city, 100);
  const branch = clean(body.branch, 100);
  const note = clean(body.note, 500);
  const items = Array.isArray(body.items) ? body.items.slice(0, 80) : [];
  if (buyer.length < 2 || !/^[+\d\s().-]{7,30}$/.test(phone) || city.length < 2 || branch.length < 1 || !items.length) {
    return res.status(400).json({ ok: false, error: 'Please check the order details.' });
  }

  const lines = items.map((item) => {
    const name = clean(item?.name, 100);
    const qty = Number(item?.qty);
    const price = clean(item?.price, 30) || 'уточнити';
    if (!name || !Number.isInteger(qty) || qty < 1 || qty > 99) throw new Error('Invalid item');
    return `• ${name} — ${qty} шт. (${price} / саджанець)`;
  });
  const message = [
    '🍇 НОВЕ ЗАМОВЛЕННЯ — LOZA-SERHIIA',
    '',
    ...lines,
    '',
    `Ім’я: ${buyer}`,
    `Телефон: ${phone}`,
    `Нова пошта: ${city}, ${branch}`,
    note ? `Коментар: ${note}` : '',
  ].filter(Boolean).join('\n');
  if (message.length > 4096) return res.status(400).json({ ok: false, error: 'Order is too long.' });

  try {
    const telegramResponse = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
    });
    const telegramResult = await telegramResponse.json();
    if (!telegramResponse.ok || !telegramResult.ok) {
      return res.status(502).json({ ok: false, error: 'Telegram could not accept the order.' });
    }
    return res.status(200).json({ ok: true });
  } catch {
    return res.status(502).json({ ok: false, error: 'Could not contact Telegram.' });
  }
};
