# 鲸鱼娘（代码名 whale-girl）

蓝发鲸鱼娘「小鲸」——零 npm 依赖的 Node.js 自研聊天体。开发计划见 `docs/鲸鱼娘自研计划.md`，当前进度：**P0（网页私聊）**。

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
| `WG_<PROVIDER>_BASE_URL` / `_CHAT_MODEL` | 覆盖地址与模型名 |
| `WG_HOT_RELOAD` | 1 开 / 0 关，热加载 `.env` + config.json + 人设 |

### 热加载开关

config.json 里的 `"hotReload": true`（或 `WG_HOT_RELOAD=1`）控制是否每次请求重新读 .env / config.json / 人设：

- **开（默认）**：改完保存，下一句就生效，不用重启
- **关**：启动时读一次并缓存，改配置需要重启

开关本身只在启动时读一次——想从"关"切回"开"，得改完重启。

## 目录

    server.js          HTTP / SSE / 静态页入口
    src/config.js      配置读取与归一化
    src/llm.js         OpenAI 兼容流式客户端
    src/persona.js     人设 prompt 组装
    personas/*.json    人设数据（改完即生效）
    public/index.html  聊天页
    tests/             node --test 单测
    docs/              计划与学习笔记

## 测试

    node --test

Node 22 不接受目录参数，用自动发现；测试文件都在 tests/ 下，命名 *.test.js。

## 安全

- 默认只监听 `127.0.0.1`，公网访问前必须先加登录鉴权
- `config.json`、`data/`、日志永不入库
- 客户端不能传 system 角色，人设无法被前端覆盖
- 人设内置安全底线；底线被触碰时简短拒绝，不说教
