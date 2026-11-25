# tenhou_se

天凤（Tenhou）自定义角色语音（SE）静态托管仓库，部署于 Cloudflare Pages（`https://se.nivalis.is`）。

## 目录结构

```text
tenhou_se/
├── _headers                  # Cloudflare Pages CORS 跨域响应头配置
├── _redirects                # 将 /<角色>.json 静态重写到 /json/<角色>.json
├── tenhou_random_se.user.js  # 天凤通用多语音随机油猴脚本（支持局内零延迟随机）
├── json/                     # 各角色 SE 配置文件目录
│   └── kazusa.json           # 冬马和纱配置（对外访问：https://se.nivalis.is/kazusa.json）
└── kazusa/                   # 冬马和纱全部 .mp3 语音文件
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

## 新增角色规范

1. 新建 `<角色id>/` 目录放入 `.mp3` 语音文件；
2. 在 `json/<角色id>.json` 中按 `kazusa.json` 格式编写配置（同时填写 `"url"` 与 `"urls"`，链接前缀为 `https://se.nivalis.is/<角色id>/`）；
3. 在 `_redirects` 中追加一行 `/<角色id>.json /json/<角色id>.json 200` 即可通过 `https://se.nivalis.is/<角色id>.json` 访问。
