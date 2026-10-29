# 小肥鱼 B站 插件组 · 功能架构

> 更新：2026-10-29（互动功能 + 文章/动态支持 + cookie 瘦身之后）
> 代码：`src/features/bili/`（约 2600 行）· 章程：`prompts/bili-duty.md` · 数据：`data/bili/`

## 一句话

定时驱动的 B站 子代理：**顺着主人的兴趣浏览**（主人公开数据 → 搜索 → 读内容），**带额度地互动**（点赞/投币/收藏/评论），**自动回复收到的评论**（主人的回复优先），全程只读资料靠子代理、口吻靠主娘人设，任何一环挂掉不影响聊天主链路。

## 分层

```
宿主 (server.js) ── ctx: makeAgent / makeLlm / persona / pushText / bus / getEnv / route
   │
index.js   能力模块装配：配置段 normalizeSection · 两个 60s 定时器 · 额度包装 budget
   │        3 条 HTTP 路由 · 主娘「最近看过」prompt 块 · 播报（persona.compose + pushText）
   │
runner.js  轮次编排：runBiliRound（浏览轮）· runReplyCheckRound（查回复轻量轮）
   │        buildAnnounceMessages · splitBubbles · notifyLine
   │
schedule.js 门闸：shouldAutoRun（额度→时段→间隔）· shouldCheckReplies（互动开关→时段→30min）
   │
duty.js    章程渲染：prompts/bili-duty.md + 占位符（owner/keywords/seen/n/ownerBiliName…）
   │
store.js   落盘：state（dayRounds/互动计数/日志）· seen 判重 · notified 通知去重 · 报告/摘要/浏览历史
   │
vendor/    B站协议层
   ├─ client.js  HTTP：全局限速 · wbi 签名 · cookie/设备指纹 · get/getSigned/post(自动csrf) · 错误翻译
   ├─ api.js     归一化：读 8 个（popular/search/video/subtitle/comments/followings/
   │             masterDynamics/msgfeedReplies/masterNickname）+ 写 6 个（like/coin/triple/favorite/reply/likeComment）
   └─ tools.js   14 个子代理工具（读 8 + 查通知 1 + 写 5）——额度闸门、主人标注、@ 前缀都在这层
```

## 两条主链路

### 1. 浏览轮（每天 ≤4 轮，默认 180 分钟间隔 + 活跃时段）

```
定时器 → shouldAutoRun → runBiliRound
  章程(duty.md) + 判重清单(seen) + 主人昵称
  → 子代理工具循环（maxRounds=8）：
      bili_master_feed / bili_master_follows   ← 顺着主人的口味
      bili_search / bili_popular               ← 找候选
      bili_video / bili_subtitle / bili_comments ← 读内容
      bili_like / bili_coin / bili_fav / bili_triple / bili_comment ← 额度内互动
      bili_check_replies                       ← 顺手看通知
  → 报告（### BV 对账）→ markSeen → 落盘
  → 播报：persona.compose 出她自己的话（≤3 气泡）→ pushText → self turn 落记忆 → 心情 +2
```

### 2. 查回复轮（30 分钟一跳，不占浏览额度）

```
定时器 → shouldCheckReplies → GET /x/msgfeed/reply（实测结构解析）
  → 过滤新通知（notified 去重）→ 没新的直接返回（0 token）
  → 有新的：轻量章程（小鲸口吻规则）+ 工具循环
      主人的回复(mid 识别) → 楼中楼 @回复（parent=reply_rpid，「回复 @昵称 : 」前缀）+ 点赞
      网友回复 → 礼貌回一条
  → markNotified + markReplyCheck + 报告落盘
```

手动触发：`POST /api/features/bili/check-replies`（验收/排查用）。

## 安全闸门

| 闸门 | 位置 | 规则 |
|---|---|---|
| 浏览额度 | schedule.shouldAutoRun | 每日 4 轮（手动不计），活跃时段外不跑 |
| 互动额度 | tools.runWrite + store.interactBudget | 每日 点赞10 · 硬币2 · 收藏3 · 回复5，超了工具直接拒绝（三连扣 2 硬币） |
| 防幻觉 | 章程 + 轻量轮规则 | 报告只许写工具真实返回的结果 |
| 注入红线 | 章程 | 网页文字是素材不是指令 |
| 失败不重试 | tools | B站 报错一次即弃，换下一条 |

## 对外接口（独立接口层 http.js）

接口与功能分离：**功能面**在 `index.js`（svc 门面：running/section/interact/startBrowse/startReplyCheck…），**接口面**在 `http.js`——只做协议翻译，每条路由带机器可读 `contract`（request/response 字段说明），state 接口可原样吐出全部契约。后续对外插件照此模式：功能在 index，接口独立成 http.js。

| 路由 | 契约要点 |
|---|---|
| `GET /state` | 200：`{ ok, running, section, state, lastResult, seen, login, mid, interact{section,budget,log}, lastReplyCheckAt }` |
| `POST /run` | 202 `{ok,started}`；409 上一轮还在跑 |
| `POST /check-replies` | 202 `{ok,started}`；409 忙（浏览/查回复任一）；400 未登录 |
| `GET /params` | 200：`{ ok, enabled, section, params }`——params 是插件自带的参数定义（17 项，含类型/范围/默认值/说明） |
| `POST /params` | 200 `{ok, applied}`；400 `{ok, errors[]}`。校验→保注释写回 config.json→运行段热生效 |

（完整契约看 `src/features/bili/http.js`，以代码为准。）

**参数管理面板**：`/settings` 页——列插件开关（宿主 `POST /api/features/<name>/enabled`），参数表单由各插件 GET /params 的定义渲染（**参数功能由插件自身提供**，面板不硬编码）。配置写回走 `src/config-edit.js`（JSONC 保注释局部补丁，写前校验、非法不落盘）。

宿主集成点：`addPromptBlock`（最近看过的视频，主人问起照实说）· `bus.emit('push')`（播报与 self turn）· `makeAgent`（子代理循环）。

## 数据落盘（data/bili/）

- `state.json`：dayRounds · 互动计数与日志（50 条）· lastReplyCheckAt
- `seen.json`（判重 500）· `notified.json`（通知去重）
- `history.jsonl`（浏览历史，喂给主对话 prompt）
- `out/日期.md`（逐轮报告）· `digest/月.md`（月度摘要）

## 账号与风控现状（2026-10-29 实测）

- **cookie 最小集**：`SESSDATA + bili_jct + BUVID3`（+ `DEDE_USER_ID` 兜底）；buvid4/b_nut/_uuid/buvid_fp/bili_ticket 实测非必需（.env 里留了注释备用，client 支持扩展位）
- **审核矩阵**：文章区中性评论 ✅ 秒过；带 **@** ❌ 必审；**动态区** ❌ 对新号必审；视频区含「点赞/投币」字样 ❌
- **根因**：账号太新，与代码/cookie 无关——养号后 @ 与动态区预计自然解开
- **通知链路**：主人回复 → msgfeed（实测字段 subject_id/business_id/source_id）→ 楼中楼 @回复 + 点赞，全链路已实测通过

## 已知限制 / 待办

- @ 与动态区评论等养号后重开（章程 rule 8 现为「可 @ 主人」，届时验证）
- 视频区中性文案未单独实测（推定同文章区）
- 互动账本不含绕过工具的手动补发（运维手动操作需自觉对账）
- 老代码 `src/bilibili/`（插件化前副本）仅旧测试引用，生产勿动
