# DOT PDA Cannington Monitor

每 10 分钟自动检查西澳 DOT（Department of Transport）Cannington 考场 PDA 路考空位，通过 Telegram 推送到你的 iPhone。

## 工作原理

```
login.js (Mac)         GitHub Actions (云)         iPhone
───────                ─────────────────           ──────
你手动登录             每 10 分钟自动运行            Telegram
↓                      ↓                            ↑
保存 cookies ──→ DOT_COOKIES Secret               通知
                 ↓
                 无头浏览器检查 Cannington 空位
                 ↓
                 有空位 → Telegram API ──────────→ 📱
                 Session 过期 → 通知你重新登录
```

## 前置准备

### 1. 创建 Telegram Bot

1. 在 iPhone 上打开 Telegram，搜索 `@BotFather`
2. 发送 `/newbot`，按提示创建 bot（名字随意，如 `DOT PDA Monitor`）
3. 记下 BotFather 返回的 **Bot Token**（格式：`123456:ABC-DEF1234ghikl...`）
4. 搜索 `@userinfobot`，发送 `/start`，记下你的 **Chat ID**
5. 在新创建的 bot 聊天中发送 `/start`（激活 bot）

### 2. 创建 GitHub 仓库

1. 登录 [GitHub](https://github.com)，创建一个**公开**仓库（Public repository = 无限 Actions 分钟）
2. 将本目录 push 到仓库

### 3. 设置 GitHub Secrets

在 GitHub 仓库页面：**Settings → Secrets and variables → Actions → New repository secret**

添加三个 Secrets：

| Secret 名称 | 内容 |
|-------------|------|
| `TELEGRAM_BOT_TOKEN` | 从 @BotFather 获取的 token |
| `TELEGRAM_CHAT_ID` | 从 @userinfobot 获取的 Chat ID |
| `DOT_COOKIES` | 先留空，运行 login.js 后填入 |

---

## 本地设置

### 1. 安装依赖

```bash
cd dot-pda-monitor
npm install
npx playwright install chromium
```

### 2. 登录并保存 Cookies

```bash
node login.js
```

- 会自动打开 Chrome 浏览器
- 在浏览器中输入 DoTDirect 用户名、密码、短信验证码
- 完成 reCAPTCHA（如果有）
- 脚本自动检测登录成功并保存 cookies
- 终端会打印 **base64 编码的 cookies 字符串**

### 3. 上传 Cookies 到 GitHub

```bash
# 方式 1：复制 login.js 输出的 base64 字符串，在 GitHub Web UI 粘贴

# 方式 2：用 GitHub CLI（需要先 brew install gh）
gh secret set DOT_COOKIES --body "$(cat cookies.json | base64)"
```

---

## 运行监控

### 云端自动运行

将代码 push 到 GitHub 后，GitHub Actions 会每 10 分钟自动运行一次。

你可以在 GitHub 仓库的 **Actions** 标签页查看运行日志。

### 本地测试运行

```bash
DOT_COOKIES=$(cat cookies.json | base64) \
TELEGRAM_BOT_TOKEN=your_bot_token \
TELEGRAM_CHAT_ID=your_chat_id \
node monitor.js
```

---

## Session 过期处理

DOT 的登录 Session 可能持续几小时到几天。过期时你会收到 Telegram 通知：

> ⚠️ DOT Session 已过期，请在 Mac 上重新运行 login.js

**处理步骤：**
1. 在 Mac 上运行 `node login.js`
2. 完成登录
3. 更新 GitHub Secret：
   ```bash
   gh secret set DOT_COOKIES --body "$(cat cookies.json | base64)"
   ```
4. 监控会自动恢复

---

## 通知示例

有空位时，Telegram 会收到：

```
🎉 Cannington PDA 可能有空位！

发现以下内容：
  • Dates found: Monday 20 June 2026
  • Times found: 10:15 AM, 11:30 AM
  • Table row: 10:15 AM Available

🔗 立即查看预约
📅 检测时间: 2026-06-20 14:20:00 (Perth时间)
```

---

## 迭代优化

由于无法提前知道登录后的 DOT 页面结构，`monitor.js` 在 V1 版本中使用启发式方法检测空位。

你可以通过以下方式帮助改进检测准确率：

```bash
# Scout 模式：记录预约页面的 DOM 结构和截图
node login.js --scout
```

登录后，手动导航到 Cannington 考场的预约页面，按回车键。脚本会保存：
- `screenshots/booking-page.png` — 页面截图
- `screenshots/booking-page.html` — 页面 HTML
- `screenshots/page-info.json` — 页面 URL 和标题

将这些文件分享给开发者以优化 `monitor.js` 中的选择器。

---

## 文件结构

```
dot-pda-monitor/
├── .github/workflows/
│   └── monitor.yml      # GitHub Actions 定时任务（每 10 分钟）
├── login.js             # 交互式登录脚本（Mac 本地运行）
├── monitor.js           # 无头监控脚本（GitHub Actions 运行）
├── package.json
├── .gitignore
└── README.md
```

## 常见问题

**Q: 为什么不用云服务器？**
A: GitHub Actions 公开仓库完全免费，不需要信用卡。

**Q: 会不会被 DOT 封禁？**
A: 每 10 分钟访问一次（144 次/天），频率很低，等同于正常用户刷新页面。

**Q: 能不能自动帮我抢到位置？**
A: 目前只做监测和通知。自动抢位涉及支付等复杂步骤，风险较高。
