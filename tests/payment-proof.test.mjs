import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PROOF_BYTES, manualTransferCard, normalizePaymentProof, StoreError } from '../server/checkout.js';

const bytes = Uint8Array.from([137,80,78,71,13,10,26,10, ...new Array(40).fill(0)]);
const payload = (amount = 10000, mimeType = 'image/png', content = bytes) => ({
  reportedAmountKop: amount,
  proof: { mimeType, dataBase64: Buffer.from(content).toString('base64') },
});
const invalid = (input, amount = 10000) => assert.throws(() => normalizePaymentProof(input, amount),
  error => error instanceof StoreError && error.code === 'INVALID_PAYMENT_PROOF');

test('exact claimed 100 UAH or full-price amount is accepted with a real file signature', () => {
  const deposit = normalizePaymentProof(payload(), 10000);
  assert.equal(deposit.reportedAmountKop, 10000);
  assert.equal(deposit.mimeType, 'image/png');
  assert.deepEqual(deposit.bytes, bytes);
  assert.equal(normalizePaymentProof(payload(45000), 45000).reportedAmountKop, 45000);
});

test('missing receipt and claimed amount differences reject checkout', () => {
  invalid({ reportedAmountKop: 10000 });
  invalid(payload(9999));
  invalid(payload(10001));
  invalid(payload(10000), 45000);
  invalid(payload('10000'));
});

test('only bounded JPEG/PNG/PDF bytes with matching file type are accepted', () => {
  invalid(payload(10000, 'application/pdf'));
  invalid(payload(10000, 'image/svg+xml'));
  invalid(payload(10000, 'image/png', new Uint8Array(31)));
  invalid(payload(10000, 'image/png', new Uint8Array(MAX_PROOF_BYTES + 1)));
  invalid({ reportedAmountKop: 10000, proof: { mimeType: 'image/png', dataBase64: '123!?=' } });
  const pdf = Buffer.from('%PDF-1.7\n' + 'x'.repeat(32));
  assert.equal(normalizePaymentProof(payload(10000, 'application/pdf', pdf), 10000).mimeType, 'application/pdf');
});

test('card shown before checkout still requires enabled, valid server secret', () => {
  assert.equal(manualTransferCard({ MANUAL_TRANSFER_ENABLED: 'true', MANUAL_TRANSFER_CARD: '4111 1111 1111 1111' }), '4111111111111111');
  assert.equal(manualTransferCard({ MANUAL_TRANSFER_ENABLED: 'false', MANUAL_TRANSFER_CARD: '4111111111111111' }), null);
  assert.equal(manualTransferCard({ MANUAL_TRANSFER_ENABLED: 'true', MANUAL_TRANSFER_CARD: '4111111111111112' }), null);
});
