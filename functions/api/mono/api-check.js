import {protectAdmin} from '../../../server/access.js';
import {json} from '../../../server/checkout.js';
// Retire the shared-webhook-key bank probe. It must not bypass Access or trigger live calls.
export async function onRequestPost(context){
  return protectAdmin({...context,next:async()=>json({success:false,code:'MONO_LIVE_DISABLED',
    error:'Живі запити до банку вимкнені. Тестовий моніторинг доступний в адмінпанелі Preview.'},409)});
}
