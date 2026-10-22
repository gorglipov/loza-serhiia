import { body, db, endpoint, findReceipt, json, rateLimit, receipt, requestKey, requireSchema } from "../../../server/checkout.js";

export const onRequest = context => endpoint(context, "POST", async context => {
  const database = db(context);
  await requireSchema(database);
  await rateLimit(context, database, "receipt", 30);
  await body(context.request);
  const row = await findReceipt(database, await requestKey(context.request));
  if (!row) return json({ success: false, code: "NOT_FOUND", error: "Підтвердження ще не знайдено. Можна повторити надсилання з тим самим ключем." }, 404);
  return receipt(row);
});
