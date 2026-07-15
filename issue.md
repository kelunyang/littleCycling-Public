# 踩雷紀錄

已解決但值得記住的坑。新增條目往上疊(最新在前)。

---

## 2026-07-15:SSE 回應 `Connection: keep-alive` 毒化 proxy socket → 下一個請求神祕 400

### 症狀
- LLM 課表生成:AgentProgress「提交課表」打勾、server log 有 `Plan created`、
  toast 顯示成功,但前端 Your Presets 列表一直是 0;重啟 server(頁面重載)才看得到。
- 前端 console 一開始**完全沒有錯誤**(fetchPlans 對非 200 靜默 `return`)。
- 補上錯誤 log 後現形:`GET /api/plans → 400 {"error":"Bad Request","message":"Client Error"}`
  ——這是 Fastify 預設 `clientErrorHandler` 的專屬簽名,代表請求在 **socket 解析層**
  就掛了,根本沒進 route。

### 根因
SSE 端點(`POST /api/plans/generate`、`/api/analysis/generate`)的
`raw.writeHead(200, { Connection: 'keep-alive', ... })`:

1. Vite dev proxy(http-proxy)轉發請求時帶 `Connection: close`;
2. 我們的 SSE 回應卻宣告 `keep-alive`;
3. proxy 端的連線池(Node ≥19 `http.globalAgent` 預設 keep-alive)信了回應,
   把 SSE 用完的 socket **重用給下一個請求**;
4. server 的 HTTP parser 認定該 socket 在 `Connection: close` 後不得再有資料
   → `HPE_CLOSED_CONNECTION`(Parse Error: Data after `Connection: close`)
   → Fastify 回 400 Client Error。
5. 生成結束後前端第一個請求就是 `fetchPlans` → **每次必中** → 列表永遠不刷新。

### 修法
- SSE 回應一律 **`Connection: 'close'`**(串流照常逐幀,只是結束後 socket 不得重用)。
  兩個 SSE 端點都改了;**未來任何新的 hijack/SSE 端點都要遵守**。
- 前端 store 對 `!res.ok` **不得靜默吞掉**(fetchPlans 已改為 console.error + toast)。

### 診斷工具(留在 codebase,再遇到直接看)
- `server.ts` 自訂 `clientErrorHandler`:把 `HPE_*` 錯誤碼 log 成
  `[server] client error: <code> — <message>`(預設 handler 完全不說原因)。
- `plan-api`/`analysis-api` 每幀 log:`[xxx-api][sse] → <phase> (<bytes> bytes)` +
  `stream closed`。
- `useAgentStream` 前端逐幀 `[agent-stream] ← <phase>`、壞幀 warn、串流結束摘要。
- 雙端對照即可定位幀丟在哪一段。

### 教訓
1. 「toast 成功但畫面沒變、console 乾淨」= 有人在靜默吞錯誤,先把錯誤路徑吵起來。
2. Fastify 的 `400 Client Error` 不是 route 問題,是 socket 解析層——先查
   `clientErrorHandler` 的 `HPE_*` 碼,不要在 route 邏輯裡打轉。
3. 代理鏈上的 `Connection` 頭要前後一致;SSE/hijack 回應在有 proxy 的環境下
   用 `close` 最安全。
