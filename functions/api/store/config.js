import {supportReady} from '../../../server/support.js';
import { configured, DELIVERY_METHODS, endpoint, json,db } from "../../../server/checkout.js";

export const onRequest = context => endpoint(context, "GET", async context => {const {env}=context;let available=false;if(env.SUPPORT_ENABLED==='true' && configured(env)){try{available=await supportReady(db(context));}catch{}}return json({
  success: true,
  checkoutAvailable: configured(env),
  turnstileSiteKey: configured(env) ? env.TURNSTILE_SITE_KEY : null,
  deliveryMethods: DELIVERY_METHODS,
  paymentsEnabled: false,
  supportAvailable:available,
});});
