# Agent Note: Browser sign-in for subscription OAuth flows

Status: implemented

[English](2026-09-13-browser-sign-in-for-subscription-oauth-flows.md) | 中文

## Problem

Models 页只认识一种凭据形态：在输入框里键入 API 密钥。每个换一种方式认证的提供方路由——Claude Pro/Max 订阅走 Anthropic OAuth、ChatGPT 订阅走 Codex OAuth——其流程都由 `dsh-llm-pi-ai` 注册在 `ctx.authorization` 上，却没有界面可以运行它。用户指南直说：OAuth 登录的提供方在该页尚不受支持。订阅者唯一的路是另购 API 额度，粘贴一个订阅从未签发的密钥。

## Decision

Web profile 现在在 API 密钥编辑器旁提供订阅登录。三件一起发布：

- `dsh-authorization-remote`（`packages/credentials/authorization-remote`）拥有 `authorization` Remote namespace。登录是一段对话，而一次 Remote 调用是一个请求产生一个结果，因此该 namespace 用 attempt 桥接两者：`begin` 打开 attempt 并在后台运行流程，`frames` 按 cursor 轮询对话，`answer`/`decline` 结算一个待答提示。提示答案只从浏览器流向 Host；通知、提示与终态只从 Host 流向浏览器；已存值不经过任何方法。`status` 回答是否存有授权，`signOut` 忘记它。
- `dsh-client-ui-settings-authorization`（`packages/client/ui-settings-authorization`）经 Models 页为这种扩展声明的 `settings.models.provider-card` 席位，在每张 `llm-pi-ai` 卡片内渲染伴随界面。API 密钥方式被过滤掉，因为页面已经拥有它。对话框轮询自己打开的 attempt，渲染每条通知及其登录链接与验证码，回答最新未答提示，在终态收尾；关闭即撤回 attempt。
- `web-app` bundle 挂载 `authorization` seam（它本身不提供流程）、remote owner 与伴随界面。`authorization/settled` 事件转发给浏览器，让第二个标签页知道 attempt 结束了。

`authorization/settled` 事件声明从 seam 主入口移到浏览器安全的 `./types` 子路径，沿用 `credentials/record-updated` 的先例：Client face 只能消费不带 Host Cordis 合并的声明。

## Alternatives considered

- **直接改 Models 页拥有登录。** 否决：provider-card 席位的存在就是让适配器家族不改页而扩展它，slot 纪律会对未声明的渲染让构建失败。伴随插件正是该席位的用途。
- **用流代替轮询。** 否决：对话仍需浏览器到 Host 的作答，流旁边还得再加一个作答 RPC。持续数秒的登录每秒一轮询是更小的机制；Host 包 README 记录了这一点。
- **把 seam 的 `begin` 直接暴露为一次 Remote 调用。** 否决：`begin` 接受带回调的 interaction 对象，它没有 wire 形态。带 cursor 轮询的 attempt 注册表就是 wire 形态。
- **多界面共享一个 attempt。** 否决：seam 按键拒绝第二个 `begin`，因为两个界面会让两个人回答同一流程的问题。伴随界面从不共享 attempt id，第二页在前者结算前读到 `in-flight`。

## Consequences

订阅者在配置模型的地方登录，只用 API 密钥的部署看不到变化：只提供密钥的流程在这里不渲染任何内容。代价是第二条有自己生命周期的凭据路径——attempt 是进程内的，登录中途重载页面即放弃；登出只在本地忘记而不通知发行方——两点都记在包 README 而不在此修复。

## Testing

- `authorization-remote.host.spec.ts` 用脚本化流程驱动 namespace：列表、已存态读取、登出、通知加验证码到 `authorized`、select 提示、拒绝与撤回到 `cancelled`、流程失败到带诊断的 `failed`、attempt 中途的提示撤回、迟到作答、畸形 id 与 cursor、五十个后保留逐出。
- 伴随界面 specs 在桩 Remote face 上驱动卡片：无流程与纯密钥路由不渲染、拒绝的读取可重试、验证码走到已登录卡片、secret 与 select 提示、失败与取消终态、拒绝的轮询与作答、撤回、登出。
- `pnpm run test:gui` 覆盖 client suites；Host suite 走 root test lane。
