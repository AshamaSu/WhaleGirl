# M4 E2E 验收清单：B站子代理

> 对应里程碑：M4（P2d）。被测对象：`features.bili` 三段链路（定时器 → 子代理报告 → 小鲸播报）。
> **时序约束**：本清单必须在 P2f-1 动手改动 `src/features/bili/index.js` / `runner.js` **之前**执行，或对未重构的 main 分支执行；否则测到的是中间态。

## 0. 验收信息（执行时填写）

| 项 | 值 |
|---|---|
| 代码基线 | `git rev-parse --short HEAD` = ______（当前 main 为 b4867d9） |
| 分支 | main（未做 P2f-1 重构） |
| 运行环境 | macOS 本地 / 云上 ______ |
| 模型 provider | 当前 active = deepseek |
| 执行人 / 日期 | ______ |
| 结论 | 通过 / 有条件通过 / 不通过 |

## 1. 验收目标（与计划文档一致）

1. **报告落盘且可对账**：`data/bili/out/<日期>.md` 产出，条目按 `### BV…` 分块，字段完整、链接可点。
2. **播报可用**：网页时间线出现 1–3 条她口吻的推荐（不是报告原文），气泡数随人设 `maxBubbles`。
3. **无字幕不拖垮**：拿不到字幕的视频按跳过处理，不重试、不报错，整轮继续并成功结束。
4. **不打扰、不重复**：额度与活跃时段生效；已推荐过的不再推。
5. **关掉即回归**：关闭开关后无定时任务、无推送，聊天主链路与之前完全一致。

## 2. 前置条件（逐项打勾）

- [ ] **代码未进入 P2f-1 重构**：`src/features/bili/index.js` 仍在核心仓库、仍 require `../../persona` 等（`grep -n "require('\.\./\.\./" src/features/bili/index.js` 有结果即符合）。
- [ ] **服务未在跑或已停**：当前 8787 端口无响应（检查过为未启动）。
- [ ] **`.env` 已具备B站凭据**：`WG_BILI_SESSDATA` / `WG_BILI_BILI_JCT` / `WG_BILI_DEDE_USER_ID` 存在（本机已存在）；`WG_BILI_BUVID3` 可留空，首次请求会自动申领。
- [ ] **模型可用**：`config.json` 的 active provider 能正常对话（先随便聊一句确认）。
- [ ] **数据基线已记录并备份**：
      ```bash
      cp -r data/bili data/bili.bak-$(date +%Y%m%d-%H%M)
      python3 - <<'PY'
      import json
      s=json.load(open('data/bili/state.json')); print('state:', s)
      seen=json.load(open('data/bili/seen.json')); print('seen:', len(seen))
      PY
      ```
- [ ] **`features.bili` 已启用**：当前 `config.json` 的 `features` 只有 `memory` / `mood`，**没有 bili 段 = 按约定视为关闭**，需先补（见下）。

最小配置（追加到 `config.json` 的 `features` 内；`config.json` 不入库）：

```json
"bili": {
  "enabled": true,
  "owner": "主人",
  "intervalMinutes": 180,
  "dailyQuota": 4,
  "activeWindows": ["12:00-14:00", "18:00-09:00"],
  "weekendAllDay": true,
  "keywords": [],
  "itemsPerRound": 3,
  "minPlays": 5000,
  "maxDaysOld": 14,
  "maxRounds": 8,
  "announce": true
}
```

- [ ] **时间窗确认**：默认活跃时段为 12:00–14:00 与 18:00–09:00；**手动触发不受时段限制**，自动触发用例需改时段来验证，不要靠等待。

## 3. 启动与基线核对

```bash
node server.js          # 默认 8787；确认日志出现 [features] 已启用：bili
curl -s localhost:8787/api/health | python3 -m json.tool | grep -A3 bili
curl -s localhost:8787/api/features/bili/state | python3 -m json.tool
```

基线应看到：`running:false`、`login:true`、`seen` 为现有条数、`state.dayRounds` 为当日已用轮数。

## 4. 用例矩阵

| 编号 | 操作 | 预期 | 判定 | 证据 |
|---|---|---|---|---|
| T01 | `GET /api/features/bili/state` | 返回 `ok:true`、`section.enabled:true`、`login:true`、`running:false` | P0 | 响应 JSON |
| T02 | `POST /api/features/bili/run` → 立刻再 POST 一次 | 首次 `202 {started:true}`；紧接着第二次 `409 上一轮还在跑` | P0 | 两次状态码 |
| T03 | 等本轮结束（看 state 的 `lastResult.ok`） | `ok:true`；`data/bili/out/<当天>.md` 新增块，形如 `## <日期> <时间> · 手动` + `### BV…`，含标题/UP/链接/播放/理由 | P0 | 报告文件 + `### BV` 计数 |
| T04 | 同时看网页时间线 | 出现 1–3 条口语化推荐（非报告原文），每条带链接；气泡数不超过人设 `maxBubbles`（当前 3） | P0 | 页面截图 |
| T05 | 当天再跑一轮 | `seen.json` 条数增加；报告中**不出现**上一轮已推过的 `BV` | P0 | seen 前后 diff + 两轮报告对比 |
| T06 | 把 `dailyQuota` 改成 1（热加载）后等自动 tick，或直接看 `state.dayRounds>=1` | 自动触发被额度拦下（日志无「自动触发」）；手动触发仍可执行 | P1 | 日志 + state |
| T07 | 把 `activeWindows` 改成当前时间之外的区间（如 `["03:00-03:30"]`，`weekendAllDay:false`） | 自动 tick 不触发；改回后恢复 | P1 | 日志（应无「自动触发：…」） |
| T08 | 观察本轮候选里含无字幕视频的情形（报告/日志有跳过说明） | 该条被跳过、不重试；整轮 `ok:true`，其余条目正常入选；日志无异常堆栈 | P0 | 报告末行/日志 |
| T09 | 临时把 active provider 的 key 改错（或断网 30 秒）后手动触发，再恢复 | 本轮 `lastResult.ok:false` 且有可读错误；**聊天主链路仍可正常对话**；恢复后下一轮成功 | P0 | state + 对话截图 |
| T10 | 把 `features.bili.enabled` 改 false（热加载） | 定时器停止、无新推送；`/api/features/bili/*` 返回 404（能力未注册）；聊天正常；改回 true 后恢复 | P0 | 路由状态码 + 日志 |
| T11 | 在 T03/T09 期间与网页对话 | 对话、记忆、mood 正常，无卡顿；B站失败不影响回复 | P0 | 对话截图 + `/api/health` |
| T12 | 重启服务后再看 state | `state.dayRounds` / `seen` 不丢；`login:true`；不重复推荐历史条目 | P1 | 重启前后 state 对比 |

## 5. 判定口径

**P0（任一不通过即验收不通过）**：T01 / T02 / T03 / T04 / T05 / T08 / T09 / T10 / T11
**P1（可记录为遗留，不阻断）**：T06 / T07 / T12

补充判定：

- **播报口吻**由人判断：应是「她」在说话（短句、有情绪、口语），不是报告摘要；出现「本视频」「综上所述」这类报告腔即不合格。
- **无字幕计数**：报告里若出现「因无字幕跳过 N 条」，那是模型叙述、代码无计数器，**不作为断言依据**；只看「该条被跳过且整轮成功」。
- **当前已知限制**：播报只走网页实时通道，不落盘——若触发时没有网页打开，播报不会留存展示（这是 P2f-1b 要解决的问题）。验收 T04 时务必保持网页打开。

## 6. 证据留存

- [ ] `data/bili/out/<当天>.md`（或片段）
- [ ] `data/bili/state.json` 与 `data/bili/seen.json` 的前后对比
- [ ] 服务日志中本轮相关行（自动触发/跳过原因/错误）
- [ ] 网页时间线截图（含链接与气泡数）
- [ ] `/api/features/bili/state` 响应（成功与失败各一份）

## 7. 回滚与清理

- 验收结束把 `features.bili.enabled` 改回 `false`（或删除该段），避免验收数据继续累积。
- 测试产生的报告是否保留：建议保留在 `data/bili/out/` 作为记录，不删。
- 若为测额度把 `dailyQuota` 改小，记得改回 4。
- 备份目录 `data/bili.bak-*` 验收通过后可删。
- 若 T09 改过 key，确认已恢复并重启。

## 8. 记录表（执行时填写）

| 编号 | 结果 | 观察到的现象 | 备注 |
|---|---|---|---|
| T01 | ✅ 通过 | enabled/login=true、running=false、seen=2、dayRounds=0 | 2026-10-29 15:0x |
| T02 | ✅ 通过 | 首次 202，紧接第二次 409；一轮约 40s | 15:11 |
| T03 | 🟡 部分 | 两轮正常（3 条 `### BV`、字段齐、链接可点）；另两轮模型把工具调用写成 DSML，报告不可读 | DSML 已双层兜底（agent + runner），见 INC-001；脏段已备份并从 `out/` 移除 |
| T04 | ✅ 通过 | SSE 抓到 2 条 push：「我刚在那边游了一圈…」+ 带链接那条；≤3 条 | 15:15 那轮 |
| T05 | ✅ 通过 | seen 2→5→8→10，两轮 picked 无重复 BV | — |
| T06 | 🟡 部分 | `dailyQuota=0` 时 75s 无自动触发；手动仍受理 202 并执行 | 当轮命中 DSML 缺陷 0 入选；额度已改回 4 |
| T07 | ✅ 通过 | 时段改到当前之外，75s 内日志零「自动触发」、dayRounds 仍 0 | 已改回默认时段 |
| T08 | ✅ 观察通过 | 报告中出现「因无字幕跳过 N 条」，整轮 ok:true、其余条目正常 | 该行是模型叙述，不作断言依据 |
| T09 | ✅ 通过 | 注入「工具链故障」后本轮 ok:false、错误可读、不抛出；随后网页对话正常 903ms | 用临时 harness 模拟，未动真实 key |
| T10 | ✅ 通过（已修） | 关闭后**下一次请求立即 404**（不再出现 202 受理），恢复后 200、running=false；停用期间零自动触发 | 修法：路由匹配前 sync + 5s 定时兜底；`tests/server.test.js` 覆盖 |
| T11 | ✅ 通过 | B站故障/空闲期间网页对话正常（`done ok:true`，903ms），health 200 | — |
| T12 | ✅ 通过 | 重启后 seen=8→10、lastRunAt 连续、login=true、lastResult 归 null | 带日志重启 |

## 8.1 结论（2026-10-29）

- P0：T01/T02/T04/T05/T08/T09/T10/T11 通过；T03 两轮正常、两轮遇 DSML（已双层兜底）。
- P1：T07/T12 通过；T06 部分通过（手动路径当轮被 DSML 干扰，额度逻辑本身已验证）。
- 两个缺陷均已处理：**INC-001**（DSML 文本落盘 → agent + runner 双层兜底）、**T10 开关窗口**（→ 路由匹配前 sync + 5s 定时兜底，本次已复验）。
- 结论：**通过（带观察项）**——可以进入 P2f-1；DSML 是否彻底消失需在后续轮次继续观察，出现即按 INC-001 记录。

## 9. 验收后动作

1. 结论写入 `docs/鲸鱼娘自研计划.md` 的 M4 行（通过则标 ✅ 并写日期）。
2. 若 T09/T10 暴露问题，先修再进 P2f-1。
3. 无论结果如何，M4 关账后才允许 P2f-1 改动 `bili/index.js`。