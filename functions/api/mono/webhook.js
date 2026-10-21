
export function onRequestGet() {
  return new Response("Webhook is working", {
    status: 200
  });
}

export function onRequestPost() {
  return new Response("Not configured yet", {
    status: 503
  });
}
