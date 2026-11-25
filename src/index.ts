interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let targetReq = request;

    // Route /<char>.json -> /json/<char>.json automatically
    if (request.method === "GET" || request.method === "HEAD") {
      const m = url.pathname.match(/^\/([^/]+\.json)$/);
      if (m) {
        const rewritten = new URL(`/json/${m[1]}`, url);
        targetReq = new Request(rewritten.toString(), request);
      }
    }

    const res = await env.ASSETS.fetch(targetReq);
    const headers = new Headers(res.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  },
};
