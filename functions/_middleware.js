// Root deployments must not serve SQL backups, server sources or local secret files.
export async function onRequest(context) {
  let path;
  try { path=decodeURIComponent(new URL(context.request.url).pathname); } catch { return new Response('Not found',{status:404}); }
  if (/(^|\/)\./.test(path) || /\.(sql|toml|md|map)$/i.test(path) || /^\/(server|tests|docs|migrations|scripts|workers|node_modules)(\/|$)/i.test(path) || /^\/(package(-lock)?\.json|wrangler[^/]*)$/i.test(path)) {
    return new Response('Not found',{status:404,headers:{'Cache-Control':'no-store'}});
  }
  return context.next();
}
