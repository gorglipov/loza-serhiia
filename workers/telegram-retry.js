// Deploy separately to Preview only after binding a separate Preview DB.
import {deliverPending} from '../server/telegram.js';
export default {
  async scheduled(_event,env,context) { context.waitUntil(deliverPending(env.DB,env,10)); },
  fetch() { return new Response('Not found',{status:404}); }
};
