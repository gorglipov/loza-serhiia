import {test} from "node:test";
import assert from "node:assert/strict";
import {manualTransferForReceipt, receipt} from "../server/checkout.js";

// Public payment-network fixture only. NEVER replace it with a real owner's card.
const fixtureCard = "4111 1111 1111 1111";
const env = {MANUAL_TRANSFER_ENABLED: "true", MANUAL_TRANSFER_CARD: fixtureCard};
const order = (mode = "deposit_cod") => ({
  id: "LOZA-fixture-order",
  amount_kop: 30000,
  status: "pending",
  demo_only: 0,
  comment: "[LOZA_PAYMENT:" + mode + "] fixture order",
});

test("manual transfer is disabled unless both server variables are correctly set", () => {
  assert.equal(manualTransferForReceipt(order(), null), null);
  assert.equal(manualTransferForReceipt(order(), {MANUAL_TRANSFER_CARD: fixtureCard}), null);
  assert.equal(manualTransferForReceipt(order(), {MANUAL_TRANSFER_ENABLED: "true"}), null);
  assert.equal(manualTransferForReceipt(order(), {...env, MANUAL_TRANSFER_CARD: "not-a-card"}), null);
  assert.equal(manualTransferForReceipt(order(), {...env, MANUAL_TRANSFER_CARD: "4111111111111112"}), null);
  assert.equal(manualTransferForReceipt(order(), {...env, MANUAL_TRANSFER_ENABLED: "false"}), null);
});

test("server independently determines exact transfer amount for each payment mode", () => {
  assert.deepEqual(manualTransferForReceipt(order(), env), {
    card: fixtureCard.replace(/\s/g, ""), amountKop: 10000, reference: "LOZA-fixture-order",
  });
  assert.equal(manualTransferForReceipt(order("full"), env).amountKop, 30000);
});

test("old/invalid and demo orders never expose a transfer card", () => {
  assert.equal(manualTransferForReceipt({...order(), demo_only: 1}, env), null);
  assert.equal(manualTransferForReceipt({...order(), comment: "old order"}, env), null);
  assert.equal(manualTransferForReceipt({...order(), amount_kop: 9999}, env), null);
  assert.equal(manualTransferForReceipt({...order(), amount_kop: 0}, env), null);
});

test("receipt exposes only payment instruction under explicit flag, not payment verification", async () => {
  const live = await receipt(order(), 201, env).json();
  assert.equal(live.manualTransfer.amountKop, 10000);
  assert.equal(live.paymentVerified, false);
  assert.equal(live.paymentsEnabled, false);
  assert.equal(live.testOnly, false);
  assert.ok(!("customer" in live));
  const off = await receipt(order(), 200, {MANUAL_TRANSFER_ENABLED: "false", MANUAL_TRANSFER_CARD: fixtureCard}).json();
  assert.equal(off.manualTransfer, null);
  const demo = await receipt({...order(), demo_only: 1}, 200, env).json();
  assert.equal(demo.manualTransfer, null);
});
