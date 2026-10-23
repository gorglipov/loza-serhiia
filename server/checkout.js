const encoder = new TextEncoder();
export const MAX_QUANTITY = 5;
export const MAX_PROOF_BYTES = 600000;
export const DELIVERY_METHODS = [
  { id: "nova_poshta", name: "Нова пошта" },
];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class StoreError extends Error {
  constructor(code, message, status = 400, retryAfter = 0) {
    super(message);
    Object.assign(this, { code, status, retryAfter });
  }
}

export function json(data, status = 200, extra = {}) {
  return Response.json(data, { status, headers: {
    "Cache-Control": "no-store, private",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...extra,
  } });
}

export async function endpoint(context, method, handler) {
  try {
    if (context.request.method !== method) return json({ success: false, error: "Метод не підтримується." }, 405, { Allow: method });
    if (method === "POST") {
      const { request } = context;
      if (request.headers.get("Origin") !== new URL(request.url).origin || request.headers.get("Sec-Fetch-Site") === "cross-site") {
        throw new StoreError("FORBIDDEN", "Запит не дозволено.", 403);
      }
      if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
        throw new StoreError("INVALID_FORMAT", "Неправильний формат даних.", 415);
      }
    }
    return await handler(context);
  } catch (error) {
    if (error instanceof StoreError) {
      return json({ success: false, code: error.code, error: error.message, ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) }, error.status,
        error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {});
    }
    // Never expose SQL, personal data, tokens or internal exception messages.
    return json({ success: false, code: "STORE_UNAVAILABLE", error: "Магазин тимчасово недоступний. Спробуйте пізніше." }, 503);
  }
}

export function db(context) {
  if (!context.env.DB?.prepare) throw new StoreError("STORE_UNAVAILABLE", "Магазин тимчасово недоступний.", 503);
  // All read-then-write operations use the primary; do not depend on a stale replica.
  return context.env.DB.withSession ? context.env.DB.withSession("first-primary") : context.env.DB;
}

export async function requireSchema(database) {
  const row = await database.prepare("SELECT version FROM loza_store_migrations WHERE version = ?").bind("0005_manual_availability").first();
  if (!row) throw new StoreError("STORE_UNAVAILABLE", "Магазин тимчасово недоступний. Спробуйте пізніше.", 503);
}

export async function body(request, maxBytes = 16384) {
  const reader = request.body?.getReader();
  if (!reader) throw new StoreError("INVALID_BODY", "Заповніть дані замовлення.");
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel();
      throw new StoreError("BODY_TOO_LARGE", "Забагато даних у запиті.", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new StoreError("INVALID_BODY", "Неправильний формат даних."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StoreError("INVALID_BODY", "Неправильний формат даних.");
  return value;
}

export function normalizeItems(input) {
  if (!Array.isArray(input) || !input.length || input.length > 20) throw new StoreError("INVALID_ITEMS", "Додайте від 1 до 20 різних товарів.");
  const seen = new Set();
  const items = input.map(item => {
    if (!item || typeof item.productId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.productId) ||
      !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QUANTITY || seen.has(item.productId)) {
      throw new StoreError("INVALID_ITEMS", "Перевірте товари та кількість: від 1 до 5 штук кожного.");
    }
    seen.add(item.productId);
    return { productId: item.productId, quantity: item.quantity };
  });
  return items.sort((a, b) => a.productId.localeCompare(b.productId, "en"));
}

function text(value, label, min, max) {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) throw new StoreError("INVALID_DETAILS", `Перевірте поле «${label}».`);
  const result = value.normalize("NFC").trim().replace(/\s+/g, " ");
  if (result.length < min || result.length > max) throw new StoreError("INVALID_DETAILS", `Перевірте поле «${label}».`);
  return result;
}

export function normalizeOrder(input) {
  const items = normalizeItems(input.items);
  const name = text(input.customer?.name, "Ім’я", 2, 100);
  let phone = text(input.customer?.phone, "Телефон", 9, 25).replace(/[\s()-]/g, "");
  if (/^0\d{9}$/.test(phone)) phone = "+38" + phone;
  if (/^380\d{9}$/.test(phone)) phone = "+" + phone;
  if (!/^\+380\d{9}$/.test(phone)) throw new StoreError("INVALID_DETAILS", "Вкажіть український номер телефону у форматі +380XXXXXXXXX.");
  const method = input.delivery?.method;
  if (!DELIVERY_METHODS.some(item => item.id === method)) throw new StoreError("INVALID_DETAILS", "Оберіть спосіб доставки.");
  const city = text(input.delivery?.city, "Місто", 2, 100);
  const branch = text(input.delivery?.branch, "Відділення доставки", 1, 180);
  const commentInput = input.comment ?? "";
  const comment = text(typeof commentInput === "string" ? commentInput.replace(/[\r\n\t]/g, " ") : commentInput, "Коментар", 0, 1000);
  const paymentMode = input.payment?.mode;
  if (!["full", "deposit_cod"].includes(paymentMode)) {
    throw new StoreError("INVALID_PAYMENT", "Оберіть повну передоплату або передоплату 100 грн із післяплатою.");
  }
  return { items, customer: { name, phone }, delivery: { city, method, branch }, comment, payment: { mode: paymentMode } };
}

// Payment preference only; no card charge, payment acceptance or bank verification.
export function paymentBreakdown(amountKop, mode) {
  if (!Number.isSafeInteger(amountKop) || amountKop < 1 || !["full","deposit_cod"].includes(mode)) {
    throw new StoreError("INVALID_PAYMENT", "Не вдалося розрахувати спосіб оплати.");
  }
  if (mode === "deposit_cod" && amountKop < 10000) {
    throw new StoreError("INVALID_PAYMENT", "Передоплата 100 грн доступна лише для замовлень від 100 грн.");
  }
  const advanceKop = mode === "full" ? amountKop : 10000;
  return { mode, advanceKop, codKop: amountKop - advanceKop };
}
export const paymentMarker = mode => "[LOZA_PAYMENT:" + mode + "] ";
export function paymentFromStored(comment, amountKop) {
  const match = /^\[LOZA_PAYMENT:(full|deposit_cod)\] /.exec(comment || "");
  if (!match) return { mode: null, advanceKop: null, codKop: null };
  try { return paymentBreakdown(amountKop, match[1]); }
  catch { return { mode: null, advanceKop: null, codKop: null }; }
}

// A receipt is evidence submitted by the buyer, never verification of a bank transfer.
export function normalizePaymentProof(input, expectedAmountKop) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      !Number.isSafeInteger(input.reportedAmountKop) || input.reportedAmountKop !== expectedAmountKop) {
    throw new StoreError("INVALID_PAYMENT_PROOF", "Вкажіть точну суму переказу, яка збігається з передоплатою.");
  }
  const file = input.proof;
  if (!file || typeof file !== "object" || Array.isArray(file) ||
      !["image/jpeg", "image/png", "application/pdf"].includes(file.mimeType) ||
      typeof file.dataBase64 !== "string" || file.dataBase64.length > Math.ceil(MAX_PROOF_BYTES * 4 / 3) + 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.dataBase64)) {
    throw new StoreError("INVALID_PAYMENT_PROOF", "Додайте чек у форматі JPG, PNG або PDF (до 600 КБ).");
  }
  let decoded;
  try { decoded = atob(file.dataBase64); }
  catch { throw new StoreError("INVALID_PAYMENT_PROOF", "Не вдалося прочитати квитанцію."); }
  if (decoded.length < 32 || decoded.length > MAX_PROOF_BYTES) {
    throw new StoreError("INVALID_PAYMENT_PROOF", "Розмір квитанції має бути до 600 КБ.");
  }
  const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
  const isPng = bytes.length > 8 && [137,80,78,71,13,10,26,10].every((v,i) => bytes[i] === v);
  const isJpeg = bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const isPdf = bytes.length > 5 && [37,80,68,70,45].every((v,i) => bytes[i] === v);
  if (!(file.mimeType === "image/png" && isPng || file.mimeType === "image/jpeg" && isJpeg || file.mimeType === "application/pdf" && isPdf)) {
    throw new StoreError("INVALID_PAYMENT_PROOF", "Вміст квитанції не відповідає вибраному формату.");
  }
  return { mimeType: file.mimeType, bytes, reportedAmountKop: input.reportedAmountKop };
}

export async function digest(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function requestKey(request) {
  const key = request.headers.get("Idempotency-Key");
  if (!key || !uuid.test(key)) throw new StoreError("INVALID_KEY", "Оновіть сторінку та повторіть спробу.");
  return digest("loza-order-v2:" + key.toLowerCase());
}

export function configured(env) {
  const site = env.TURNSTILE_SITE_KEY;
  return typeof site === "string" && site.length >= 10 && !/^[123]x0+/.test(site) &&
    typeof env.TURNSTILE_SECRET_KEY === "string" && env.TURNSTILE_SECRET_KEY.length >= 10 && !/^[123]x0+/.test(env.TURNSTILE_SECRET_KEY) &&
    typeof env.CHECKOUT_SECURITY_KEY === "string" && env.CHECKOUT_SECURITY_KEY.length >= 32;
}

export async function rateLimit(context, database, scope, limit) {
  const secret = context.env.CHECKOUT_SECURITY_KEY;
  if (typeof secret !== "string" || secret.length < 32) throw new StoreError("CHECKOUT_UNAVAILABLE", "Оформлення тимчасово недоступне. Спробуйте пізніше.", 503);
  const ip = context.request.headers.get("CF-Connecting-IP") || "unknown";
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(scope + ":" + ip));
  const bucket = Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("");
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / 60) * 60;
  const row = await database.prepare(`INSERT INTO checkout_rate_limits(bucket_key, window_start, hits) VALUES (?, ?, 1)
    ON CONFLICT(bucket_key) DO UPDATE SET
      hits = CASE WHEN window_start = excluded.window_start THEN hits + 1 ELSE 1 END,
      window_start = excluded.window_start RETURNING hits`).bind(bucket, window).first();
  if (!row) throw new Error("Rate limit unavailable");
  if (row.hits === 1 && context.waitUntil) context.waitUntil(database.prepare("DELETE FROM checkout_rate_limits WHERE window_start < ?").bind(now - 3600).run().catch(() => {}));
  if (row.hits > limit) throw new StoreError("RATE_LIMITED", "Забагато запитів. Зачекайте трохи та повторіть спробу.", 429, 60 - (now - window));
}

export async function verifyTurnstile(context, token) {
  if (!configured(context.env)) throw new StoreError("CHECKOUT_UNAVAILABLE", "Оформлення тимчасово недоступне. Спробуйте пізніше.", 503);
  if (typeof token !== "string" || !token || token.length > 2048) throw new StoreError("TURNSTILE_REQUIRED", "Пройдіть перевірку перед надсиланням.");
  let result;
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: context.env.TURNSTILE_SECRET_KEY, response: token, remoteip: context.request.headers.get("CF-Connecting-IP") || undefined, idempotency_key: crypto.randomUUID() }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("Verification unavailable");
    result = await response.json();
  } catch { throw new StoreError("TURNSTILE_UNAVAILABLE", "Перевірка тимчасово недоступна. Спробуйте ще раз.", 503); }
  if (result.success !== true || result.action !== "loza_checkout" || result.hostname !== new URL(context.request.url).hostname) {
    throw new StoreError("TURNSTILE_INVALID", "Повторіть перевірку та надішліть форму ще раз.");
  }
}

export async function quote(database, items) {
  // Placeholders depend only on a bounded item count, never on user text.
  const rows = await database.prepare(`SELECT p.id, p.name, p.price_kop, p.available, p.stock, p.is_demo,
    c.confirmed_price_kop,a.in_stock FROM products p LEFT JOIN product_catalog c ON c.product_id=p.id
    LEFT JOIN product_availability a ON a.product_id=p.id
    WHERE p.id IN (${items.map(() => "?").join(",")})`).bind(...items.map(item => item.productId)).all();
  const byId = new Map(rows.results.map(product => [product.id, product]));
  const lines = items.map(item => {
    const product = byId.get(item.productId);
    if (!product || product.is_demo || !product.in_stock || !Number.isSafeInteger(product.price_kop) || product.price_kop < 1 || product.confirmed_price_kop !== product.price_kop) {
      throw new StoreError("STOCK_UNAVAILABLE", "Наявність або ціна товару змінилася. Оновіть кошик.", 409);
    }
    return { productId: product.id, name: product.name, quantity: item.quantity, unitPriceKop: product.price_kop, lineTotalKop: product.price_kop * item.quantity, stock: product.stock, isDemo: Boolean(product.is_demo) };
  });
  return { lines, amountKop: lines.reduce((sum, line) => sum + line.lineTotalKop, 0), currency: "UAH", paymentsEnabled: false, demoOnly: lines.every(line => line.isDemo) };
}

export async function findReceipt(database, keyHash) {
  return database.prepare(`SELECT o.id, o.amount_kop, o.status, c.payload_hash, c.demo_only, c.comment
    FROM order_checkout c JOIN orders o ON o.id = c.order_id WHERE c.request_key_hash = ?`).bind(keyHash).first();
}

// Manual transfers happen outside LOZA. The card is intended for display during
// checkout, but must be configured in Cloudflare (never stored in GitHub or D1).
export function manualTransferCard(env) {
  if (!env || env.MANUAL_TRANSFER_ENABLED !== "true") return null;
  const card = typeof env.MANUAL_TRANSFER_CARD === "string"
    ? env.MANUAL_TRANSFER_CARD.replace(/[\s-]/g, "")
    : "";
  if (!/^\d{16,19}$/.test(card)) return null;
  // Reject accidentally mistyped card numbers (Luhn checksum).
  let sum = 0;
  for (let i = card.length - 1, position = 0; i >= 0; i--, position++) {
    let digit = Number(card[i]);
    if (position % 2) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  if (sum % 10 !== 0) return null;
  return card;
}

export function manualTransferForReceipt(row, env) {
  if (!row || row.demo_only) return null;
  const terms = paymentFromStored(row.comment, row.amount_kop);
  const card = manualTransferCard(env);
  if (!card || !terms.mode || !Number.isSafeInteger(terms.advanceKop) || terms.advanceKop < 1) return null;
  return { card, amountKop: terms.advanceKop, reference: row.id };
}

export function receipt(row, status = 200, env = null) {
  // No customer, phone, delivery or comments are returned, even to key holders.
  // Manual transfer details are available only after a valid private receipt lookup.
  return json({ success: true, orderId: row.id, amountKop: row.amount_kop, amount: row.amount_kop / 100, currency: "UAH", status: row.status, statusLabel: row.status === "pending" ? "Очікує підтвердження" : "Статус оновлено продавцем", payment: paymentFromStored(row.comment, row.amount_kop), paymentVerified: false, testOnly: Boolean(row.demo_only), paymentsEnabled: false, manualTransfer: manualTransferForReceipt(row, env) }, status);
}
