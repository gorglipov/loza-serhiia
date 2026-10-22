
export async function onRequestPost({ request, env }) {
  let body;

  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Invalid JSON" },
      { status: 400 }
    );
  }

  // Тестовий товар і ціна
  const products = {
    "grape-demo": 50000
  };

  const productId = body?.product;
  const quantity = body?.quantity;

  if (
    !Object.hasOwn(products, productId) ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 5
  ) {
    return Response.json(
      { error: "Invalid product or quantity" },
      { status: 400 }
    );
  }

  const amount = products[productId] * quantity;
  const orderId = "TEST-" + crypto.randomUUID();

  try {
    await env.DB.prepare(
      `INSERT INTO orders
       (id, amount_kop, status)
       VALUES (?, ?, ?)`
    ).bind(
      orderId,
      amount,
      "pending"
    ).run();

    return Response.json({
      success: true,
      orderId: orderId,
      amount: amount / 100,
      currency: "UAH",
      status: "pending",
      testOnly: true
    }, { status: 201 });

  } catch {
    return Response.json(
      { error: "Database error" },
      { status: 500 }
    );
  }
}
