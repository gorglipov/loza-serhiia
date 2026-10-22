
const products = Object.freeze({ "grape-demo": 50000 });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (body, status) => Response.json(body, {
  status,
  headers: { "Cache-Control": "no-store" },
});

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get("Origin");
  const allowedOrigins = new Set([new URL(request.url).origin, env.SITE_ORIGIN].filter(Boolean));
  if (origin && !allowedOrigins.has(origin)) {
    return json({ error: "Forbidden origin" }, 403);
  }
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return json({ error: "Expected application/json" }, 415);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const productId = body?.product;
  const quantity = body?.quantity;
  if (typeof productId !== "string" || !Object.hasOwn(products, productId) ||
      !Number.isInteger(quantity) || quantity < 1 || quantity > 5) {
    return json({ error: "Invalid product or quantity" }, 400);
  }

  const key = request.headers.get("Idempotency-Key");
  if (key !== null && !uuid.test(key)) {
    return json({ error: "Invalid idempotency key" }, 400);
  }
  if (!env.DB || typeof env.DB.prepare !== "function") {
    return json({ error: "Order storage is unavailable" }, 503);
  }

  // Only the server catalog defines prices; browser price/amount/status are ignored.
  const amount = products[productId] * quantity;
  const orderId = "TEST-" + (key ? key.toLowerCase() : crypto.randomUUID());

  try {
    // Reusing a request key returns the same order, including after a lost response.
    // Existing clients without a key keep the original create-order behavior.
    const inserted = await env.DB.prepare(
      `INSERT INTO orders (id, amount_kop, status)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(orderId, amount, "pending").run();
    if (!inserted.success) throw new Error("Order insert failed");

    const order = await env.DB.prepare(
      "SELECT id, amount_kop, status FROM orders WHERE id = ?"
    ).bind(orderId).first();
    if (!order) throw new Error("Order read failed");
    if (order.amount_kop !== amount) {
      return json({ error: "Request key already belongs to a different order" }, 409);
    }

    return json({
      success: true,
      orderId: order.id,
      amount: order.amount_kop / 100,
      currency: "UAH",
      status: order.status,
      testOnly: true,
    }, inserted.meta.changes > 0 ? 201 : 200);
  } catch {
    return json({ error: "Database error" }, 500);
  }
}
