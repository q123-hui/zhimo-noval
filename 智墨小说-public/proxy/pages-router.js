/**
 * 智墨小说 · 免费中转（Cloudflare Pages，无需域名）
 *
 * 作用：把请求原样转发给已部署的 Worker。
 * 客户端只需要访问 https://<项目名>.pages.dev/api/ai，
 * 国内多数网络可以直连 pages.dev，而 workers.dev 常被拦。
 *
 * API Key、激活码逻辑全部还在 Worker 里，客户端拿不到任何密钥。
 */

// 换成你自己部署的 Worker 地址（勿把真实地址提交到公共仓库）
const UPSTREAM = 'https://your-worker-name.your-subdomain.workers.dev';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  // x-device：App 上报本机设备标识，服务端据此判断「一个码用了几台手机」
  'Access-Control-Allow-Headers': 'Content-Type, x-license, x-device, x-gen, x-admin-token',
  'Access-Control-Expose-Headers': 'x-license-days-left, x-license-quota-left',
  'Access-Control-Max-Age': '86400'
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // 首页给个提示，方便浏览器里自检
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
      return new Response(
        JSON.stringify({ ok: true, service: 'zhimo-ai-pages-proxy', upstream: UPSTREAM, path: '/api/ai' }, null, 2),
        { headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } }
      );
    }

    // 只有 /api/* 才转给 Worker；其余路径（安装页、版本清单、APK）一律交给 Pages 静态资源。
    // 原来只放行 /update.json 和 /download/，新增页面会被误当 API 转发，返回 405。
    if (!url.pathname.startsWith('/api/')) {
      if (env && env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('not found', { status: 404, headers: CORS });
    }

    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('cf-connecting-ip');
    headers.delete('cf-ipcountry');

    const init = { method: request.method, headers, redirect: 'follow' };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body;
    }

    let res;
    try {
      res = await fetch(UPSTREAM + url.pathname + url.search, init);
    } catch (e) {
      return new Response(
        JSON.stringify({ ok: false, error: { code: 'UPSTREAM_UNREACHABLE', message: String(e) } }),
        { status: 502, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } }
      );
    }

    const out = new Headers(res.headers);
    for (const [k, v] of Object.entries(CORS)) out.set(k, v);
    out.delete('content-security-policy');

    return new Response(res.body, { status: res.status, headers: out });
  }
};
