# 隐私说明

> 适用范围：SlopLens 浏览器扩展 v0.8.0 及之后版本。
> 最后更新：2026-11-01

## 一句话

**默认状态下它不联网、不收集、不上传任何东西。** 唯一会往外发数据的动作是「深检」，
而且必须你亲手点、用你自己的 key、发给你自己填的地址。

---

## 默认状态：零网络

装上不配置，它就是一段在页面里跑的本地代码：

- 没有服务器，没有账号，没有遥测，没有崩溃上报，没有使用统计
- 没有远程代码（Manifest V3 禁止，本扩展也不申请相关能力）
- 不读取你的密码、cookie、私信，不读未打开页面的内容
- 只处理你眼前这条时间线上已经渲染出来的推文文本

## 本地存了什么

全部存在 `chrome.storage.local`（你这台机器的浏览器配置目录里），不往外发：

| 键 | 内容 | 什么时候写入 |
|---|---|---|
| `settings` | 模式、灵敏度、角标位置、各开关 | 你在设置面板改动时 |
| `stats` | 本次装好后各档位计数（如「存疑 12 条」） | 扫描时 |
| `samples` | 你点过的「这是 AI / 这是真人 / 说不清」反馈样本 | 你点按钮时 |
| `diag` | 最近一次诊断快照：**页面 URL**、引擎版本、设置、每条推文的分数与正文前 400 字 | 开着诊断模式扫描时 |
| `usage` | 深检当天用了几次（用于每日上限） | 每次深检 |
| `llm` | 你填的接口地址、模型名、**API key 明文** | 你保存设置时 |

导出功能（「导出反馈样本」「导出诊断数据」）只是把上面这些写成文件下载到你本地，
**不会自动上传到任何地方**。注意「诊断数据」里含**页面 URL**和推文原文，
发给别人之前请自己过一眼。

## 深检：只在你点击时才发

点推文面板上的「深检」或「AI 预判」时，插件会把**这条推文的文本**发给
**你自己在设置里填的** OpenAI 兼容接口（默认 `https://api.deepseek.com`）：

| 发出去的东西 | 说明 |
|---|---|
| 这条推文的文本 | 就是你要判的那一条，超过 4000 字截断；不含作者名、handle、时间 |
| 你标过的样本原文（**默认不发**） | 只有你在设置里勾了「带上我标过的样本」才会发：最多 4 条 AI + 4 条真人，每条截断到 160 字。只取你亲手点的标签，采纳 AI 判断的那类不取 |
| 固定的系统提示词 | 写在 `llm.js` 里，公开可查 |
| 你的 API key | 放在 `Authorization: Bearer` 头里 |
| 请求参数 | `model` / `temperature: 0` / `max_tokens`（深检 260，AI 预判 420），DeepSeek 域名下额外带 `thinking: disabled` |

不发：你的浏览历史、其他推文（**除了你自己选择带上的标注样本**）、账号信息、设备信息。

请求由后台 service worker 代发（`background.js`），所以 **key 不会进入页面上下文**，
x.com 的页面脚本读不到它。

**对方服务商怎么处理这条文本，取决于它的隐私政策**——那是你和它之间的事，
插件不参与、也无法控制。用第三方 API 前请先读一遍那家的条款。

## 权限

| 权限 | 用途 |
|---|---|
| `storage` | 存上面那张表里的设置与计数 |
| `contextMenus` | 右键菜单入口 |
| `host_permissions: x.com / twitter.com` | 在时间线上注入角标，仅此 |
| `optional_host_permissions` | **不预授权**。你填了哪个接口地址，才在那一刻向你要那一个域名的访问权 |

不会申请 `<all_urls>`，也不会在后台悄悄扩大权限。

## 怎么删

- **只想清数据**：`chrome://extensions` → 移除 SlopLens，`chrome.storage.local` 连同 key 一起被清掉
- **想留下但换 key**：设置面板里直接改，旧值被覆盖
- **别指望「退出登录」**：这里没有账号体系，数据只有“在本地”和“被删掉”两种状态

## 必须说清楚的三个取舍

1. **API key 是明文存的。** `chrome.storage.local` 不做加密，任何能读你磁盘的人都能拿到。
   用一把**专用、限额**的 key，别用主账号的。
2. **没有自动清理。** 反馈样本会一直攒着，直到你卸载扩展。
3. **深检会把推文文本交给第三方。** 涉及隐私、未公开信息、他人私事的内容，别点深检。
   勾上「带上我标过的样本」之后，一次点击会把**另外最多 8 条**推文原文一起发出去。
   你标过的样本里如果混着不该外发的东西，先清掉，或者别开这个开关。

---

## English summary

SlopLens runs entirely in your browser and makes **no network requests by default**.
There are no servers, no accounts, no analytics, and no telemetry.

Everything (settings, counters, your feedback samples) lives in `chrome.storage.local`
on your machine. The optional "deep check" is the **only** outbound action: when you
click it, the text of that single post is sent to the OpenAI-compatible endpoint *you*
configured (DeepSeek by default), authenticated with *your* key. Requests are issued by
the background service worker, so the key never enters the page context.

Your API key is stored in plaintext locally — use a dedicated, rate-limited key.
To delete all data, remove the extension from `chrome://extensions`.
