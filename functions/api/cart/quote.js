import { body, db, endpoint, json, normalizeItems, quote, rateLimit, requireSchema } from "../../../server/checkout.js";

export const onRequest = context => endpoint(context, "POST", async context => {
  const database = db(context);
  await requireSchema(database);
  await rateLimit(context, database, "quote", 90);
  const input = await body(context.request);
  return json({ success: true, ...await quote(database, normalizeItems(input.items)) });
});
