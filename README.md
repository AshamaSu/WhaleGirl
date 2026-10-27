# 鲸鱼娘（代码名 whale-girl）

蓝发鲸鱼娘「小鲸」——零 npm 依赖的 Node.js 自研聊天体。开发计划见 `docs/鲸鱼娘自研计划.md`，当前进度：**P1（记忆 + 工具调用 + 图片）**。

## 现在能做什么

- 网页私聊，流式输出、按换行拆气泡、可中断
- 会自己决定联网搜索（Tavily）、读网页正文，回答带链接
- 会记住关于你的事：短期原文 → 事实抽取 → 摘要压缩，久了会淡忘
- 能看图（走 config 里 `vision.provider` 的 visionModel）
- `/persona` 调参页：改人设、导出/清空记忆

## 启动

    node server.js
    # 小鲸已启动 → http://127.0.0.1:8787

不需要 npm install，没有任何第三方依赖，只用 Node 18+ 的内置模块。

## 配置

密钥走环境变量，非密钥项走 config.json：

1. `cp .env.example .env`，填 `WG_DEEPSEEK_API_KEY=sk-...`（`.env` 权限 600，不进 git）
2. `cp config.example.json config.json`，里面不要再写 key（留空即可）
3. `.env` 的 `WG_ACTIVE` 或 config.json 的 `active` 决定用哪个 provider

优先级：进程环境变量 `WG_*` > `.env` > `config.json` > `config.example.json`。

| 环境变量 | 作用 |
|---|---|
| `WG_ACTIVE` | 当前 provider |
| `WG_HOST` / `WG_PORT` | 监听地址与端口 |
| `WG_PERSONA` | 人设文件路径 |
| `WG_<PROVIDER>_API_KEY` | provider 的 key，如 `WG_DEEPSEEK_API_KEY` |
| `WG_<PROVIDER>_BASE_URL` / `_CHAT_MODEL` / `_VISION_MODEL` | 覆盖地址与模型名 |
| `WG_HOT_RELOAD` | 1 开 / 0 关，热加载 `.env` + config.json + 人设 |
| `WG_TAVILY_API_KEY` | 搜索 key，不填则 `web_search` 只会如实说搜不了 |
| `WG_VISION_PROVIDER` | 图片走哪个 provider（默认取第一个配了 visionModel 的） |
| `WG_MAX_ROUNDS` | 工具循环上限，默认 4 |

### 热加载开关

config.json 里的 `"hotReload": true`（或 `WG_HOT_RELOAD=1`）控制是否每次请求重新读 .env / config.json / 人设：

- **开（默认）**：改完保存，下一句就生效，不用重启
- **关**：启动时读一次并缓存，改配置需要重启

开关本身只在启动时读一次——想从"关"切回"开"，得改完重启。

## 目录

    server.js          HTTP / SSE / 会话 / 图片通道 / 静态页
    src/config.js      配置读取与归一化
    src/llm.js         OpenAI 兼容流式客户端（文本 + tool_calls 事件）
    src/agent.js       工具调用循环
    src/persona.js     人设 prompt 组装
    src/memory.js      三层记忆、淡忘、摘要
    src/tools/         web_search / fetch_url / remember
    personas/*.json    人设数据（改完即生效）
    data/memory/       会话记忆（不进 git）
    public/index.html  聊天页
    public/persona.html 调参页
    tests/             node --test 单测
    docs/              计划与学习笔记

## 测试

    node --test

Node 22 不接受目录参数，用自动发现；测试文件都在 tests/ 下，命名 *.test.js。

## 接口

| 方法与路径 | 作用 |
|---|---|
| `POST /api/chat` | `{sessionId, message, image?}`，SSE 返回 meta/tool/delta/done |
| `GET /api/health` | 当前 provider、模型、人设名、工具清单 |
| `GET /api/persona` / `PUT /api/persona` | 读/写人设 JSON（写前校验，热加载开着即时生效） |
| `GET /api/memory?sessionId=` | 导出记忆（原文/事实/摘要） |
| `DELETE /api/memory?sessionId=` | 清空记忆 |

## 安全

- 默认只监听 `127.0.0.1`，公网访问前必须先加登录鉴权
- `config.json`、`data/`、日志永不入库
- 客户端只能发 `{sessionId, message, image}`，无法注入 system 角色
- `fetch_url` 拦截内网地址（localhost / 10. / 172.16-31. / 192.168. / 169.254.），防 SSRF
- 记忆文件权限 600，和 `.env` 同级对待
- 人设内置安全底线；底线被触碰时简短拒绝，不说教
