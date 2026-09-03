# doh-gateway

一个跑在 Cloudflare Workers 或 Pages 上的 DoH（DNS-over-HTTPS）轻量反代网关。

如果你平时用 NextDNS、自建 AdGuard Home 或公共 DNS，但遇到国内网络阻断、运营商对已知 DoH 端口 QoS 限速，或者不希望把自己的 NextDNS ID 直接暴露在公网上被扫描器刷量，可以用它套一层自己的独立域名。

## 为什么写这个项目

很多现成的 DoH 代理脚本存在几个常见问题：
1. **上游写死**：大多把 Google 或 Cloudflare 的地址写死在源码里，换个上游还得改代码重新部署。
2. **没做鉴权**：公网扫到了就能随意调用，免费账户的月度查询额度几天就被刷光。
3. **丢失客户端 IP**：套上 CDN 以后，上游 DNS 只能看到 Cloudflare 节点的出口 IP，导致 EDNS（ECS）失效，流媒体或网站 CDN 被调度到很远的地方。

这个项目把这些逻辑理顺了：
- **上游完全解耦**：NextDNS、自建 AdGuard Home、Control D、Google、Cloudflare 都能用，改环境变量就行，不用改代码。
- **自定义防盗路径**：只有访问你设置的路径（比如 `/my-token`）才会处理请求，其他路径直接 404。
- **保留客户端 IP**：把真实的客户端 IP 写入 `X-Forwarded-For`，保证上游 CDN 调度和 NextDNS 后台日志准确。
- **动态设备名**：访问 `/my-token/OpenWrt` 或 `/my-token/iPhone` 时，会自动把设备名透传给 NextDNS 或 AdGuard Home。
- **边缘缓存**：对幂等的 GET 请求启用 Cloudflare 边缘缓存，重复域名直接从最近的节点秒回。
- **简单探活**：浏览器直接打开域名或密钥路径，只会返回纯文本 `OK`，既能确认服务是否在线，也不会泄露后端配置。

---

## 环境变量配置

所有配置都在 Cloudflare 后台的环境变量里设置，源码不需要做任何改动。

| 变量名 | 必填 | 示例 | 说明 |
| :--- | :---: | :--- | :--- |
| `SECRET_PATH` | 是 | `/my-secret-token` | 你的专属访问路径，必须以 `/` 开头 |
| `UPSTREAM_BASE` | 是 | `https://dns.nextdns.io/8df6ae` | 你要反代的上游 DNS 基础地址 |
| `ENABLE_CACHE` | 否 | `true` | 是否开启边缘缓存，默认开启 |
| `CACHE_TTL` | 否 | `120` | GET 请求缓存时间，单位为秒，默认 120 |

### 常见上游填写参考

- **NextDNS**：填 `https://dns.nextdns.io/你的配置ID`
- **自建 AdGuard Home**：填 `https://你的AGH域名/dns-query`
- **Google Public DNS**：填 `https://dns.google/dns-query`
- **Cloudflare DNS**：填 `https://cloudflare-dns.com/dns-query`
- **Control D**：填 `https://dns.controld.com/你的ResolverID`

---

## 部署教程

代码同时支持 Cloudflare Workers 和 Cloudflare Pages。推荐优先用 Workers；如果域名没有接入 Cloudflare 解析，可以用 Pages 走 CNAME 绑定。

### 方式 1：部署到 Cloudflare Workers（推荐）

1. 打开 [Cloudflare 控制台](https://dash.cloudflare.com/)，进入 **Workers 和 Pages**。
2. 点击 **创建** -> **创建 Worker**，起个名字，保存。
3. 进入该 Worker 的详情页，点击右上角 **编辑代码**。
4. 把项目里的 `_worker.js` 内容复制进去，替换掉原本的代码，点击 **部署**。
5. 返回 Worker 页面，进入 **设置** -> **变量和机密**：
   - 添加 `SECRET_PATH`，值填你的私有路径（例如 `/my-secret`）
   - 添加 `UPSTREAM_BASE`，值填目标上游（例如 `https://dns.nextdns.io/8df6ae`）
   - 保存并部署。
6. 进入 **设置** -> **触发器** -> **自定义域**，添加你自己的域名（例如 `doh.yourdomain.com`）。

### 方式 2：部署到 Cloudflare Pages

适合习惯用 Git 仓库管理，或者域名 DNS 不在 Cloudflare 的场景。

#### 选项 A：通过 GitHub 仓库部署
1. 把本项目上传或 Fork 到你自己的 GitHub。
2. 在 Cloudflare 控制台进入 **Workers 和 Pages** -> **创建** -> **Pages** -> **连接到 Git**。
3. 选择你的仓库，构建预设保持空白（不需要填任何构建命令），点击保存并部署。
4. 在 Pages 项目的 **设置** -> **环境变量** 中，为生产环境添加 `SECRET_PATH` 和 `UPSTREAM_BASE`。
5. 在 **自定义域** 页面绑定你自己的域名。如果域名在其他 DNS 服务商，按提示添加 CNAME 记录即可。

#### 选项 B：网页直接上传
1. 在本地建一个文件夹，把 `_worker.js` 放进去。
2. 在 Pages 页面选择 **直接上传**，上传该文件夹并发布。
3. 同样在项目设置里配好环境变量和自定义域名。

---

## 客户端配置指南

以自定义域名 `doh.yourdomain.com`、路径 `/my-secret` 为例：

### OpenWrt (Passwall2)
在 **DNS 设置** -> **远程 DNS** 中填入：
```text
https://doh.yourdomain.com/my-secret/OpenWrt,104.21.14.243
```
> 注：末尾加逗号和 IP（如 `,104.21.14.243`）是 Passwall 的 Bootstrap 语法，指定一个纯 IPv4 的 Cloudflare 节点解析 DoH 域名，防止代理节点因 IPv6 拨号失败导致断网。

### Clash / OpenClash
在配置文件的 `dns.nameserver` 字段中添加：
```yaml
dns:
  enable: true
  nameserver:
    - 'https://doh.yourdomain.com/my-secret/OpenClash'
```

### Android（私人 DNS）
在原生 Android 的私人 DNS 中使用需要主机名，如果使用第三方客户端（如 Intra、Nebulo 或 PersonalDNSFilter），可以直接输入完整的 DoH 地址：
```text
https://doh.yourdomain.com/my-secret/Phone
```

### 浏览器（Chrome / Edge / Firefox）
进入浏览器设置，搜索「安全 DNS」或「DoH」：
- 选择使用自定义提供商
- 填入：`https://doh.yourdomain.com/my-secret/Browser`

---

## 检查与验证

部署完成后，可以用 curl 做基础测试：

1. **探活测试**（应返回 `HTTP 200`，内容为 `OK`）：
   ```bash
   curl -i "https://doh.yourdomain.com/"
   curl -i "https://doh.yourdomain.com/my-secret"
   ```

2. **防盗门禁测试**（故意输错路径，应返回 `HTTP 404`）：
   ```bash
   curl -i "https://doh.yourdomain.com/wrong-path"
   ```

3. **真实 DNS 解析测试**（发送一段标准二进制报文，应返回 `HTTP 200` 及二进制内容）：
   ```bash
   curl -i "https://doh.yourdomain.com/my-secret?dns=EjQBAAABAAAAAAAAA3d3dwZnb29nbGUDY29tAAABAAE" -H "accept: application/dns-message"
   ```

如果你用的是 NextDNS，测试完成后去 NextDNS 控制台看一眼，应该已经能看到来自 `Browser` 或 `OpenWrt` 的解析记录了。

## License

MIT
