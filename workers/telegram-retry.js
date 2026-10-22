// Deploy separately to Preview only after binding a separate Preview DB.
import {deliverPending} from '../server/telegram.js';
import {deliverMonitorNotifications} from '../server/mono-monitor.js';
export default {
  async scheduled(_event,env,context) { context.waitUntil(Promise.allSettled([
    deliverPending(env.DB,env,10),deliverMonitorNotifications(env.DB,env,5)
  ])); },
  fetch() { return new Response('Not found',{status:404}); }
};
