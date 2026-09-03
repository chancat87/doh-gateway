export default {
  async fetch(request, env, ctx) {
    const rawSecret = env.SECRET_PATH;
    const rawUpstream = env.UPSTREAM_BASE;

    if (!rawSecret || !rawUpstream) {
      return new Response(
        '配置错误：请在 Cloudflare 环境变量中设置 SECRET_PATH 和 UPSTREAM_BASE',
        {
          status: 500,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        }
      );
    }

    const SECRET_PATH = ('/' + rawSecret.trim()).replace(/\/+/g, '/').replace(/\/+$/, '');
    const UPSTREAM_BASE = rawUpstream.trim().replace(/\/+$/, '');
    const ENABLE_CACHE = env.ENABLE_CACHE !== 'false';
    const CACHE_TTL = parseInt(env.CACHE_TTL || '120', 10);

    const url = new URL(request.url);
    const { pathname, search, searchParams } = url;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Accept',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const acceptHeader = request.headers.get('Accept') || '';
    const isDnsQuery =
      searchParams.has('dns') ||
      acceptHeader.includes('application/dns-message') ||
      acceptHeader.includes('application/dns-json') ||
      method === 'POST';

    // 浏览器或探针直接打开，返回简单状态文本
    if (method === 'GET' && !isDnsQuery) {
      return new Response('OK', {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // 路径鉴权：查询请求必须走私有路径
    if (pathname !== SECRET_PATH && !pathname.startsWith(SECRET_PATH + '/')) {
      return new Response('Not Found', { status: 404 });
    }

    // 提取子路径作为设备名
    const deviceName = pathname.slice(SECRET_PATH.length).replace(/^\/+/, '').replace(/\/+$/, '');
    let targetUrl = UPSTREAM_BASE;
    if (deviceName) {
      const encodedDevice = deviceName.split('/').map(encodeURIComponent).join('/');
      targetUrl += '/' + encodedDevice;
    }
    targetUrl += search;

    const upstreamHeaders = new Headers();
    const targetUrlObj = new URL(targetUrl);
    upstreamHeaders.set('Host', targetUrlObj.host);
    upstreamHeaders.set('User-Agent', request.headers.get('User-Agent') || 'Cloudflare-DoH-Gateway');
    upstreamHeaders.set('Accept', acceptHeader || 'application/dns-message');

    // 透传客户端真实 IP，保留 ECS 能力
    const clientIP = request.headers.get('CF-Connecting-IP');
    if (clientIP) {
      upstreamHeaders.set('X-Forwarded-For', clientIP);
      upstreamHeaders.set('X-Real-IP', clientIP);
    }

    const cache = caches.default;
    const isGet = method === 'GET';

    if (ENABLE_CACHE && isGet) {
      const cachedResponse = await cache.match(request);
      if (cachedResponse) {
        return cachedResponse;
      }
    }

    const fetchOptions = {
      method,
      headers: upstreamHeaders,
      redirect: 'follow',
    };

    if (method === 'POST') {
      const contentType = request.headers.get('Content-Type');
      if (contentType) {
        upstreamHeaders.set('Content-Type', contentType);
      }
      fetchOptions.body = request.body;
    } else if (method === 'GET' && ENABLE_CACHE) {
      fetchOptions.cf = {
        cacheEverything: true,
        cacheTtl: CACHE_TTL,
      };
    }

    try {
      const response = await fetch(targetUrl, fetchOptions);

      const responseHeaders = new Headers(response.headers);
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      responseHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Accept');

      if (ENABLE_CACHE && isGet && response.status === 200) {
        responseHeaders.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
      }

      const clientResponse = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });

      if (ENABLE_CACHE && isGet && response.status === 200) {
        ctx.waitUntil(cache.put(request, clientResponse.clone()));
      }

      return clientResponse;
    } catch (err) {
      return new Response('Bad Gateway', { status: 502 });
    }
  },
};
