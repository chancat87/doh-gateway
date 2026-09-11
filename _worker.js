/**
 * 通用纯净 DoH DNS反代网关 
 */

export default {
  async fetch(request, env, ctx) {
    // ------------------------------------------------------------------
    // 1. 环境变量读取与严格校验
    // ------------------------------------------------------------------
    const rawSecret = env.SECRET_PATH;
    const rawUpstream = env.UPSTREAM_BASE;

    // 缺少必要变量时，安全报错拦截
    if (!rawSecret || !rawUpstream) {
      return new Response(
        '配置错误：请在 Cloudflare 环境变量中设置 SECRET_PATH 和 UPSTREAM_BASE',
        {
          status: 500,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        }
      );
    }

    // 规范化格式 (确保 SECRET_PATH 以 / 开头且末尾无 /，UPSTREAM_BASE 末尾无 /)
    const SECRET_PATH = ('/' + rawSecret.trim()).replace(/\/+/g, '/').replace(/\/+$/, '');
    const UPSTREAM_BASE = rawUpstream.trim().replace(/\/+$/, '');

    // 门禁路径安全校验：配置过短（如仅 "/"）会折叠为空串导致门禁对全部路径放行，必须拒绝启动
    if (SECRET_PATH.length < 4) {
      return new Response(
        '配置错误：SECRET_PATH 过短或非法，请设置至少 4 个字符的秘密路径',
        {
          status: 500,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        }
      );
    }

    // 边缘缓存默认开启，缓存 120 秒（无需在环境变量中额外配置）
    const ENABLE_CACHE = env.ENABLE_CACHE !== 'false';
    const CACHE_TTL = parseInt(env.CACHE_TTL || '120', 10);

    const url = new URL(request.url);
    const { pathname, search, searchParams } = url;
    const method = request.method;

    // pathname 是百分号编码形式；先还原为原始文本再做门禁匹配与设备名提取，
    // 保证中文等非 ASCII 的 SECRET_PATH 与设备名能够正确匹配，且不会被二次编码
    let decodedPathname = pathname;
    try { decodedPathname = decodeURIComponent(pathname); } catch (_) { /* 含非法编码序列时保留原值 */ }

    // ------------------------------------------------------------------
    // 2. CORS 跨域预检放行 (OPTIONS)
    // ------------------------------------------------------------------
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

    // ------------------------------------------------------------------
    // 3. 严格防盗门禁：不带路径直接访问根域名、或输错路径，一律返回 404 Not Found
    // ------------------------------------------------------------------
    if (decodedPathname !== SECRET_PATH && !decodedPathname.startsWith(SECRET_PATH + '/')) {
      return new Response('Not Found', { status: 404 });
    }

    // ------------------------------------------------------------------
    // 4. 探活检测：只有路径完全命中 SECRET_PATH 且非 DNS 查询时，返回 OK 供排查
    // ------------------------------------------------------------------
    const acceptHeader = request.headers.get('Accept') || '';
    const isDnsQuery = searchParams.has('dns') || 
                       acceptHeader.includes('application/dns-message') || 
                       acceptHeader.includes('application/dns-json') || 
                       method === 'POST';

    if (method === 'GET' && !isDnsQuery) {
      return new Response('OK', {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // ------------------------------------------------------------------
    // 5. 提取设备名 (${deviceName}) 并自适应拼装上游目标
    // ------------------------------------------------------------------
    const deviceName = decodedPathname.slice(SECRET_PATH.length).replace(/^\/+/, '').replace(/\/+$/, '');
    let targetUrl = UPSTREAM_BASE;
    if (deviceName) {
      const encodedDevice = deviceName.split('/').map(encodeURIComponent).join('/');
      targetUrl += '/' + encodedDevice;
    }
    targetUrl += search;

    // ------------------------------------------------------------------
    // 6. 构造上游请求头（重要：强制改写 Host 为上游主机，避免公共 DNS 拒绝请求）
    // ------------------------------------------------------------------
    const upstreamHeaders = new Headers();
    const targetUrlObj = new URL(targetUrl);
    upstreamHeaders.set('Host', targetUrlObj.host);
    upstreamHeaders.set('User-Agent', request.headers.get('User-Agent') || 'Cloudflare-DoH-Gateway');
    upstreamHeaders.set('Accept', acceptHeader || 'application/dns-message');

    // 透传真实客户端 IP 供上游进行 ECS (EDNS Client Subnet) 就近调度与设备审计
    const clientIP = request.headers.get('CF-Connecting-IP');
    if (clientIP) {
      upstreamHeaders.set('X-Forwarded-For', clientIP);
      upstreamHeaders.set('X-Real-IP', clientIP);
    }

    // ------------------------------------------------------------------
    // 7. 边缘缓存检索 (仅针对 GET 幂等查询)
    // ------------------------------------------------------------------
    const cache = caches.default;
    const isGet = method === 'GET';

    if (ENABLE_CACHE && isGet) {
      const cachedResponse = await cache.match(request);
      if (cachedResponse) {
        return cachedResponse;
      }
    }

    // ------------------------------------------------------------------
    // 8. 零拷贝管道流式转发
    // ------------------------------------------------------------------
    const fetchOptions = {
      method: method,
      headers: upstreamHeaders,
      redirect: 'follow',
      signal: AbortSignal.timeout(5000), // 上游 5 秒超时，防止 DoH 查询挂起占用连接
    };

    if (method === 'POST') {
      const contentType = request.headers.get('Content-Type');
      if (contentType) {
        upstreamHeaders.set('Content-Type', contentType);
      }
      fetchOptions.body = request.body; // 管道直通，避免内存驻留
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

      // 注入边缘缓存控制头
      if (ENABLE_CACHE && isGet && response.status === 200) {
        responseHeaders.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
      }

      const clientResponse = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });

      // 异步写入 Cloudflare 边缘缓存
      if (ENABLE_CACHE && isGet && response.status === 200) {
        ctx.waitUntil(cache.put(request, clientResponse.clone()));
      }

      return clientResponse;
    } catch (err) {
      return new Response('Bad Gateway', { status: 502 });
    }
  },
};
