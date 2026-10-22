
function authorized(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");

  return Boolean(
    env.MONO_WEBHOOK_KEY &&
    key &&
    key === env.MONO_WEBHOOK_KEY
  );
}

export function onRequestGet({ request, env }) {
  if (!authorized(request, env)) {
    return new Response("Forbidden", {
      status: 403
    });
  }

  return new Response("Webhook ready", {
    status: 200
  });
}

export async function onRequestPost({ request, env }) {
  if (!authorized(request, env)) {
    return new Response("Forbidden", {
      status: 403
    });
  }

  let event;

  try {
    event = await request.json();
  } catch {
    return new Response("Invalid JSON", {
      status: 400
    });
  }

  const account = event?.data?.account;
  const item = event?.data?.statementItem;

  if (
    event?.type !== "StatementItem" ||
    typeof account !== "string" ||
    typeof item?.id !== "string" ||
    !Number.isInteger(item.amount) ||
    !Number.isInteger(item.currencyCode)
  ) {
    return new Response("Invalid event", {
      status: 400
    });
  }

  try {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO mono_events
      (transaction_id, account_id, amount_kop,
       currency_code, description, is_hold)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      item.id,
      account,
      item.amount,
      item.currencyCode,
      typeof item.description === "string"
        ? item.description : null,
      item.hold ? 1 : 0
    ).run();

    return new Response("OK", {
      status: 200
    });

  } catch {
    console.error("Webhook storage failed");

    return new Response("Database error", {
      status: 500
    });
  }
}
