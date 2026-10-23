import { body, db, endpoint, json, manualTransferCard, normalizeItems, quote, rateLimit, requireSchema } from "../../../server/checkout.js";

export const onRequest = context => endpoint(context, "POST", async context => {
  const database = db(context);
  await requireSchema(database);
  await rateLimit(context, database, "quote", 90);
  const input = await body(context.request);
  const estimate = await quote(database, normalizeItems(input.items));
  const ready = await database.prepare("SELECT version FROM loza_store_migrations WHERE version='0011_payment_proofs'").first();
  const card = manualTransferCard(context.env);
  // Temporary Preview diagnostic: booleans only, never expose secret values.
  const isPreview = new URL(context.request.url).hostname.endsWith(".loza-serhiia.pages.dev");
  const paymentDiagnostic = isPreview ? {
    migrationReady: Boolean(ready),
    demoOnly: Boolean(estimate.demoOnly),
    enabledExactlyTrue: context.env.MANUAL_TRANSFER_ENABLED === "true",
    cardBindingPresent: typeof context.env.MANUAL_TRANSFER_CARD === "string" && context.env.MANUAL_TRANSFER_CARD.length > 0,
    cardFormatValid: Boolean(manualTransferCard({
      MANUAL_TRANSFER_ENABLED: "true",
      MANUAL_TRANSFER_CARD: context.env.MANUAL_TRANSFER_CARD
    }))
  } : undefined;
  return json({ success: true, ...estimate,
    manualTransferCard: ready && !estimate.demoOnly ? card : null,
    ...(paymentDiagnostic ? { paymentDiagnostic } : {}) });
});
