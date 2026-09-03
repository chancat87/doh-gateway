# doh-gateway

一个运行在 Cloudflare Workers 或 Pages 上的通用 DOH（DNS-over-HTTPS）反代服务器。

可以将 NextDNS、自建 AdGuard Home，或者 Google、Cloudflare 等公共 DNS 服务，反代并绑定到你自己的独立域名上。

---

### 干嘛用的？

平时直接用公共 DoH 或 NextDNS 时，经常会遇到几个痛点：
1. **防止被封锁与限速**：国内部分运营商会对已知的公共 DoH（如 Google 的 8.8.8.8、NextDNS 官方域名）进行干扰、丢包或针对 UDP/TCP 443 端口 QoS 限速。套上自己的 CF 域名后，走的是普通 HTTPS 流量，可以有效绕过针对特定 DNS 域名的阻断。
2. **隐藏私有配置与防止盗刷**：NextDNS、Control D 这类服务都带有你的专属账户 ID；自建的 AdGuard Home 也有固定的服务器 IP。如果直接把原地址填在各种设备上或暴露在公网，很容易被扫描器探测并刷爆免费请求额度。通过本项目，只有访问你设定的专属路径（Token）才会处理，别人访问一律 404。
3. **解决 CDN 丢失客户端真实 IP 的问题**：普通反代脚本如果直接转发，上游 DNS 只能拿到 Cloudflare 节点的机房 IP，导致 ECS（EDNS Client Subnet）失效，国内或海外的视频流、下载 CDN 会被错误调度到十万八千里外。本项目会自动提取客户端公网 IP 写入 `X-Forwarded-For`，让上游权威 DNS 进行准确的就近调度。
4. **统一多设备管理**：路由器、电脑、手机可以共用同一个反代域名，只需在 URL 末尾加个设备名标签（如 `/Token/OpenWrt`、`/Token/Phone`），NextDNS 后台就能自动分类统计每台设备的日志。
5. 上面4个理由都是场面话,我写这个主要目的就只是给家里的openwrt路由器的插件passwall2 远程DNS使用的

---

### 特点
1. **防盗用**：自定义安全路径（Token）。别人不带路径直接访问根域名，或者输错路径，一律返回 `404 Not Found` 页面，防止 Workers 请求数被异常消耗。
2. **全平台自适应**：上游地址在后台通过变量填写，无论是 NextDNS、自建 AdGuard Home 还是 Google、Cloudflare 全兼容，更换上游服务无需改动代码。
3. **保留真实 IP**：自动将客户端真实 IP 写入 `X-Forwarded-For`，保证上游 DNS 的 ECS 就近调度与 NextDNS/AGH 客户端识别准确。
4. **动态设备名**：支持在路径后追加设备名（如 `/Token/OpenWrt`、`/Token/iPhone`），自动映射到 NextDNS 控制台，无需在服务端预先配置规则。
5. **自带边缘缓存**：默认对 GET 查询启用 120 秒 Cloudflare 边缘缓存，重复域名直接从最近的 CDN 节点秒回，省流且提速。
6. **极简探活**：带上正确的 Token 路径直接用浏览器打开，会返回纯文本 `OK`，方便确认服务是否通畅，同时不会向外泄露任何后端配置和账户隐私。
7. **修正 Host 头**：自动将 Host 重写为上游目标域名，避免 Google 等公共 DNS 因 Host 头不匹配而拒绝请求（报 403）。

---

## 环境变量配置

在 Cloudflare 后台添加以下两个环境变量即可，源码无需任何改动：

| 变量名 | 必填 | 示例 | 说明 |
| --- | :---: | --- | --- |
| `SECRET_PATH` | 是 | `/my-dns` | 你的专属访问路径（Token），必须以 `/` 开头 |
| `UPSTREAM_BASE` | 是 | `https://dns.nextdns.io/你的ID` | 你要反代的上游 DNS 完整基础地址 |

> 注：网关默认已开启 120 秒边缘缓存，无需在环境变量中额外配置缓存参数。

### 常用UPSTREAM_BASE地址参考
- **NextDNS**：`https://dns.nextdns.io/你的配置ID`
- **自建 AdGuard Home**：`https://你的AGH域名/dns-query`
- **Google Public DNS**：`https://dns.google/dns-query`
- **Cloudflare 1.1.1.1**：`https://cloudflare-dns.com/dns-query`
- **Control D**：`https://dns.controld.com/你的ResolverID`

---

## 部署教程

本项目支持 Cloudflare Workers 和 Cloudflare Pages 两种方式。任选一种部署即可。

### 方式一：部署到 Cloudflare Workers（推荐，最省心）

适用于域名已经在 Cloudflare 托管解析的用户。

1. **创建 Worker**：
   - 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)；
   - 点击左侧 **Workers 和 Pages** -> **创建** -> **创建 Worker**；
   - 给 Worker 起个名字（例如 `my-doh`），点击 **保存**。
2. **部署代码**：
   - 进入该 Worker 详情页，点击右上角 **编辑代码**；
   - 把本项目中的 `_worker.js` 代码全部复制进去，替换掉自带的内容，点击右上角 **部署**。
3. **配置环境变量**：
   - 返回 Worker 详情页，点击 **设置** -> **变量和机密**；
   - 点击 **添加**，配置以下两个变量：
     - 变量名：`SECRET_PATH`，值填你的防盗路径（如 `/my-dns`）
     - 变量名：`UPSTREAM_BASE`，值填你的目标 DNS（如 `https://dns.nextdns.io/你的ID` 或 `https://dns.google/dns-query`）
   - 点击 **部署** 保存。
4. **绑定自定义域名**：
   - 在 Worker 详情页点击 **设置** -> **触发器**；
   - 找到 **自定义域**，点击 **添加自定义域**；
   - 填入你准备好的二级域名（如 `doh.yourdomain.com`），Cloudflare 会自动完成 DNS 记录解析并签发 SSL 证书。

---

### 方式二：部署到 Cloudflare Pages

适用于希望用 GitHub 联动自动构建，或者**域名 DNS 解析在阿里云、腾讯云等外部服务商（无需将 NS 改给 CF，通过 CNAME 接入）**的用户。

#### 选项 A：通过 GitHub 仓库关联部署（推荐）
1. 将本项目 Fork 或上传到你自己的 GitHub 仓库。
2. 登录 Cloudflare 控制台，进入 **Workers 和 Pages** -> **创建** -> 选择 **Pages** -> **连接到 Git**。
3. 选择刚才包含本项目的仓库：
   - 项目名称随意；
   - 生产分支选 `main`；
   - **框架预设保持 None，构建命令与输出目录全部留空**。
4. 点击 **保存并部署**。
5. 部署完成后，进入该 Pages 项目的 **设置** -> **环境变量**：
   - 在 **生产** 环境中添加 `SECRET_PATH` 和 `UPSTREAM_BASE` 两个变量并保存。
6. 进入 **自定义域**：
   - 绑定你自己的域名（例如 `doh.yourdomain.com`）；
   - 如果你的域名不在 Cloudflare 解析，按照页面提示，在你的域名 DNS 服务商后台添加一条 CNAME 记录指向分配的 `*.pages.dev` 地址即可完成接入。

#### 选项 B：网页直接上传文件夹部署
1. 在本地创建一个文件夹，把项目中的 `_worker.js` 放进去。
2. 在 Cloudflare Pages 页面选择 **直接上传**，拖入该文件夹完成初次部署。
3. 随后同样在项目 **设置** 中添加上述两个环境变量和绑定自定义域名。

---

## 客户端配置指南

假设你的绑定域名为 `doh.yourdomain.com`，防盗路径设为 `/my-dns`：

### 1. OpenWrt (Passwall2)
进入 Passwall2 的 **DNS 设置** -> **远程 DNS** 中填入：
```text
https://doh.yourdomain.com/my-dns/OpenWrt,104.21.14.243
```
> **排坑说明**：末尾的 `,104.21.14.243` 是 Passwall2 原生支持的 Bootstrap 语法。因为部分纯 IPv4 的 VPS 代理节点在尝试连接 Cloudflare 时，可能会优先解析出 CF 的 IPv6 地址导致拨号失败断网。显式指定一个 Cloudflare 的 IPv4 地址（随便一个能用的cf ip即可），可以彻底避免这一断流问题。

### 2. Clash / OpenClash
在配置文件的 `dns.nameserver` 字段中添加：
```yaml
dns:
  enable: true
  nameserver:
    - 'https://doh.yourdomain.com/my-dns/OpenClash'
```

### 3. Android（系统私人 DNS / 第三方客户端）
原生 Android 的「私人 DNS」仅支持填入纯域名/主机名（DoT 协议）。如果你使用的是支持完整 DoH URL 的客户端（如 Intra、Nebulo 或 PersonalDNSFilter），直接填入：
```text
https://doh.yourdomain.com/my-dns/Phone
```

### 4. iOS / macOS
苹果系统原生支持通过描述文件使用加密 DNS。可以使用在线工具（如 [DNS-Configuration-Builder](https://dns.notjakob.com/)）生成 `.mobileconfig` 描述文件，填入你的专属 DoH 地址后下载安装到系统即可。

### 5. 电脑浏览器（Chrome / Edge / Firefox）
打开浏览器设置，搜索「安全 DNS」或「DoH」：
- 启用安全 DNS 并选择「使用自定义提供商」；
- 填入：`https://doh.yourdomain.com/my-dns/PC`

---

## 检查与验证

部署成功后，可以使用 curl 进行快速测试：

1. **防盗门禁测试**（不带路径直接访问域名，或故意输错路径，应该返回 `404 Not Found`）：
   ```bash
   curl -i "https://doh.yourdomain.com/"
   curl -i "https://doh.yourdomain.com/wrong-path"
   ```

2. **连通性探活测试**（带上正确的 Token 访问，应该返回 `HTTP 200`，内容为 `OK`）：
   ```bash
   curl -i "https://doh.yourdomain.com/my-dns"
   curl -i "https://doh.yourdomain.com/my-dns/OpenWrt"
   ```

3. **真实 DNS 解析测试**（发送一段标准二进制 DNS 查询包，应该秒回 `HTTP 200` 且包含二进制应答）：
   ```bash
   curl -i "https://doh.yourdomain.com/my-dns?dns=EjQBAAABAAAAAAAAA3d3dwZnb29nbGUDY29tAAABAAE" -H "accept: application/dns-message"
   ```

如果你反代的是 NextDNS，测试完毕后登录 NextDNS 官方控制台，在设备列表里应该已经能实时看到刚才打上去的 `OpenWrt` 或 `PC` 设备的解析记录了。

---

## License

MIT
