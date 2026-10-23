# Receipt analysis rollout

Cloudflare Workers AI integration is prepared, disabled by default. No bank API or automatic payment confirmation is added.

## Before enabling

1. Confirm account c2d2a30578b113a5494f7915348093ad and its Workers plan. Current OAuth can read Pages but subscription lookup returns 403 / Cloudflare 10000. Do not infer Free from this failure.
2. Workers AI pricing: https://developers.cloudflare.com/workers-ai/platform/pricing/ — 10,000 neurons/day allocation; Paid accounts can incur overage. Do not enable on Paid without budget approval and a spending control. No additional paid service was enabled by this change.
3. Add the Production Pages Workers AI binding named `AI` only after billing approval. Keep `RECEIPT_AI_ENABLED` unset until the model smoke test succeeds with synthetic images.
4. Model: `@cf/qwen/qwen3.8-27b`. Documentation: https://developers.cloudflare.com/workers-ai/models/qwen3.8-27b/ . Image input is a data URL inside messages; `store:false`, no gateway caching or raw response logging. No names, card numbers or expected payment amount are included in the prompt.
5. Validate clear 100.00 UAH / full payment fixtures, wrong sum, unreadable images, non-receipts and moderation failures. These are probabilistic classifiers, not proof of authenticity. Never use a real customer's receipt for development.
6. Set Production `RECEIPT_AI_ENABLED=true` only after successful tests. Publish the privacy notice to customers before processing their files.
7. Images only: JPG/PNG. In AI mode PDF is rejected on the server with a request to upload a screenshot; it never silently bypasses image moderation. Server-side all-page PDF rendering/moderation is not implemented.

## Behavior

Disabled: existing private receipt upload and owner review continue; no AI request is made.
Enabled without binding or failed inference: rejects the request without creating an order. Retry does not imply a second payment.
Enabled with valid output: rejects sexual/uncertain/nonreceipt/pending payments, non-UAH or ambiguous amount, and any amount not exactly equal to the server's current quote (100 UAH deposit or full amount). The expected amount is not sent to the model. Only a valid structured response is accepted. Model confidence is not a calibrated guarantee; manual bank verification remains required.

Do not claim that OCR detects every fake or every NSFW image. The order remains pending and paymentVerified=false; owner receipt review, observed amount and bank settlement confirmation guards stay in force.

## Larger files

0014 rebuilds the private proof table to raise its BLOB cap from 600,000 to 1,500,000 bytes, below D1's 2,000,000-byte row limit. Existing bytes, SHA256 and timestamps are copied exactly; all four immutable/exact amount/order confirmation triggers are recreated. Back up and test before applying Production; never modify migration 0011 in place. Apply 0014 before deploying the larger-file checkout.

## Current preflight (2026-10-23)

The user confirmed Workers Free. Three synthetic model checks returned HTTP 200: clear 100.00 UAH extraction accepted as visible evidence with bankVerified=false; visible test/sample marking rejected; non-receipt image rejected. No customer files were sent. Unit tests cover sexual/uncertain classifications and exact integer amount mismatches. A synthetic mock without a visible sample label can still look like a receipt; this explicitly demonstrates why authenticity/bank settlement cannot be automated from pixels.

Adding the Production Pages AI binding via API was rejected with HTTP 400 / Cloudflare 8000022. No flag was enabled. The user was asked to add Workers AI binding `AI` through Production Pages Settings → Bindings. Do not enable RECEIPT_AI_ENABLED until this binding is verified and a fresh deployment contains it. No Preview binding or Preview D1 change was requested.
