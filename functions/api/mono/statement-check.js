
export async function onRequestPost({ request, env }) {
  const key = request.headers.get("X-Admin-Key");

  if (!env.MONO_ADMIN_KEY || key !== env.MONO_ADMIN_KEY) {
    return new Response("Forbidden", { status: 403 });
  }

  if (!env.MONO_TOKEN) {
    return Response.json(
      { success: false, error: "Missing MONO_TOKEN" },
      { status: 500 }
    );
  }

  const to = Math.floor(Date.now() / 1000);
  const from = to - 3600;

  const url =
    `https://api.monobank.ua/personal/statement/0/${from}/${to}`;

  try {
    const response = await fetch(url, {
      headers: { "X-Token": env.MONO_TOKEN }
    });

    if (!response.ok) {
      return Response.json({
        success: false,
        bankStatus: response.status
      }, { status: response.status });
    }

    const transactions = await response.json();

    if (!Array.isArray(transactions)) {
      throw new Error("Unexpected API response");
    }

    const incoming = transactions.filter(t =>
      t.amount > 0 &&
      t.currencyCode === 980 &&
      t.hold === false
    );

    return Response.json({
      success: true,
      message: "Statement connected",
      period: "Last 60 minutes",
      totalTransactions: transactions.length,
      incomingTransactions: incoming.length
    }, {
      headers: { "Cache-Control": "no-store" }
    });

  } catch {
    return Response.json({
      success: false,
      error: "Statement check failed"
    }, { status: 502 });
  }
}
