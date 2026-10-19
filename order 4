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
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid request body" }, 400, siteOrigin);
  }

  // Quietly accept honeypot submissions without forwarding them.
  if (clean(body?.website, 200)) return json({ ok: true }, 200, siteOrigin);

  const buyer = clean(body?.buyer, 100);
  const phone = clean(body?.phone, 30);
  const city = clean(body?.city, 100);
  const street = clean(body?.street, 140);
  const telegram = clean(body?.telegram, 100);
  const instagram = clean(body?.instagram, 100);
  const branch = clean(body?.branch, 100);
  const note = clean(body?.note, 500);
  const items = Array.isArray(body?.items) ? body.items.slice(0, 60) : [];

  if (buyer.length < 2 || !/^[+\d\s().-]{7,30}$/.test(phone) || city.length < 2 || street.length < 2 || !branch || !items.length) {
    return json({ ok: false, error: "Please check the order details." }, 400, siteOrigin);
  }

  const lines = [];
  for (const item of items) {
    const name = clean(item?.name, 100);
    const qty = Number(item?.qty);
    const price = clean(item?.price, 30) || "уточнити";
    if (!name || !Number.isInteger(qty) || qty < 1 || qty > 99) {
      return json({ ok: false, error: "Invalid item in the order." }, 400, siteOrigin);
    }
    lines.push(`• ${name} — ${qty} шт. (${price} / лоза)`);
  }

  const message = [
    "🍇 НОВЕ ЗАМОВЛЕННЯ — LOZA-SERHIIA",
    "",
    ...lines,
    "",
    `Ім’я: ${buyer}`,
    `Телефон: ${phone}`,
    `Нова пошта: ${city}, ${street}, відділення ${branch}`,
    telegram ? `Telegram: ${telegram}` : "",
    instagram ? `Instagram: ${instagram}` : "",
    note ? `Коментар: ${note}` : "",
  ].filter(Boolean).join("\n");
  if (message.length > 4096) return json({ ok: false, error: "Order is too long." }, 400, siteOrigin);

  try {
    const telegramResponse = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
    });
    const telegramResult = await telegramResponse.json();
    if (!telegramResponse.ok || !telegramResult.ok) {
      const detail = clean(telegramResult.description, 180) || `Telegram HTTP ${telegramResponse.status}`;
      console.error("Telegram send failed:", telegramResponse.status, detail);
      return json({ ok: false, error: detail }, 502, siteOrigin);
    }
    return json({ ok: true }, 200, siteOrigin);
  } catch {
    return json({ ok: false, error: "Could not contact Telegram." }, 502, siteOrigin);
  }
}
