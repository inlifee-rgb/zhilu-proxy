# 智路 · CN 智能分流代理（Chrome 扩展）

> 中国域名 / IP 直连，海外流量全部走代理。代理决策写在 Chrome 自己的 PAC 里，**不依赖任何系统代理开关**——即使 Clash / 代理客户端的「系统代理」是关闭的，装了本扩展的这个 Chrome 依然按规则分流。

![manifest v3](https://img.shields.io/badge/Manifest-V3-2563EB?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-16A34A?style=flat-square)
![rules](https://img.shields.io/badge/rules-5500%20IPv4%20%2B%202019%20IPv6-7C3AED?style=flat-square)

## 它能做什么

- **智能分流**：中国域名、中国 IP 段直连；其余全部走你指定的 HTTP 代理（默认 `127.0.0.1:7897`）。
- **与实际系统代理解耦**：用 `chrome.proxy` API 注入 PAC，由 Chrome 自己决策，不用开 Clash 的「系统代理」或 TUN。
- **网络出口实时探测**：面板并排显示「代理出口 IP / 地区 / 运营商」和「本机真实公网 IP / 地区」，并自动判定代理是否真的生效。探测请求本身经过 PAC（`ipinfo.io` 走代理、`myip.ipip.net` 走直连），所以显示的是**实际分流效果**，不是理论值。
- **fail-open**：代理端口不通时自动临时直连，不会断网；恢复后自动切回。
- **自定义规则**：域名级强制直连 / 强制代理，支持后缀匹配。
- **浅色卡片式 UI**：单一健康状态卡，状态互斥、不打架。

## 分流判据（PAC，优先级从上到下）

1. 本地 / 内网地址 → `DIRECT`
2. 自定义「强制直连」域名 → `DIRECT`
3. 自定义「强制代理」域名 → `PROXY`
4. `.cn` 后缀 + 122 个内置中国域名后缀 → `DIRECT`
5. `dnsResolve()` 解析 IP，命中中国网段 → `DIRECT`
6. 其余全部 → `PROXY <host>:<port>`

规则数据来自 APNIC `delegated-apnic-latest`：**5,500 条 IPv4 CIDR + 2,019 条 IPv6 CIDR + 122 个域名后缀**，压缩后 `data-cn.js` 约 115KB。

## 安装

1. 克隆本仓库到本地
2. 打开 `chrome://extensions`，开启右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选择仓库根目录（含 `manifest.json` 的那一层）
4. 安装弹窗会要求「**更改代理设置**」权限 → 点**允许**（不给这个权限无法接管代理）
5. 点工具栏图标，确认「Chrome 实际模式」显示 **PAC 智能分流**

> 首次加载若出口探测报权限错误，移除扩展后重新「加载已解压的扩展程序」一次即可。

## 配置

默认端口 `7897`（常见 Clash Verge mixed-port 之一，非通用默认 7890）。若你的代理端口不同，在面板「代理入口」直接改 host + port。

面板功能：

| 区域 | 说明 |
|---|---|
| 健康卡 | 单一状态裁决：正常 / 提醒 / 需处理 / 已暂停；含总开关 |
| 网络出口 | 代理出口 vs 本机真实 IP、地区、运营商；可刷新 |
| 分流模式 | 智能分流 / 全部直连 / 全部代理 |
| 代理入口 | host + port，实时探测端口存活 |
| 自定义规则 | 域名级强制直连 / 强制代理 |
| 高级选项 | DNS 判定、内置域名库、代理离线自动直连 |

## 工作原理

```
网页请求 → Chrome 网络栈 → 本扩展注入的 PAC（FindProxyForURL）
                              ├─ 命中中国域名/IP → DIRECT
                              └─ 其余 → PROXY 127.0.0.1:<port>
                                          → 你的本地代理客户端 → 海外出口
```

探测「代理出口」时，请求 `https://ipinfo.io/json` 被 PAC 判为海外 → 走代理 → 得到出口 IP；
探测「本机真实」时，请求 `https://myip.ipip.net` 被 PAC 判为国内 → 直连 → 得到本机公网 IP。

## 隐私

- 不上传任何浏览数据；规则数据在本地生成。
- 出口探测只请求两个公开的 IP 地理信息接口（`ipinfo.io` / `myip.ipip.net`），用于显示当前出口；可随时关闭面板不发请求。
- Clash API 相关的 secret 只存在扩展本地存储，不写入代码、不上传。

## 边界（说清楚，免得误会）

- 只接管**装了本扩展的这个 Chrome**；其他浏览器、客户端软件、系统流量不受影响。要全系统分流请用系统代理或 TUN。
- DNS 判定依赖系统解析。若被污染把海外域名解析成中国 IP，会误判直连——此时关掉「DNS 解析判定」，只用域名库 + 自定义规则即可。
- `ipinfo.io` 免费额度有限，频繁点刷新可能被限流；不影响分流功能。

## 开发 / 回归测试

```bash
node tools/test_pac.js        # PAC 判定 + API 签名 + 出口探测 全量回归（需 Node.js）
python tools/build_cn_data.py tools/apnic-cn-lines.txt   # 由 APNIC 原始数据重新生成 data-cn.js
python tools/make_icons.py    # 重新生成 16/32/48/128 图标
```

测试桩严格模拟 Chrome bindings：拒绝 `scope` 属性、要求 details + callback、校验 PAC 纯 ASCII，并验证代理写入成功后清空历史错误。

## 数据更新

从 [APNIC](https://ftp.apnic.net/apnic/stats/apnic/delegated-apnic-latest) 下载 `delegated-apnic-latest`，取 `apnic|CN|` 行存为 `tools/apnic-cn-lines.txt`，运行 `python tools/build_cn_data.py tools/apnic-cn-lines.txt` 重新生成 `data-cn.js`。中国域名后缀在 `tools/cn-domains.txt` 维护。

## License

MIT — 见 [LICENSE](LICENSE)。
