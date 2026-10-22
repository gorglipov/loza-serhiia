import { configured, DELIVERY_METHODS, endpoint, json } from "../../../server/checkout.js";
import {SUPPORT_REASONS} from '../../../server/support.js';

export const onRequest = context => endpoint(context, "GET", async ({ env }) => json({
  success: true,
  checkoutAvailable: configured(env),
  turnstileSiteKey: configured(env) ? env.TURNSTILE_SITE_KEY : null,
  supportAvailable: configured(env),
  supportReasons: SUPPORT_REASONS,
  deliveryMethods: DELIVERY_METHODS,
  paymentsEnabled: false,
}));
