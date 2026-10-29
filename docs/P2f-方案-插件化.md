# P2f 方案：插件化架构（独立仓库 + 配置激活）

> 角色约束：本方案由 WorkBuddy 产出，代码实现与调试全部由 CodeBuddy 完成。

## 0. 目标与边界

把「能力」从「核心」里拆出去：

- **核心仓库**（`whale-girl`）：HTTP 服务、聊天主链路（agent / memory / persona / llm）、feature 宿主、插件装载器、设置页框架。**不包含**任何具体能力实现。
- **插件仓库**（独立 git 项目，如 `whale-girl-plugin-bili`）：B站子代理；后续 `plugin-qq-napcat`、`plugin-qq-official` 等同样如此。
- **激活方式**：安装（clone 到 `plugins/`）+ 配置（`config.json` 里 enabled）双重控制；未安装 = 不存在，未启用 = 不加载。
- **规范约束**：后续一切新可插拔功能按本规范开发；核心仓库不再新增能力模块。

### 保留在核心里的三个"内置能力"的处理

`mood`、`memory-timeline` 属于人格/记忆本体，与主链路耦合最紧，**留在核心**（迁移收益低、拆分风险高）。`bili` 是第一个迁出对象，也是插件规范的样板。

---

## 1. 现状盘点（CodeBuddy 动手前必读）

### 已经具备的（宿主雏形，直接复用）

`src/features.js` 已实现插件宿主的全部核心语义：

- 按名注册、`config.features.*` 启停、`sync()` 只处理差异；
- 三条硬约束：未声明=关闭；单能力异常不外传；路由/prompt 片段/afterReply 钩子按能力记名、卸载时一起清；
- `scoped(name)` 门面：每个能力拿到自己的 route/addPromptBlock/addAfterReply。

`server.js` 的 `featureContext` 已暴露：`root / dataRoot / publicDir / logger / bus / sendJson / sendText / serveStatic / readJson / getConfig / getEnv / makeLlm`（其中 `serveStatic` 将在 P2f-2 只从**插件** ctx 裁剪、内置能力仍可用，见 §2.6.3，此处是现状盘点）。

### 必须解决的硬伤

`src/features/bili/index.js` 深度 require 宿主内部：

```js
require('../../bilibili/client')   // B站接口层
require('../../persona')           // loadPersona / buildMessages
require('../../config')            // resolveProvider
require('../../agent')             // runner 里的子代理循环
```

相对路径互相够 = 物理上搬不进独立仓库。**插件化的第一步是 SDK 抽取，不是拆仓库。**

---

## 2. 插件契约（规范核心）

### 2.1 目录与 manifest

```
whale-girl-plugin-bili/
├─ plugin.json          # 清单：契约的声明面
├─ index.js             # 入口，导出 create() -> module（不收 ctx，见 §2.2）
├─ src/                 # 插件私有实现（client/api/tools/store/schedule/runner）
├─ prompts/             # 章程等 prompt 资源
└─ tests/               # 用宿主 test-harness 写的测试
```

`plugin.json`：

```json
{
  "name": "bili",
  "version": "1.0.0",
  "apiVersion": 1,
  "testedAgainst": "core v0.1.x",
  "minCoreVersion": "0.2.0",
  "title": "B站子代理",
  "description": "派子代理刷B站，挑值得的视频汇报",
  "requires": ["pushText", "makeLlm", "makeAgent", "persona", "getEnv", "getConfig", "storage", "dataRoot"],
  "configSchema": [ "…见 §2.4（数组，元素含 key/type/default/title）" ]
}
```

> `dataRoot` 是 **P2f-1~P2f-2 的过渡项**（bili 的 store 基址），P2f-3 数据迁移完成后从 requires 删除；新插件不要抄它，一律用 `ctx.storage`。

### 2.2 入口签名（与现有 module 形状一致，宿主零改动）

```js
// index.js
'use strict';
module.exports = { create: createBiliModule };
// create() 不收 ctx，返回 { name, enabled(config), init(ctx, {config}) -> {stop()} }
```

关键规则：

- **`create()` 不接收 ctx**：宿主实际调用的是 `module.init(scoped(name), { config })`（src/features.js:80），只有 init 收到的门面带 `route / addPromptBlock / addAfterReply`；在 `create` 里注册路由不会进宿主路由表，`matchRoute` 永不命中（表现为接口 404）。`create` 只做纯声明，**禁止副作用**（不开定时器、不连 WS、不读文件）。
- **插件只允许 require 自己目录内的文件 + 使用 `ctx.*` 服务**，禁止 `require('../../src/...')`、禁止摸 `process.env`（env 统一走 `ctx.getEnv()`）。规范写成 lint 式检查脚本，插件 CI 里跑。
- **不得依赖 `ctx.root` / `ctx.dataRoot`**：插件资源（章程、prompt、夹具）一律 `path.join(__dirname, …)`，数据一律 `ctx.storage.dir()`。`ctx.root` 拆仓后指向核心仓库，相对路径会静默指到错误位置——bili 现在正是 `root: ctx.root` + `prompts/bili-duty.md`（index.js:146 / duty.js:6）。**唯一过渡期例外**：bili 的数据路径在 P2f-1 仍走 `<dataRoot>/data/bili`（P2f-3 迁移时一次切到 `ctx.storage.dir('bili')`），因为提前切等于清空额度与判重。**这个例外必须包含访问通道，不只是路径**：bili 的 `requires` 里要显式写 `dataRoot`，否则 P2f-2 的 `scoped` 裁剪一上线，store 直接拿不到基址（额度回零、seen 清空）。P2f-3 随 mv 一并删掉该声明；`grep ctx.dataRoot` 零结果只作为 **P2f-3** 的验收。新插件从第一天起就必须用 `ctx.storage`。
- `requires` 清单是声明也是文档：宿主启动时校验服务齐全，缺了就拒绝加载并写明缺什么。**而且必须真的裁剪**——`scoped(name, requires)` 只注入声明过的服务（白名单浅拷贝或 Proxy 抛错），未声明的 key 访问即失败；否则 `Object.create(context)`（features.js:49-50）会把全部服务都给插件，`requires` 写错也能跑，声明校验形同虚设。

### 2.3 SDK 抽取（P2f-1 的全部内容）

`featureContext` 需要新增/明确的服务（全部从现有代码"提升"为服务，不是重写）：

| 服务 | 现状 | 提升后 |
|---|---|---|
| `ctx.getConfig()` | 已有（server.js:276） | 不变。**约定：插件禁止自行解析 provider**——不得复刻 `config.providers[config.active]` 的取法（现在 bili/index.js:144 的 `resolveProvider(live)` 拆仓后无源可 require），模型配置一律经 makeLlm/makeAgent 间接获得 |
| `ctx.makeLlm()` | 已有 | 语义收紧：返回**已绑定当前 provider** 的调用函数，插件拿到即可用，无需感知 provider 结构 |
| `ctx.makeAgent()` | runner 内部 require `../../agent`，provider 由 bili 自行 `resolveProvider(live)` 传入；runner 实际还传 `maxRounds`（来自 `section.maxRounds`）、`temperature`、`timeoutMs` | 改为 `makeAgent({ tools, duty })` -> `run(messages, { maxRounds, temperature, timeoutMs })`——参数随调用传入而非硬编码进宿主，否则 bili 的这些配置项名存实亡。**provider 解析收进宿主内部**（复用 makeLlm），插件从此不接触 provider 配置。**ctx 服务在测试中可替换是契约的一部分**：现有 bili 有 **7 个**注入口 `now / store / client / api / tools / provider / runAgent`（index.js:73/75/81/89/90/144/154），其中 `store/client/api/tools` 才是测试真正打桩的对象（tests/bili-feature.test.js 全靠它们）——`createStubCtx` 只造 ctx，替不掉这四个，harness 必须同时导出 `createStubModuleOpts()`（见 §4） |
| `ctx.persona.compose(systemExtra, opts)` | index.js require `../../persona`，另在 index.js:126 直读 `persona.reply.maxBubbles`；**播报刻意用空记忆 `buildMessages(persona, [])`** | 返回 **`{ messages, reply }`**：messages 为组装好的骨架，reply 为 `persona.reply` 元信息对象（播报气泡数读 `reply.maxBubbles`）。**第二参是三个开关 `opts = { history, memory, features }`（缺省全 true）**：`buildMessages` 的记忆有三条入口——`history`（近期 turns）、`opts.memoryText`（事实层）、`opts.extraText`（插件 prompt 块，persona.js:247-260），只关 `memory` 挡不住后两条。bili 播报必须传 `{ history: false, memory: false, features: false }`，否则播报请求会掺进会话记忆/事实/prompt 块，内容与 token 都变，直接违反 P2f-1"输出侧零变化"验收 |
| `ctx.pushText(text, meta)` | 无（bili 直接 `ctx.bus.emit('push', …)`，index.js:129；server.js:522 只推网页 SSE 即丢） | **只负责「她主动播报」**，`bus` 不再对插件开放（从 ctx 与 requires 移除，loader 断言拒绝 `emit('push')`）。签名 `pushText(text, { kind, roundId?, to? })`：`kind:'broadcast'`（她主动说的）→ 广播（`to` 缺省 `null` → 发网页；指定渠道则调 `registerChannel` 的 send）+ 落 `main` 记忆 + selfPost（记忆与 mood 在 P2f-1b，P2f-1 只做广播）；`kind:'reply'`（渠道里回某人）→ 只走 send，**不落记忆、不上网页、不触发 mood**。`to` 只决定投递去向。`roundId` 缺省由宿主生成并在返回值给出，调方复用同一值把一轮多气泡串起来（mood 去重键，不进消息形状） |
| `ctx.getEnv()` | 已有 | 不变（B站 cookie 等账号数据的唯一合法通道） |
| `ctx.storage` | 无（bili 经 `root: ctx.dataRoot` 让 store 拼出 `data/bili`） | `ctx.storage.dir(name)` 保证目录存在并返回路径，插件数据一律放 `<dataRoot>/data/plugins/<name>/`（基址是 `ctx.dataRoot`，与现有 `data/bili` 同源；迁移见 P2f-3） |
| `ctx.addTool(def)` | 无——主聊天工具在 server.js:383 由 `createTools` 硬编码（web_search/fetch_url/remember） | 插件为主聊天 agent 注册 function-calling 工具：宿主把**已启用插件**的工具合入 agent 工具面，命名空间强制 `plugin_<name>_*` 防撞名；`/api/health` 的 tools 列表同步合并。这是"问Q群"类能力的依赖（QQ 插件同时注册渠道与 `plugin_qq_group_history` 工具），P2f-1 一次定义到位，避免二次改 SDK；本项只保证宿主侧行为，标 **experimental**（P2f-1 没有真实消费者，别对空实现自证过深） |
| `ctx.dispatchInbound(msg)` | 无 | 渠道插件 → 宿主的**入站入口**（方向与 pushText 相反，是插件调宿主，不是宿主回调插件）。入参按 §2.6.1 的入站形状 `{ source, chat:{platform,id,type,title}, sender:{id,name}, text, msgId, flags:{atMe,replyToBot} }`；宿主据此解析会话 key（`platform:g|u:chatId`）、写入该会话记忆、跑 `runTurn`，回复经 `registerChannel` 注册的 `send` 回原会话（不经过 pushText）。P2f-1 只定契约与注册校验，不接真实渠道；P2e 的 QQ 插件第一个使用 |
| `ctx.registerChannel(name, send)` | 无 | 渠道插件在 init 里注册发送函数 `send({ chatId, text, atUserId })`，宿主据此投递 `pushText({ to })` 与 `dispatchInbound` 的回复。**约定 `name` 必须等于消息里的 `source`**（注册 `qq` 才能收 `to.channel:'qq'`）；注册表与 route/prompt 一样按能力记名，`drop()` 时一并清掉，插件停用后 `pushText` 只 warn 丢弃、不抛、不影响主链路。P2f-1 定签名，P2e 第一个用 |

改造后的 bili：`bilibili/` 四个文件（client/api/tools/wbi）整体搬进插件仓库 `src/`；runner/store/schedule 同理；对宿主的依赖只剩上表服务（§2.3 表随契约演进而增行，正文不再写死数字）。

### 2.4 可视化配置（configSchema 驱动）

`configSchema` 用一个**极小子集**（Key-Value 表单够用，不引 JSON Schema 全集）：

```json
{
  "configSchema": [
    { "key": "enabled",            "type": "boolean", "default": false, "title": "启用" },
    { "key": "intervalMinutes",    "type": "number",  "default": 180,   "title": "轮询间隔(分钟)", "min": 30 },
    { "key": "dailyQuota",         "type": "number",  "default": 4,     "title": "每日自动轮数上限", "min": 0 },
    { "key": "activeWindows",      "type": "string-list", "default": ["12:00-14:00","18:00-09:00"], "title": "活跃时段" },
    { "key": "keywords",           "type": "string-list", "title": "兴趣关键词" }
  ]
}
```

- **现状澄清**：目前**并没有设置页**——`public/` 只有 index/memory/persona 三页，也没有统一的功能管理路由——`/api/features/*` 只有 bili 自带的两条（`GET /api/features/bili/state`、`POST /api/features/bili/run`，src/features/bili/index.js:184,197），feature 状态另随 `/api/health` 的 features 字段出现，配置一直靠手改 config.json。所以本项是**新建设置页 + 新增接口**，不是改造。
- 宿主新增 `GET /api/features/schema`（汇总已加载插件的 configSchema）与 `GET /api/features/state`（各插件 enabled/error，实现可直接复用 `/api/health` 的 features 聚合）——两者均为 **P2f-2 交付物**；
- **新建** `public/settings.html` 按 schema 动态渲染表单，保存经写回接口落 `config.json` 的 `features.<name>`。**写回接口定义**：`POST /api/features/<name>/config`（body 为 features.<name> 下的字段增量）——只写 `features.<name>` 命名空间；合并时**必须保留 config.json 里其他一切字段**（providers、apiKey 槽位、人设路径等）与未知字段，不得整文件重写覆盖；server 每次调用都重读配置，保存即热生效，无重启与重入风险；
- mood / memory-timeline 补上 schema，设置页从此只有一套渲染逻辑。**内置能力的 schema 存放位置**：与插件约定同一形状，放在能力自己的模块里导出常量数组（如 `src/features/mood.js` 导出 `schema` 字段或在 `src/features/settings.js` 集中声明），宿主 `/api/features/schema` 统一汇总内置 + 插件两路来源——设置页不区分内外，只认形状。`features.web` 开关也在 §2.4 同一形状下呈现在设置页（opt-out 语义在开关描述里写明）。

### 2.5 播报的宿主侧语义：留存、记忆、心情（**P2f-1b 交付，不在 P2f-1 内**）

> **为什么拆出去**：这一节是行为变更（播报进记忆、mood 上涨），而 P2f-1 的验收锚点是「输出侧零变化」。混在一步里，两边都验不清。P2f-1b 开工前必须补齐三项前置，缺一项都会静默丢数据：
> 1. **记忆并发写者模型**（**已在 P2f-1 交付**，本步只复用）：`openMemory` 是「打开即读快照 + `save()` 整包覆盖」（memory.js:70-101），`dispatchInbound` 一上线就有两个写者。P2f-1 已按 sessionId 加进程内互斥（或 turns 追加写），1b 不许再绕开它直接 `appendTurn`；
> 2. **会话归属**：播报（`pushText` 不带会话）固定落 **`main`**，与网页会话同一个 id——网页是旁路渠道，不猜「当前活跃会话」（`/api/events` 是全局流，本来也没有会话信息）。前提是网页不再用随机 `sXXXXXXXX`（public/index.html:256-259），否则她写 `main`、网页读 `s8f3…`，追问必然答不上；
> 3. **下游排除**：`extractFacts` 无条件对 `recentTurns(2)` 跑（server.js:208），self turn 会被抽成事实；摘要窗口（turns > 40）也会被播报提前撑满。self turn 必须带标记并被这两条链路显式排除。

**问题**：现状 pushText 单向射出——播报完就忘，mood 不动。用户第二天问"你昨天推荐的视频"，她答不上来；分享了也开开心心毫无波澜。这丢掉了"鱼的记忆"体验的核心。

**设计决策：播报即发言，发言即记忆**（插件零改动，宿主负责一致性）：

```
插件 pushText(text, { kind:'broadcast', roundId, to? })   // bili 不传 to → 走网页分支
        │
宿主 pushText 实现（一处接线，三个动作）：
  ① 按 §2.6.1 一处构造函数补全**完整形状**（缺省字段一律 null，不能是 undefined）：
     { id, ts, role:'assistant', self:true, source, kind, text, image:null,
       chat:null, sender:null, msgId:null, flags:null, to }
     → 按 to 投递（缺省走网页 SSE 广播）
  ② memory.appendSelfTurn(msg) —— 固定落入 `main` 会话（前置 2）的短期 turns；**落盘字段保持 { role, content, at }，入参做一次适配**（见下文「字段适配」）；**衰减豁免见下文**
  ③ bus.emit('selfPost', { source, roundId, text })
     —— mood 订阅它做小幅情绪调整（按 roundId 去重）
```

**入口分流（按 `kind` 判，不按 `to` 判）**：
- `kind:'broadcast'` = 她主动说的 → **永远走 ①②③**：广播（`to: null` 发网页；指定渠道则调 `registerChannel` 的 send）+ 落 `main` 记忆 + selfPost；
- `kind:'reply'` = 渠道里回某一句 → 只调 send，**不落记忆、不上网页、不触发 mood**。

`to` 只决定投递去向，不决定是否进记忆——否则「主动分享到 QQ 群」和「回某人一句」会被混成一条路径。渠道对入站消息的回复由 `dispatchInbound` 直接走 send，不经过 `pushText`。

- **留存**：自言自语 turn 进入短期记忆的正常生命周期（随会话摘要压缩——她"记得自己说过但细节会淡"）。报告全文不进记忆，只进 `data/plugins/bili/out/` 归档；记忆里只有她说过的那几句话。**不在这一步做事实抽取**——报告是时效性内容，不配进事实层；用户若回应"那个视频不错"，由正常聊天流抽取，那才是值得记的。
- **衰减豁免（重要实现约束）**：现有 `appendTurn` 每写一条 turn 就内联把全部事实乘一次 `factDecay`（memory.js:140，默认 0.97）——bili 一轮最多 3 条气泡就是 3 次额外衰减，一天 4 轮 ≈ 12 次，事实寿命被播报无谓压掉。**`appendSelfTurn` 必须走不衰减的写入路径**（写 turn、不调 decayFacts），事实衰减只由真实对话驱动。
- **字段适配（防撞坏记忆管道）**：统一消息形状作用于**传输与展示层**；记忆落盘字段保持现状 `{ role, content, at }` 不变（`recentTurns()` → `persona.buildMessages` 依赖它）。`appendSelfTurn` 入参做一次适配（`msg.text → content`、`msg.ts → at`）。**旧 `data/memory/*.json` 零迁移**。
- **心情**：mood 新增 selfPost 处理——分享后小幅愉悦（如 +2，假设值，标定可调），且在 mood 时间线上可见"分享了 B站内容"事件；主人随后是否回应/夸赞，走既有 afterReply 链路，不重复计分。**按轮去重**：以 `pushText` 的 `roundId` 为键，一轮 3 条气泡只加一次分（不靠时间窗猜，避免 500ms 间隔的两轮被并成一次）——mood 是 0–100 且没有回落项，3 条 × 4 轮/天 = +24/天，两天就顶格，语气会被播报而不是对话决定。
- **上下文自洽**：自言自语 turn 让"刚才那个视频是讲什么的"这类追问天然可答——短期记忆里有她刚说过的话。
- **不做的**：插件不直接调 ctx.memory（记忆是宿主私域，接口面不放开）；self turn 不触发 afterReply（那是"用户说→她答"链路的钩子，自言自语不走）；self turn 固定落 `main`（与网页同一会话），不猜活跃会话；群里播报属于 P2e，届时由插件用 `to` 指定 chatId，核心不猜。

### 2.6 网页 = 被动的消息终端（不锁定宿主）

**用户约束**：网页版是被动功能，不锁定宿主；网页交互一律消息形式。含义与落点：

1. **消息模型统一（P2f-1 定形状）**：全流水线一种消息形状，字段直接对齐参考实现 `whale_gril` 的网关（src/adapters/gateway.js:30-63），免得 P2e 再扩：

   ```js
   {
     id, ts,
     role: 'user' | 'assistant',
     self: true?,                                  // 她主动说的（播报；主动搭话为后续能力）
     source,                                       // 唯一路由键：'web' | 'qq' | '<plugin>'
     kind,                                         // 'chat' | 'broadcast' | 'reply'
     text,
     image?,                                       // 入站图片；P2f-1 不消费，先占位
     chat:   { platform, id, type, title } | null, // 仅渠道消息有；播报为 null
     sender: { id, name } | null,                  // 同上
     msgId,                                        // 渠道消息 id（去重用）；播报为 null
     flags:  { atMe, replyToBot } | null,          // 同上
     to:     { channel, chatId, atUserId } | null  // 仅出站方向有
   }
   ```

   会话 key 沿用参考实现的规则 `platform:g|u:chatId`（群按群、私聊按人）。**`source` 是唯一路由键**，不要再从 `chat.platform` 二次判断（播报没有 chat，读它会 TypeError）；`chat / sender / msgId / flags` 只有渠道入站消息才有，播报一律 null；`to` 只出现在出站方向。聊天 inbound、她的回复、插件播报（§2.5）在**传输层**全部同形状；memory 落盘仍是 `{ role, content, at }`，self turn 入盘时做一次适配（§2.5「字段适配」）——不要把统一形状写进 `data/memory/*.json`，否则 `recentTurns → buildMessages` 拿不到 content；SSE 的 `delta/tool/done` 不是独立消息类型，是**一条 assistant 消息的传输过程**，UI 渲染为一条气泡。网页把收到的 push 当普通 assistant 消息画——播报和聊天回复在时间线上不可区分，这正是"消息形式"的要求。
2. **网页可关（P2f-2 交付）**：新增 `features.web` 开关，**语义为 opt-out**：`const s = sectionOf(config, 'web'); 开 = !s || s.enabled !== false`——缺 section 即开，显式 `enabled:false` 才关。**两个前提必须一起改，否则判定永远为假**：① `pickFeatures` 现在把「section 存在但没写 enabled」归一成 `false`（config.js:56-63），要先改成三态（未写 → 保留 `undefined`；写了但看不懂 → `false` + warning），否则 `"web": {}` 会被判成关；② 这是"未声明=关闭"硬约束的唯一例外，实现放 server 侧 web 装配处，不进 feature host 托管（现有 `isEnabled` 要求 `enabled === true`，照搬会把网页默认关掉）；§2.4 给它补一条 schema 与其他开关同呈设置页。**网页是旁路渠道，不引入「当前活跃会话」**：会话固定 `main`——删掉 public/index.html:256-259 的随机 `sXXXXXXXX`，多开浏览器共享同一会话；`/api/messages` **固定取 `main`、不接受 `sessionId` 参数**（不然一个便利参数就能把 QQ 会话投影到网页），播报 self turn 也落 `main`，不存在「不知道写谁」。关闭时：静态页与两个 SSE 流不注册，**核心对话流照常运行**（记忆、mood、插件、headless 供 QQ 等渠道使用）。这同时是渠道无关性的首次验收：宿主的价值在消息流，不在某个前端。
3. **收窄 featureContext**：`serveStatic` 从**插件的** ctx 拿掉（网页资产是核心内部事务，不是给插件的服务）——注意内置能力 memory-timeline 正靠 `ctx.serveStatic` 挂 `/memory`（src/features/memory-timeline.js:34），所以做法是 `scoped(name, requires)` 按声明裁剪、内置模块照旧拿全量 ctx，**不是从 featureContext 全局删除**，否则 `/memory` 直接 500；插件要 UI 一律先走设置页 schema，将来真需要插件专属页面时再定"插件 pages/ 目录 + manifest 声明 + 宿主挂 `/plugins/<name>/` 路由"（记入 §7 备注，不在 P2f 实施）。
4. **mood 事件例外**：`bus 'mood'` 是状态推送不是消息（数值/时间线），保留独立事件；web 关闭时 mood 存储与判定照常，只是没人看挂件。
5. **网页态 = 记忆的投影，无本地历史**（用户确认的行为口径）：
   - 后台一切照常运行（对话流、记忆衰减/摘要、mood 涨落、插件调度），**与有没有人开着网页完全无关**——§2.5 的 selfTurn、mood selfPost 在 headless 下照常发生；
   - **打开时**：调一次性接口（`GET /api/messages?limit=N`，P2f-2 交付，从短期记忆 turns 投影最近消息，含 self turn；**取与聊天同一常量 `HISTORY_LIMIT`（当前 MAX_HISTORY=20，server.js:25）内最多 N 条**——不要用 keepRecentTurns=12，那是压缩后保留阈值、不是聊天上下文边界；两者不一致会让「网页展示 = 她的记忆边界」当场失效（她上下文有 20 条，网页只有 12 条））；mood 挂件同理（打开拉 snapshot，实时靠 bus）；
   - **过期对话不保留**：网页**不写本地持久历史**（不用 localStorage 存聊天记录；网页会话固定 `main`，`localStorage` 不再存 `sessionId`（旧值忽略），消息也不落本地），刷新即重新拉取；已滑出短期记忆窗口、被摘要压缩的旧消息**不再展示**——网页上"能看到多少"与"她记得多少"同源同界；
   - **更早的事全靠对话获取**：用户问起旧事，她用事实层/会话摘要回答（记忆系统是唯一事实源），网页不负责回放——展示层与记忆层的一致性由此成立：**网页展示的就是她的记忆边界本身**。
6. **与 P2e 的关系**：QQ 插件 = 第二个消息消费者。它复用同一 inbound/outbound 消息形状——渠道只是消息模型的适配器，web 不再特殊。

### 2.7 版本握手与安全

- 宿主常量 `WG_PLUGIN_API = 1`；`plugin.json.apiVersion` 不匹配 → 拒载 + 日志写明"插件 x 需要 API n，宿主是 m，请升级/降级插件"。
- **apiVersion 只表示破坏性变更**（删服务、改签名、改语义）；**纯新增服务不升版**——否则为加一个 `ctx.http` 就要拒载全部旧插件，压力会变成「现在把未来可能用到的服务一次性塞进 v1」，正是 §7 要防的膨胀。新增能力的存在性由两件事兜底：插件侧 `requires` 声明（宿主按声明注入、缺了就拒载）+ manifest 可选 `minCoreVersion`（插件依赖某新服务所需的最低核心版本）。
- **安全边界**：安装插件 = 在本机运行其代码。规范写死：只安装自己写的或读过源码的插件；`plugin.js add` 时打印一句提醒。不搞签名/沙箱（单人自维护场景过度设计）。
- 插件加载失败、缺失、被拒载都只进日志和 `/api/features/state`，**绝不影响主链路**（硬约束 2 的自然延伸）。

---

## 3. 插件装载器与 scripts/plugin.js

### 3.1 装载器（核心侧改动）

`src/features.js` 的 `defaultModules()` 从硬编码改为：**内置模块（mood、memory-timeline）+ `plugins/*/plugin.json` 扫描结果**。

```
启动流程（只对启用的插件执行代码）：
扫 plugins/*/ → 读 plugin.json → 校验 name 唯一 + apiVersion + requires + minCoreVersion
  → 读 config.features[<name>]：未声明或 enabled !== true → 只登记状态，不 require
  → require(index.js) → create()（纯声明，无副作用）→ 加入 modules 列表
  → createFeatureHost().sync(config)  → init(scoped(name, requires), { config })
```

- **先判 enabled 再 require**：禁用的插件一行代码都不该执行。否则被关掉的渠道插件照样连 WS、开定时器，「未启用 = 不加载」（§0）就是空话。
- **`scoped(name, requires)` 按声明注入**（见 §2.2）：未声明的服务访问即抛错；校验发生在 `create` 之前，缺失就拒载并写明缺哪个。
- **插件路由强制命名空间**：插件只声明后缀（如 `/state`），宿主拼成 `/api/plugins/<name>/state`。否则 `matchRoute` 按 running 顺序先命中者赢（features.js:161-172），一个插件注册 `GET /api/memory` 就能静默劫持内置路由。
- **能力名清单动态化**：`defaultModules()` = 内置两个 + 已装载插件；`config.js` 的 `FEATURE_NAMES` 由「内置 + 已装载 manifest」生成——现在是硬编码 `['memory','mood','speakUp','bili','qq']`（config.js:32），任何插件名与 `features.web` 都会触发「当前没有实现的能力」误报。
- **参数变更即重装**：`sync()` 现在只在 `enabled` 变化时 start/stop（features.js:150-157），改 `intervalMinutes`/`dailyQuota` 不生效。按 section 摘要比对，变了就 stop+start（bili 的 section 在 init 时快照，index.js:71）。
- 插件代码**只在启动时加载一次**；装/卸/升级插件后重启生效（与 B站 cookie 同一约定，README 写明）。不做运行时热插拔——清缓存、依赖单例、定时器泄漏都是坑，收益配不上风险。
- 装载器异常整体隔离：任何一个插件 manifest 损坏/被拒载，跳过它，其余照常，只进日志与 `/api/features/state`。

### 3.2 scripts/plugin.js（零依赖，child_process 调系统 git）

```
node scripts/plugin.js add <git-url>|<本地路径>   # clone 到 plugins/<name>，冲突时拒装
node scripts/plugin.js remove <name>             # 删目录（数据目录 data/plugins/<name> 保留，卸载不丢记忆）
node scripts/plugin.js update [name]             # git pull
node scripts/plugin.js list                      # 已装/已启用/缺失 一览
```

- `add` 分两步：先 clone 到 `plugins/.tmp-<rand>`，读 manifest 校验 name/apiVersion/requires，通过后再改名为 `plugins/<name>`；目录已存在、或 `manifest.name` 与预期不符 → 拒装（避免 clone 进一个装载器扫不到的目录）；
- `remove` 前先对插件目录跑 `git status --porcelain` 并检查未 push 提交——**"本地路径 add" 的开发流恰恰最容易积压未提交改动**，脏则拒删（`--force` 显式覆盖才放行）；
- `.gitignore` 增加 `plugins/`（`scripts/` 目录随 P2f-2 建立，属新增）；
- 配置里的插件清单（`config.json` 的 `features.<name>` 有 enabled 但 `plugins/<name>` 不存在）→ 启动日志提示"已配置但未安装"，不报错、不阻塞。
- 云部署形态：`config.json` 记录期望清单，新机器上 `plugin.js add` 两条命令 + 重启即完成还原。

---

## 4. 仓库与版本策略

| 仓库 | 内容 | 版本联动 |
|---|---|---|
| `whale-girl`（现有） | 核心 + 内置 mood/memory-timeline + 装载器 | 打 tag（vX.Y） |
| `whale-girl-plugin-bili` | B站子代理全家桶 | 打 tag；`plugin.json` 里写 `testedAgainst: "core vX.Y"` |
| `whale-girl-plugin-qq-napcat`（P2e） | QQ 桥（OneBot 11 HTTP） | 同上 |
| `whale-girl-plugin-qq-official`（P2e，可选） | QQ 官方开放平台适配器 | 同上 |

- 插件不锁核心版本，靠 `apiVersion` 握手兜底：**只有破坏性变更（删服务、改签名、改语义）才升 apiVersion**；纯新增服务不升版，靠 `requires` + `minCoreVersion` 兜底（§2.7）——两边规则不一致时以 §2.7 为准。
- **开发期工作流**：插件以本地路径 `add`（`plugin.js add ../whale-girl-plugin-bili`，直接 clone 本地仓库即可，机制同 git url），避免来回 push 才能测。
- **插件测试机制（三选一，选死）**：插件仓库 `tests/` 允许通过 `WG_CORE` 环境变量（缺省 `../whale-girl`）解析宿主绝对路径，require 宿主导出的 test-harness——**仅测试代码允许 require 宿主**，运行时代码零宿主 require（§2.2 不变，验收照旧 grep）。不采用 npm `file:` devDependency（本项目工具链零 npm，为测试引包管理器得不偿失）；也不把插件测试留在核心仓库——现有 `tests/bili-feature.test.js` 全是相对路径 require 宿主内部，拆仓后必 MODULE_NOT_FOUND，随 P2f-3 一并迁入插件仓库。
- **test-harness 是宿主的一等交付物（P2f-2）**：核心仓库导出 `tests/harness.js`，至少提供 `createStubCtx({ root, persona })`——返回带临时 dataRoot、可注入桩（fake llm/agent/store、记录型 bus）的完整 ctx 门面；同时导出 `createStubModuleOpts()` 覆盖 bili 现有 **7 个**注入口（`now / store / client / api / tools / provider / runAgent`，index.js:73-154）——只给 ctx 替不掉 `store/client/api/tools` 这四个测试真正打桩的对象，插件测试迁移会直接卡住。**人设夹具按 harness 自身的 `__dirname` 定位**（`path.join(__dirname, '..', 'personas', 'whale.json')`——harness 本来就在核心仓库里，核心即宿主，不依赖任何环境变量）；`WG_CORE` 只是**插件侧**解析宿主路径用的变量，插件找到 harness 即可。插件仓库不复制 fixture，避免两份漂移。harness 没有交付物，§4 这条机制就是空话——列入 P2f-2 验收。

---

## 5. 对 P2e 的影响

**排期更正：P2e 排在 P2f 完成之后开工**（原计划把 P2e 写在 P2f 前属排期倒置——`ctx.dispatchInbound` / `pushText({to})` 等契约在 P2f-1 一次定义到位，避免 P2e 开工时回头改 SDK、拆两次）。

QQ 双适配器**不再进核心**，直接按本规范做成两个插件。**适配层复用 `whale_gril` 的现成实现**（`src/adapters/gateway.js` 的 `normalizeInbound`、`src/bot.js:239` 的 `sessionKey = platform:g|u:chatId`、`src/memory.js:11` 的群内 `profiles[uid].notes`），搬进插件 `src/` 即可，核心只认 `dispatchInbound`——不同群/不同人的回复策略（@ 才接、`directedElsewhere` 判定、按用户记 notes）全部留在插件里，不进核心：

- 适配层产物即 §2.6.1 的入站形状（plugin/chatId/chatType/sender/msgId/atMe），核心不需要再解析平台字段；
- 多气泡按条投递（bili 一轮最多 3 条 → 3 条消息），间隔 200ms **由插件侧控制**，宿主不节流（否则 P2f-1「输出侧零变化」的锚点会从文案扩到节拍）；

- 三条腿分清楚：**入站**走 `ctx.dispatchInbound(msg)`（插件 → 宿主）；**主动播报**走 `ctx.pushText(text, { kind:'broadcast', to? })`（宿主广播 + 记忆）；**被动回复**走 `registerChannel` 的 `send`（插件持有句柄，宿主只做投递）——不再有「宿主回调插件 handler」的反向设计，方向单一、可单测。
- speak-up（主动搭话）**本期移出（设计保留、不排期）**：若后续恢复，按插件规范开发即可（它只需 `pushText` + 定时器，`to` 缺省发网页），不需要再动核心契约。

---

## 6. 分步实施（给 CodeBuddy 的施工顺序）

### P2f-1：SDK 抽取 + bili 去耦合（最难的一步，先行）

1. **先拆出渠道无关的对话入口，并做记忆写入的会话互斥**：把 `handleChat` 里内联的管线提成 `runTurn({ sessionId, text, image, onEvent }) -> { text }`（server.js:292-442），HTTP/SSE 只是它的一个消费者。**同时按 sessionId 加进程内互斥**——`dispatchInbound` 从本步起就是第二个写者（memory 是「读快照 + 整包覆盖」，memory.js:70-101），不先加锁，网页与 QQ 同时说话会互相回滚，而这不该留到 P2f-1b 才发现。`dispatchInbound` 要「调用进宿主分发器」，没有这个函数，渠道插件与 P2f-2 的 headless 验收都没有可调对象。
2. `featureContext` 新增 `makeAgent / persona.compose / pushText / storage / addTool / dispatchInbound / registerChannel`（§2.3 表格）；**统一消息形状定型**（§2.6：含 `chat / sender / msgId / flags / to` 的完整形状，字段对齐 gateway）——作用域是**传输与展示层**：pushText 补全字段后广播，记忆落盘仍是 `{ role, content, at }`（§2.5「字段适配」）；`bus` 从插件 ctx 与 requires 移除；**provider 解析收进宿主服务**（makeLlm 绑定 provider、makeAgent 内部取），bili 侧删除 `resolveProvider(live)` 直用；`persona.compose` 返回 `{ messages, reply }`，bili 改读 `reply.maxBubbles`，**播报侧必须传 `{ history: false, memory: false, features: false }`（§2.3）**；**pushText 只做收口**（形状补全 + 广播，行为等价现状），记忆与 mood 语义不在本步（§2.5 = P2f-1b）；addTool 一次定义到位（§7：宿主合入已启用插件的工具并强制 `plugin_<name>_*` 命名空间）；`dispatchInbound` 定契约 + 注册校验，入参经 `runTurn` 调通并落对应会话，不接真实渠道（P2e 使用）；
3. bili 全部文件改写为只依赖 `ctx.*`：`require` 面收敛到自身目录（含删掉 `require('../settings')`——bili/index.js:3 也是宿主依赖，只 grep `../../` 会漏）；播报改走 `ctx.pushText`，删掉 `ctx.bus.emit('push', …)`（index.js:129）与无人订阅的 `ctx.bus.emit('bili-report', …)`（index.js:158）；**数据路径原地不动**——store 继续用 `<dataRoot>/data/bili`，不切 `ctx.storage.dir('bili')`（切了等于当场清空额度与判重，而本步验收只看文案/气泡数，抓不到）；
4. **验收（本步只认输出侧）**：
   - **输出侧零变化**：播报文案、气泡数（随 maxBubbles）、推送目标不变；**206** 个测试全绿 + 手动触发一轮正常；
   - **grep 四条零结果**（范围 `src/features/bili/`）：`require('../`（覆盖 `../../` 与 `../settings`）、`resolveProvider`、`buildMessages`、`emit('`；
   - **数据零迁移**：跑一轮后 `<dataRoot>/data/bili/state.json` 被更新，且 `data/plugins/` 不存在（证明没提前换路径）；
   - **requires 提前验**：用「只注入 requires 声明服务」的白名单 ctx 跑通 bili 一轮——漏声明在这里就暴露，不等 P2f-2 一次性爆；
   - addTool 单测：命名空间强制 `plugin_<name>_*`、撞名拒绝、插件禁用后其工具从 agent 工具面消失；registerChannel 单测：未注册渠道名 → pushText 只 warn 不抛；注册后按 chatId 投递、不广播网页；**注册名与消息 `source` 不一致时拒收（或至少 warn）**；**`drop()` 之后该渠道的 send 不再被调用、pushText 只 warn**（插件停用后的投递泄漏必须能被测出来）；
   - runTurn / dispatchInbound 单测：不经 http 直接驱动一轮对话；dispatchInbound 的入参能落到对应会话、回复经 send 投递（用桩，无真实渠道）；
   - **并发写不丢**：网页一轮进行中经 dispatchInbound 往同一会话再写一条，结束后两条都在——本步交付的互斥必须自带测试，不许留给 1b。

### P2f-1b：播报即记忆（行为变更，独立成步）

前置见 §2.5 开头：会话归属与下游排除还没做的话不许开工；记忆并发写者模型已由 P2f-1 交付，本步只复用、不许绕开。

1. `memory.appendSelfTurn(msg)`：`msg.text → content`、`msg.ts → at`，落盘形状不变；**写路径不调 `decayFacts`**（memory.js:140 现在是每 turn 必衰减）；
2. `extractFacts` 与摘要窗口显式跳过带 self 标记的 turn（server.js:208 / memory.js:234-246），并给出「真实对话条数」的计数规则；
3. `mood` 新增 selfPost 处理：按轮去重（一轮多气泡只 +2）、写 mood 时间线事件、不触发 afterReply；
4. `pushText` **按 kind 分流后**串起，顺序固定、每步失败只记日志（硬约束 2）：
   - `kind:'broadcast'` → 形状补全（`self:true`、`to` 缺省 `null` = 发网页）→ 按 `to` 广播 → appendSelfTurn（固定 `main`）→ selfPost；
   - `kind:'reply'` → **只按 `to` 调 send**，跳过记忆、网页广播与 mood（与 §2.5 分流一致）；
5. **验收**：
   - self turn 前后 facts 的 strength 不变（断言）；
   - **roundId 兜底**：连续两轮播报各 +1（不传 roundId 时宿主生成，不能因为 `undefined === undefined` 被去重成永远只加一次）；
   - 播报 3 条之后，下轮聊天的事实抽取输入里不含播报内容；
   - 同一会话里追问「刚才那个视频」能答（人工）；网页刷新后 `/api/messages` 仍能看到那几条；
   - **并发回归锁**：复用 P2f-1 已建的那条并发测试（网页一轮进行中经 dispatchInbound 写入），确认 self turn 接入后仍不丢；
   - 关闭 bili 开关后，上述三条副作用全部消失（回归主链路）。

### P2f-2：装载器 + manifest + plugin.js + 设置页（均为新建）

1. **装载器**（§3.1）：`plugins/*/` 扫描 → manifest 校验（name 唯一 / apiVersion / requires / minCoreVersion）→ **先判 enabled 再 require** → `create()` 纯声明 → 注入 `scoped(name, requires)`；单插件失败只跳过它；`defaultModules()` 补上插件，`FEATURE_NAMES` 改为「内置 + 已装载 manifest」动态生成（config.js:32）；
2. **requires 真裁剪**（§2.2）：`scoped(name, requires)` 只挂声明过的服务，未声明的 key 访问即抛错；校验在 `create` 之前，缺失就拒载并写明缺哪个（现在 `Object.create(context)` 全给，features.js:49-50）；
3. **路由命名空间**：插件只声明后缀，宿主拼 `/api/plugins/<name>/…`；否则 `matchRoute` 先命中者赢（features.js:161-172），插件能劫持内置路由；
4. **参数变更即重装**：`sync()` 现在只在 enabled 变化时 start/stop（features.js:150-157），改 `intervalMinutes`/`dailyQuota` 不生效——比对 section 摘要，变了就 stop+start；
5. **新建** `scripts/` + `scripts/plugin.js` 四个子命令（`add` 先 clone 到 `plugins/.tmp-*` 校验 manifest 再改名，目录冲突或 name 不符拒装；`remove` 含脏工作区保护）；`.gitignore` 加 `plugins/`；
6. **新建** `/api/features/schema`、`/api/features/state`（state 复用 /api/health 的 features 聚合）+ `public/settings.html` 动态表单 + 写回接口（**只写 `features.<name>`、保留其余字段；tmp+rename 原子写；写前 `loadConfig` 试解析，非法就不落盘；`hotReload=false` 时 UI 明确提示需重启**）；后端文件另起名（如 `src/settings-page.js`），不要塞进 `src/features/settings.js`——那是开关判定 helpers，同名不同物；
7. mood / memory-timeline 补 schema，接入同一渲染逻辑；
8. **新建 `tests/harness.js`**：`createStubCtx({ root, persona })` + **`createStubModuleOpts()`**（覆盖 bili 现有 7 个注入口 `now/store/client/api/tools/provider/runAgent`——只给 ctx 替不掉 `store/client/api/tools`）；人设夹具按 harness 自身 `__dirname` 定位，不依赖 WG_CORE（那是插件侧的变量）；§4 已定义为宿主一等交付物；
9. **网页降级为被动终端（§2.6）**：`features.web` 走 **opt-out 三态**（`!sectionOf(config,'web') || enabled !== false`，并先改 `pickFeatures` 不再把「未写 enabled」归一成 false，config.js:56-63）；`serveStatic` 只从**插件** ctx 裁剪（内置 memory-timeline 仍要它挂 `/memory`，memory-timeline.js:34，全局删会 500）；新增 `GET /api/messages?limit=N`（窗口用与聊天同一常量 `HISTORY_LIMIT`=MAX_HISTORY 20，不用 keepRecentTurns=12）；前端不写本地持久历史（会话固定 `main`，localStorage 既不存 sessionId 也不存消息）；
10. **验收**：
   - `plugin.js list` 正确；settings 页改配置即生效（只动 `features.<name>`、其余字段原样保留），且**改 `intervalMinutes` 后 `/api/features/bili/state` 回显新值、定时器按新间隔跑**；
   - 删掉 plugins/ 目录后核心服务照常启动、日志提示缺失；
   - **requires 生效**：manifest 少声明 `storage` 时访问 `ctx.storage` 抛错，拒载日志写明缺哪个；
   - **禁用不执行**：某插件 enabled=false 时，其 `index.js` 顶层打点不出现（证明没 require）；
   - **命名空间**：插件注册 `/state` 实际可达 `/api/plugins/<name>/state`，且无法覆盖 `/api/memory` 等内置路由；
   - **web 三态**：无 `features.web` → 网页照常；`{"web":{}}` → 网页照常；`{"web":{"enabled":false}}` → 静态页与 `/api/chat` 关闭；
   - **反断言：QQ 会话不上网页**：用 dispatchInbound 写一条 `qq:g:<chatId>` 会话后，`/api/messages` 只返回 `main` 的内容——「URL 里列全部会话」是退化实现，必须挡住；
   - **`/memory` 不回归**：web 开着时 `/memory` 页仍能打开（serveStatic 裁剪没误伤内置）；
   - **真裁剪两跑**：同一个 bili 冒烟测试，用 harness 白名单 ctx 与宿主真 `scoped` 各跑一遍都绿——只跑前者，P2f-1 的绿是假绿；
   - 用 `createStubCtx` 跑通至少一个插件的启停测试；**headless 验收用 P2f-1 的 `runTurn` 直驱一轮**（不依赖 http），核对 turns 增长与事实衰减节拍——真实渠道端到端留待 P2e；
   - **投影验收**：`GET /api/messages` 只返回 `HISTORY_LIMIT` 窗口内消息（含 self turn），窗口外不出现；问她窗口外旧事，回答来自事实/摘要层。

### P2f-3：拆仓库 + 数据迁移（机械步骤，放最后）

1. **代码与资源一起搬**：`src/bilibili/*` → 插件 `src/`；`src/features/bili/{index,runner,store,schedule,duty}.js` → 插件 `index.js` + `src/`；**核心仓库根目录的 `prompts/bili-duty.md` 一并搬进插件 `prompts/`**；
2. **资源路径改 `__dirname`**：`duty.js` 默认章程路径改成 `path.join(__dirname, '..', 'prompts', 'bili-duty.md')`，删掉 `root: ctx.root` 的传递（index.js:146）；用户在 `features.bili.dutyFile` 里的相对路径**按插件目录解析**（写进插件 README）。数据路径在这一步一起切：store 改用 `ctx.storage.dir('bili')`（→ `<dataRoot>/data/plugins/bili`），与第 3 步的 mv 同步生效，**顺序必须是「先停服 mv、再升级插件」**，反过来会出现「插件读新路径、数据在旧路径」的空目录；这处不改，拆仓后默认章程指向核心仓库已被删的文件 → 「读不到子代理章程」→ 整轮失败，而异常会被硬约束 2 吞成一条日志；
3. **数据迁移（必须停服）**：`systemctl stop` → `mv <dataRoot>/data/bili <dataRoot>/data/plugins/bili` → 启动 → 对账。**不能带服迁移**：运行中的 store 会按旧路径重建 `data/bili`，变成两套数据各自记账。不迁的后果：当日额度归零可多跑一轮、seen 丢失把播过的视频重推一遍（现在 seen 仅 2 条，长期只会更多）。选显式 mv 而非运行时旧路径回退：实现简单、可核对、可回退；
4. 核心仓库 `git rm` 对应文件（含 `prompts/bili-duty.md`），`defaultModules()` 只剩内置两个；`tests/bili-feature.test.js` 迁入插件仓库并改用 WG_CORE；
5. `plugin.js add` 装回、启用、跑通完整 E2E（手动触发 → 报告 → 播报）；
6. **总验收（P2f 关账标准）**：
   - 全新 clone 核心仓库 + 不装插件 → 聊天主链路完整可用；
   - `plugin.js add <bili 仓库>` + enabled → B站功能恢复，行为与拆分前一致；
   - **资源自足**：把核心仓库的 `prompts/` 清空后插件仍能跑（章程来自插件目录）；`dutyFile` 写相对路径时按插件目录解析；
   - **无宿主路径依赖**：`grep -n "ctx\.root\|ctx\.dataRoot" <插件目录>` 零结果；
   - **数据连续**：迁移前后 seen.json 条目、当日剩余额度、digest/out 文件数一致（不重推、不超额）；
   - 关闭开关回归主链路零影响（老规矩）；
   - 测试全绿（核心与插件各自成套，插件经 WG_CORE 跑 `node --test`）。

### 风险与对策

- SDK 抽取动到 runner/persona 边界（含 provider 解析收权、persona 元信息、对话入口拆分）→ P2f-1 独立成步、**输出侧**零变化的验收卡死，混入拆仓库必出事；验收 grep 覆盖 `require('../`、`resolveProvider`、`buildMessages`、`emit('push'` 四类残留；
- **装载器最容易做成「假隔离」**（P2f-2）→ `scoped` 不裁剪则 `requires` 形同虚设；先 require 再判 enabled 则「关掉的插件还在跑」；插件路由不设命名空间会被 `matchRoute` 的先命中者劫持。三条都写进验收，别只测「能加载」；
- **记忆是多写者**（P2f-1b 前置）→ 现在 `openMemory` 读快照 + `save()` 整包覆盖，聊天与播报并发会互相回滚；不先做写入模型就开放第二个写者，症状是「她忘了我上一句」「她不记得自己说过」，且串行测试永远抓不到；
- 插件间无依赖（都是独立能力）→ 暂不做插件依赖解析，规范先写"插件间禁止互相 require"，将来真出现需求再说；
- **资源路径是拆仓的隐形雷**（P2f-3）→ 章程/prompt 走 `ctx.root` 相对路径，拆仓后指向核心仓库；读不到时抛错又被硬约束 2 吞成日志，表现为「插件启用了但一轮都不跑」。验收必须有「清空核心 `prompts/` 后插件仍能跑」。
- 云上 2G：插件按需安装，内存增量 = 已装插件自身（bili 约 10-20MB），无影响。

---

## 7. 延展性预判：小红书 / Q群问答 等未来插件（约束：特性一致，契约不再膨胀）

用户已明确后续可能增加"逛小红书""问Q群"等能力。**所有新能力必须走同一插件契约**（manifest + create() + configSchema + 同一套设置页/启停/记忆/心情语义）。按能力形态分四类，各需要的契约面如下：

| 形态 | 代表 | 需要的 ctx 服务 | 契约缺口 |
|---|---|---|---|
| 内容扫描类 | bili（已实现）、小红书 | makeAgent + persona.compose + pushText + storage + getEnv（平台 cookie）+ configSchema | **零新增**——bili 即此类模板 |
| 渠道类 | QQ 桥（NapCat/官方） | pushText + **dispatchInbound** + **registerChannel**（P2f-1 已定） | 无（适配层复用 whale_gril 的 gateway） |
| 主聊工具类 | 问Q群（群里聊了什么/翻群历史答问） | **addTool**（本次新增，见 §2.3 表） | 已补 |
| 人格内置 | mood、memory-timeline | 不插件化，留核心 | 无 |

**延展性纪律（防契约膨胀）**：

1. **第二实例法则**：做小红书插件时先**复制 bili 仓库骨架**改平台层（接口/cookie/配置），宿主契约一个字都不许改；如果实现时发现"不改宿主就做不出来"，停下先回来讨论——那是契约真缺口的信号，走 apiVersion 升级流程，而不是插件侧绕路。调度/判重/store 这套"扫描-挑-报"骨架暂**不**抽成共享 SDK（两个实例不构成抽象依据，等第三个同类出现再说；参考实现可留在 harness 里）。
2. **数据主权**：每个插件的数据（含平台历史记录，如 Q群消息日志）只存自己的 `data/plugins/<name>/`，工具也归同一插件注册——"问Q群"的工具由 QQ 插件自己提供（读自己存的日志），**不存在跨插件读数据的场景**，插件间禁止互访数据的规则不破。
3. **统一语义自动继承**：任何插件经 pushText 播报 → 自动进短期记忆（self turn）+ 触发 mood selfPost；经 addTool 注册的工具 → 返回值即上下文。小红书/问Q群不需要（也不允许）自己接记忆或心情。
4. **合规隔离**：小红书无公开 API、风控严格——独立仓库 + 接口层单文件的既有结构保证其失效时影响仅限自身（feature 宿主的故障隔离兜底），不牵连 bili 与主链路。
5. **requires 如实声明**：内容扫描类不需要 addTool 就不声明（如 bili 的 requires 不含它）；宿主按声明校验，多给不给、少给拒载。
