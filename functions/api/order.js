const json = (data, status = 200, origin = "") => new Response(JSON.stringify(data), {
  status,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
    "Vary": "Origin",
  },
});

const clean = (value, max = 180) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const telegramRequest = async (token, method, form) => {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    body: form,
  });
  const result = await response.json().catch(() => ({}));
  return { response, result };
};

export async function onRequest(context) {
  const { request, env } = context;
  const siteOrigin = env.SITE_ORIGIN || new URL(request.url).origin;
  const origin = request.headers.get("Origin");

  if (origin !== siteOrigin) return json({ ok: false, error: "Forbidden origin" }, 403);
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405, siteOrigin);

  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return json({ ok: false, error: "Telegram is not configured" }, 503, siteOrigin);

  let body;
  try {
    body = await request.formData();
  } catch {
    return json({ ok: false, error: "Invalid request body" }, 400, siteOrigin);
  }

  if (clean(body.get("website"), 200)) return json({ ok: true }, 200, siteOrigin);

  const buyer = clean(body.get("buyer"), 100);
  const phone = clean(body.get("phone"), 30);
  const city = clean(body.get("city"), 100);
  const cityRef = clean(body.get("cityRef"), 50);
  const street = clean(body.get("street"), 140);
  const streetRef = clean(body.get("streetRef"), 50);
  const telegram = clean(body.get("telegram"), 100);
  const instagram = clean(body.get("instagram"), 100);
  const branch = clean(body.get("branch"), 180);
  const branchRef = clean(body.get("branchRef"), 50);
  const note = clean(body.get("note"), 500);
  const paymentMethod = clean(body.get("paymentMethod"), 24);
  const reportedAmount = Number(body.get("paymentAmount"));
  const receipt = body.get("receipt");

  let items;
  try {
    items = JSON.parse(String(body.get("items") || "[]"));
  } catch {
    return json({ ok: false, error: "Invalid order items." }, 400, siteOrigin);
  }
  if (!Array.isArray(items)) items = [];
  items = items.slice(0, 60);

  const validNovaPoshtaRef = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  if (buyer.length < 2 || !/^\+?380\d{9}$/.test(phone.replace(/[\s().-]/g, "")) || city.length < 2 || !validNovaPoshtaRef(cityRef) || street.length < 2 || !validNovaPoshtaRef(streetRef) || !branch || !validNovaPoshtaRef(branchRef) || !items.length) {
    return json({ ok: false, error: "Please check the order details." }, 400, siteOrigin);
  }
  if (paymentMethod !== "full" && paymentMethod !== "deposit_cod") {
    return json({ ok: false, error: "Choose a payment method." }, 400, siteOrigin);
  }
  if (!receipt || typeof receipt.arrayBuffer !== "function" || !receipt.size) {
    return json({ ok: false, error: "Attach the bank transfer receipt." }, 400, siteOrigin);
  }
  if (receipt.size > 5 * 1024 * 1024) {
    return json({ ok: false, error: "The receipt must be no larger than 5 MB." }, 400, siteOrigin);
  }
  const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
  if (!allowedTypes.has(receipt.type)) {
    return json({ ok: false, error: "Attach a JPG, PNG, WEBP, or PDF receipt." }, 400, siteOrigin);
  }

  const lines = [];
  let orderTotal = 0;
  for (const item of items) {
    const name = clean(item?.name, 100);
    const qty = Number(item?.qty);
    const priceMatch = String(item?.price ?? "").match(/\d+(?:[.,]\d+)?/);
    const price = priceMatch ? Number(priceMatch[0].replace(",", ".")) : NaN;
    if (!name || !Number.isInteger(qty) || qty < 1 || qty > 99 || !Number.isFinite(price) || price <= 0) {
      return json({ ok: false, error: "Invalid item in the order." }, 400, siteOrigin);
    }
    orderTotal += price * qty;
    lines.push(`• ${name} — ${qty} шт. (${price} грн / лоза)`);
  }

  const paymentAmount = paymentMethod === "full" ? orderTotal : 150;
  if (reportedAmount !== paymentAmount) {
    return json({ ok: false, error: "The payment amount does not match the order." }, 400, siteOrigin);
  }
  if (paymentMethod === "deposit_cod" && orderTotal <= 150) {
    return json({ ok: false, error: "A 150 UAH deposit is available for orders over 150 UAH." }, 400, siteOrigin);
  }

  const orderRef = `LZ-${Date.now().toString(36).toUpperCase()}`;
  const paymentLabel = paymentMethod === "full"
    ? `Повна оплата: ${orderTotal} грн на картку (звірити надходження за чеком).`
    : `Передплата: 150 грн на картку; залишок ${orderTotal - 150} грн — післяплата Новою поштою (звірити надходження за чеком).`;
  const message = [
    `🍇 НОВЕ ЗАМОВЛЕННЯ — LOZA-SERHIIA · ${orderRef}`,
    "",
    ...lines,
    `Разом за каталогом: ${orderTotal} грн`,
    `Оплата: ${paymentLabel}`,
    "Підтвердження переказу: чек отримано; зарахування потрібно звірити в банку.",
    "",
    `Ім’я: ${buyer}`,
    `Телефон: ${phone}`,
    `Нова пошта: ${city}, ${street}, відділення ${branch}`,
    `Коди Нової пошти: населений пункт ${cityRef}; вулиця ${streetRef}; відділення ${branchRef}`,
    telegram ? `Telegram: ${telegram}` : "",
    instagram ? `Instagram: ${instagram}` : "",
    note ? `Коментар: ${note}` : "",
  ].filter(Boolean).join("\n");
  if (message.length > 4096) return json({ ok: false, error: "Order is too long." }, 400, siteOrigin);

  const fileName = clean(receipt.name || "payment-receipt", 100).replace(/[^\w.-]/g, "_");
  const caption = [
    `Чек до замовлення ${orderRef}`,
    paymentMethod === "full" ? `Повна оплата: ${paymentAmount} грн` : `Передплата: ${paymentAmount} грн + післяплата`,
    `Клієнт: ${buyer}, ${phone}`,
  ].join("\n");

  try {
    const receiptForm = new FormData();
    receiptForm.append("chat_id", chatId);
    receiptForm.append("document", receipt, fileName);
    receiptForm.append("caption", caption);
    const receiptResult = await telegramRequest(token, "sendDocument", receiptForm);
    if (!receiptResult.response.ok || !receiptResult.result.ok) {
      const detail = clean(receiptResult.result.description, 180) || `Telegram HTTP ${receiptResult.response.status}`;
      console.error("Telegram receipt send failed:", receiptResult.response.status, detail);
      return json({ ok: false, error: "Could not send the receipt to Telegram." }, 502, siteOrigin);
    }

    const messageForm = new FormData();
    messageForm.append("chat_id", chatId);
    messageForm.append("text", message);
    messageForm.append("disable_web_page_preview", "true");
    const orderResult = await telegramRequest(token, "sendMessage", messageForm);
    if (!orderResult.response.ok || !orderResult.result.ok) {
      const sentMessageId = receiptResult.result.result?.message_id;
      if (sentMessageId) {
        const deleteForm = new FormData();
        deleteForm.append("chat_id", chatId);
        deleteForm.append("message_id", String(sentMessageId));
        await telegramRequest(token, "deleteMessage", deleteForm).catch(() => {});
      }
      const detail = clean(orderResult.result.description, 180) || `Telegram HTTP ${orderResult.response.status}`;
      console.error("Telegram order send failed:", orderResult.response.status, detail);
      return json({ ok: false, error: "Could not send the order to Telegram." }, 502, siteOrigin);
    }

    return json({ ok: true, orderRef }, 200, siteOrigin);
  } catch {
    return json({ ok: false, error: "Could not contact Telegram." }, 502, siteOrigin);
  }
}
