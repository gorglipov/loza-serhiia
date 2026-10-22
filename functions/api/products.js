import { db, endpoint, json, requireSchema } from "../../server/checkout.js";

export const onRequest = context => endpoint(context, "GET", async context => {
  const database = db(context);
  await requireSchema(database);
  const result = await database.prepare(`SELECT p.id, p.name, p.price_kop, p.available, p.stock, p.is_demo, p.details_json,
    c.confirmed_price_kop, c.characteristics_confirmed
    FROM products p JOIN product_catalog c ON c.product_id=p.id WHERE p.is_demo=0 ORDER BY p.name COLLATE NOCASE`).all();
  return json({ success: true, products: result.results.sort((a,b)=>a.name.localeCompare(b.name,'uk')).map(row => ({
    id: row.id, name: row.name, priceKop: row.price_kop,
    priceConfirmed: row.price_kop !== null && row.confirmed_price_kop === row.price_kop,
    characteristicsConfirmed: Boolean(row.characteristics_confirmed),
    available: Boolean(row.available && row.stock > 0 && row.price_kop !== null && row.confirmed_price_kop === row.price_kop), stock: row.stock,
    isDemo: Boolean(row.is_demo), details: JSON.parse(row.details_json),
  })), maxQuantity: 5, paymentsEnabled: false });
});
