export const onRequestGet = () => new Response(null, { status: 302, headers: { Location: "/#catalog", "Cache-Control": "no-store" } });
