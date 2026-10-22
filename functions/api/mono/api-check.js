
export async function onRequestPost({ request, env }) {
  const key = request.headers.get("X-Admin-Key");

  if (
    !env.MONO_WEBHOOK_KEY ||
    !key ||
    key !== env.MONO_WEBHOOK_KEY
  ) {
    return new Response("Forbidden", {
      status: 403
    });
  }

  if (!env.MONO_TOKEN) {
    return Response.json({
      success: false,
      error: "MONO_TOKEN is missing"
    }, { status: 500 });
  }

  try {
    const response = await fetch(
      "https://api.monobank.ua/personal/client-info",
      {
        headers: {
          "X-Token": env.MONO_TOKEN
        }
      }
    );

    if (!response.ok) {
      return Response.json({
        success: false,
        bankStatus: response.status
      });
    }

    return Response.json({
      success: true,
      message: "Monobank API connected"
    });

  } catch {
    return Response.json({
      success: false,
      error: "Connection failed"
    }, { status: 502 });
  }
}
