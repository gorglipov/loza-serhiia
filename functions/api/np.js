const json = (data, status = 200, origin = "") => new Response(JSON.stringify(data), {
  status,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
    "Vary": "Origin",
  },
});

const clean = (value, max = 100) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function onRequest({ request, env }) {
  const siteOrigin = env.SITE_ORIGIN || new URL(request.url).origin;
  const origin = request.headers.get("Origin");
  if (origin !== siteOrigin) return json({ ok: false, error: "Forbidden origin" }, 403);
  if (request.method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405, siteOrigin);

  const apiKey = env.NOVA_POSHTA_API_KEY;
  if (!apiKey) return json({ ok: false, error: "Додайте секрет NOVA_POSHTA_API_KEY у Cloudflare Pages." }, 503, siteOrigin);

  const url = new URL(request.url);
  const type = clean(url.searchParams.get("type"), 20);
  const query = clean(url.searchParams.get("q"), 80);
  const settlementRef = clean(url.searchParams.get("settlementRef"), 50);
  let calledMethod;
  let methodProperties;

  if (type === "settlements") {
    if (query.length < 2) return json({ ok: true, data: [] }, 200, siteOrigin);
    calledMethod = "getSettlements";
    methodProperties = { FindByString: query, Warehouse: "1", Page: "1", Limit: "20" };
  } else if (type === "warehouses") {
    if (!uuid.test(settlementRef)) return json({ ok: false, error: "Спочатку виберіть населений пункт зі списку." }, 400, siteOrigin);
    calledMethod = "getWarehouses";
    methodProperties = { SettlementRef: settlementRef, Page: "1", Limit: "100" };
    if (query) methodProperties.FindByString = query;
  } else {
    return json({ ok: false, error: "Unknown Nova Poshta lookup." }, 400, siteOrigin);
  }

  try {
    const response = await fetch("https://api.novaposhta.ua/v2.0/json/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        apiKey,
        modelName: "AddressGeneral",
        calledMethod,
        methodProperties,
      }),
      signal: AbortSignal.timeout(8000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.success !== true) {
      console.error("Nova Poshta address lookup failed:", response.status);
      return json({ ok: false, error: "Не вдалося отримати довідник Нової пошти. Перевірте API-ключ і спробуйте ще раз." }, 502, siteOrigin);
    }

    const data = (Array.isArray(result.data) ? result.data : []).slice(0, type === "settlements" ? 20 : 100).map((item) => {
      if (type === "settlements") {
        const description = clean(item.Description, 100);
        const area = clean(item.AreaDescription, 100);
        const region = clean(item.RegionsDescription, 100);
        const settlementType = clean(item.SettlementTypeDescription, 40);
        return {
          ref: clean(item.Ref, 50),
          description,
          area,
          region,
          settlementType,
          label: [description, settlementType, area || region].filter(Boolean).join(" · "),
        };
      }
      const description = clean(item.Description, 180);
      const shortAddress = clean(item.ShortAddress || item.Description, 180);
      return {
        ref: clean(item.Ref, 50),
        description,
        shortAddress,
        number: clean(item.Number, 20),
        type: clean(item.CategoryOfWarehouseDescription || item.TypeOfWarehouse, 60),
        label: shortAddress && shortAddress !== description ? `${description} — ${shortAddress}` : description,
      };
    }).filter((item) => item.ref && item.label);

    return json({ ok: true, data }, 200, siteOrigin);
  } catch (error) {
    console.error("Nova Poshta address lookup failed:", error?.name || "request error");
    return json({ ok: false, error: "Сервіс Нової пошти тимчасово недоступний. Спробуйте ще раз." }, 502, siteOrigin);
  }
}
