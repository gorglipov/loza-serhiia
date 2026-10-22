import { db, endpoint, json, requireSchema } from "../../server/checkout.js";

export const onRequest = context => endpoint(context, "GET", async context => {
  const database = db(context);
  await requireSchema(database);
  const result = await database.prepare(`SELECT id, name, price_kop, available, stock, is_demo, details_json
    FROM products WHERE is_demo = 1 OR price_kop IS NOT NULL ORDER BY is_demo DESC, name COLLATE NOCASE`).all();
  return json({ success: true, products: result.results.map(row => ({
    id: row.id, name: row.name, priceKop: row.price_kop, available: Boolean(row.available && row.stock > 0), stock: row.stock,
    isDemo: Boolean(row.is_demo), details: JSON.parse(row.details_json),
  })), maxQuantity: 5, paymentsEnabled: false });
});
