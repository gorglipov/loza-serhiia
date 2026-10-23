import { body, db, endpoint, json, manualTransferCard, normalizeItems, quote, rateLimit, requireSchema } from "../../../server/checkout.js";

export const onRequest = context => endpoint(context, "POST", async context => {
  const database = db(context);
  await requireSchema(database);
  await rateLimit(context, database, "quote", 90);
  const input = await body(context.request);
  const estimate = await quote(database, normalizeItems(input.items));
  const ready = await database.prepare("SELECT version FROM loza_store_migrations WHERE version='0011_payment_proofs'").first();
  return json({ success: true, ...estimate,
    manualTransferCard: ready && !estimate.demoOnly ? manualTransferCard(context.env) : null });
});
