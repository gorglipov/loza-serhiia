import {inspectReceipt} from '../../../server/receipt-analysis.js';
import { body, configured, db, digest, endpoint, findReceipt, manualTransferCard, normalizeOrder, normalizePaymentProof, paymentBreakdown, paymentMarker, quote, rateLimit, receipt, requestKey, requireSchema, StoreError, verifyTurnstile } from "../../../server/checkout.js";
import { queueOrder, scheduleNotifications } from '../../../server/telegram.js';

export const onRequest = context => endpoint(context, "POST", async context => {
  const database = db(context);
  await requireSchema(database);
  await rateLimit(context, database, "create", 8);
  if (!configured(context.env)) throw new StoreError("CHECKOUT_UNAVAILABLE", "Оформлення тимчасово недоступне. Спробуйте пізніше.", 503);
  if (!manualTransferCard(context.env)) throw new StoreError("CHECKOUT_UNAVAILABLE", "Реквізити оплати тимчасово недоступні.", 503);
  if (!await database.prepare("SELECT version FROM loza_store_migrations WHERE version='0011_payment_proofs'").first()) {
    throw new StoreError("CHECKOUT_UNAVAILABLE", "Завантаження квитанцій ще не налаштовано.", 503);
  }
  const input = await body(context.request, 2100000);
  const order = normalizeOrder(input);
  const keyHash = await requestKey(context.request);
  // The same idempotency key must always be paired with exactly the same order and proof.
  const proofFingerprint = typeof input.payment?.proof?.dataBase64 === 'string'
    ? await digest(input.payment.proof.dataBase64) : '';
  const payloadHash = await digest(JSON.stringify(order) + ':' + input.payment?.reportedAmountKop + ':' + input.payment?.proof?.mimeType + ':' + proofFingerprint);
  const existing = await findReceipt(database, keyHash);
  if (existing) {
    if (existing.payload_hash !== payloadHash) throw new StoreError("IDEMPOTENCY_CONFLICT", "Попередній запит уже прийнято з іншими даними. Перевірте його підтвердження.", 409);
    scheduleNotifications(context,database);
    return receipt(existing, 200, context.env);
  }

  await verifyTurnstile(context, input.turnstileToken);
  const estimate = await quote(database, order.items);
  // Recompute the payable amounts from the trusted D1 quote, never from browser totals.
  const terms = paymentBreakdown(estimate.amountKop, order.payment.mode);
  const proof = normalizePaymentProof(input.payment, terms.advanceKop);
  await inspectReceipt(context.env,proof,input.payment.proof.dataBase64,terms.advanceKop);
  const hashBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', proof.bytes));
  const fileHash = Array.from(hashBytes, byte => byte.toString(16).padStart(2, '0')).join('');
  // Preserve the payment preference with the order; this is not proof of money received.
  const storedComment = paymentMarker(order.payment.mode) + order.comment;
  const items = JSON.stringify(order.items);
  const id = "LOZA-" + crypto.randomUUID();
  try {
    // batch is a transaction. The migration trigger validates, snapshots prices and
    // checks manual availability inside this transaction, without changing any quantities.
    await database.batch([
      database.prepare(`INSERT INTO orders (id, amount_kop, status)
        SELECT ?, SUM(p.price_kop * json_extract(j.value, '$.quantity')), 'pending'
        FROM json_each(?) j JOIN products p ON p.id = json_extract(j.value, '$.productId')`).bind(id, items),
      database.prepare(`INSERT INTO order_checkout
        (order_id, request_key_hash, payload_hash, buyer_name, phone, city, delivery_method, delivery_branch, comment, items_json, demo_only)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
          id, keyHash, payloadHash, order.customer.name, order.customer.phone,
          order.delivery.city, order.delivery.method, order.delivery.branch, storedComment, items, estimate.demoOnly ? 1 : 0
        ),
      database.prepare(`INSERT INTO order_payment_proofs (order_id, reported_amount_kop, mime_type, file_sha256, file_content)
        VALUES (?, ?, ?, ?, ?)`).bind(id, proof.reportedAmountKop, proof.mimeType, fileHash, proof.bytes),
      queueOrder(database,id),
    ]);
  } catch (error) {
    // A concurrent retry may have committed first, or the original response was lost.
    const saved = await findReceipt(database, keyHash);
    if (saved) {
      if (saved.payload_hash !== payloadHash) throw new StoreError("IDEMPOTENCY_CONFLICT", "Попередній запит уже прийнято з іншими даними. Перевірте його підтвердження.", 409);
      scheduleNotifications(context,database);
      return receipt(saved, 200, context.env);
    }
    if(String(error.message).includes('LOZA_PROOF_AMOUNT_CHANGED'))throw new StoreError('INVALID_PAYMENT_PROOF','Сума замовлення змінилася. Зв’яжіться з продавцем для звірки переказу.',409);
    if (String(error.message).includes("LOZA_STOCK_UNAVAILABLE")) throw new StoreError("STOCK_UNAVAILABLE", "Наявність або ціна змінилася. Оновіть кошик і повторіть спробу.", 409);
    throw error;
  }
  const saved = await findReceipt(database, keyHash);
  if (!saved) throw new Error("Receipt unavailable");
  scheduleNotifications(context,database);
  return receipt(saved, 201, context.env);
});
