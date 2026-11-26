# tenhou_se

天凤（Tenhou）自定义角色语音（SE）静态托管仓库，部署于 Cloudflare Workers + Static Assets（`https://se.nivalis.is`）。

## 目录结构

```text
tenhou_se/
├── .github/workflows/deploy.yml  # GitHub Actions 自动部署到 Cloudflare Workers
├── src/index.ts                  # Worker 入口：将 /<角色>.json 重写到 /json/<角色>.json 并添加 CORS 头
├── wrangler.jsonc                # Workers 与静态资源配置（绑定 se.nivalis.is）
├── tenhou_random_se.user.js      # 天凤通用多语音随机油猴脚本（支持局内零延迟随机）
└── public/
    ├── _headers                  # 静态资源 CORS 响应头配置
    ├── json/                     # 各角色 SE 配置文件目录
    │   └── kazusa.json           # 冬马和纱配置（对外访问：https://se.nivalis.is/kazusa.json）
    ├── character/                # 各角色语音资源目录
    │   └── kazusa/               # 冬马和纱全部 .mp3 语音文件
    └── nintei/                   # 天凤「認定」升段窗口生成器（https://se.nivalis.is/nintei/）
        └── index.html            # 单页工具：多语言认定状预览 + PNG 导出
```

## 已有角色

| 角色 | SE 配置链接 | 语音数量 |
| --- | --- | --- |
| 冬馬かずさ（冬马和纱） | `https://se.nivalis.is/kazusa.json` | 29 条（吃/碰/杠/立直/荣/自摸/拔北/开局/役满） |

## 使用方法

1. 打开天凤网页版（[tenhou.net/3](https://tenhou.net/3/) 或 [tenhou.net/4](https://tenhou.net/4/)）。
2. 进入右上角 **设置（Setting）→ SE 设定**，取消勾选 **「標準のSE」**。
3. 在 URL 输入框填入：`https://se.nivalis.is/kazusa.json`。
4. **（可选）局内多语音随机播放**：安装本仓库的 [tenhou_random_se.user.js](./tenhou_random_se.user.js) 油猴脚本后，页面加载时会自动将 `urls` 数组中的所有候选语音预加载到内存，对局内每次触发动作时零延迟随机切换不同语音。

## 认定状（升段窗口）生成器

访问 <https://se.nivalis.is/nintei/>；本地可用 `npm run dev`（或 `npx wrangler dev`）后访问 `/nintei/`。

天凤在登录收到 `nintei` 消息时会弹出 `NINTEI`「認定」窗口。本工具按 `/3/` 与 `/4/` 客户端的原始实现还原该窗口：

- 输入昵称、段位（新人～天鳳位）、日期，选择四麻 / 三麻
- 支持天凤官方 10 种语言的认定状正文与日期格式（ja / en / zh / ko / ru / fr / it / es / vi / pt / de），自动跟随浏览器语言
- 可切换 `/4/`（默认）与 `/3/` 两种客户端样式，3.0 秒淡入动画与原版一致
- 「認定」标题与段位名和官方客户端一致，固定使用日文表记
- 一键导出 2880 × 2160 PNG

## 新增角色规范

1. 在 `public/character/<角色id>/` 下放入 `.mp3` 语音文件；
2. 在 `public/json/<角色id>.json` 中按 `kazusa.json` 格式编写配置（同时填写 `"url"` 与 `"urls"`，链接前缀为 `https://se.nivalis.is/character/<角色id>/`）；
3. 推送到 `main` 分支后 CI 会自动部署，即可通过 `https://se.nivalis.is/<角色id>.json` 访问。
