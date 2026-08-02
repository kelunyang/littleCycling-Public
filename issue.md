# 踩雷紀錄

已解決但值得記住的坑。新增條目往上疊(最新在前)。

---

## 2026-07-24 ~ 26:3D 地圖大掃除 —— 黑線、穿山、穿房子

三個症狀、三個根因,但同一個教訓:**每一次都是「量錯了東西」,所以每一次量測
都回報乾淨,而畫面上錯得很明顯。**追了大約十五輪,五個嫌疑犯(道路第一版、
深度精度、地形側牆/裙邊、遠山剪影環、雲影)被 bisect 一一清掉才收斂。

---

### 一、黑線:緞帶把第一個取樣點縫到頂點 `-1` / `-2`

**症狀**
近山區域(大直)天上出現一堆「從山裡飛出來」的黑線。修過一輪後不再飛天,
但變成一堆黑色碎塊躺在坡上;而且**河濱公園那種平地也有**。

**根因**
`ribbon-geometry.ts` `assembleStrip` 的縫合條件是:

```ts
let prevKeptSample = -1;                    // 「還沒有前一個點」的哨兵
...
if (prevKeptSample === i - 1 && ...) { indices.push(a, b, c, b, d, c); }
```

`i = 0` 時 `-1 === -1` **成立**,於是 `a = vi - 2 = -2`、`b = -1`。

而 `THREE.BufferGeometry.setIndex()` 拿到普通 number 陣列時,會檢查「有沒有值
達到 65535」來決定用 Uint16 還是 Uint32 —— **負數當然沒達到**,所以選 Uint16,
`-2 / -1` 被存成 **65534 / 65535**,遠超出只有幾千個頂點的緩衝區。WebGL 於是
拿未定義的記憶體畫出兩個三角形。**每條道路、水道、跑道各一組。**

**為什麼躲了一整天 —— 兩個獨立的遮蔽**

1. **無頭探針的光柵器會靜靜丟掉這些三角形。** 投影出 NaN 後 bbox 掃描的像素
   迴圈直接不進去,所以渲染出來的 PNG 永遠乾淨 —— 只有瀏覽器會畫它們。
   *視覺 bug 在探針裡重現不出來時,不要繼續渲染,改去稽核 buffer。*
2. **`MAX_RIBBON_JUMP_M = 15` 恰好擋掉一部分。** 首點離 `y = 0` 超過 15 m 的
   會被拒絕縫合,所以山上(起點高)比河濱(貼著 0)少 —— 「山上改善了、河濱
   一堆」看起來像兩個 bug,其實是同一個 bug 被一個無關的常數部分遮住。

**怎麼抓到的**
`ROADAUDIT=runs`(`scripts/headless-check/render-probe.ts`)直接走 index buffer:

```
idx[0]=65534 but pos.count=6844
三個 chunk 共 153 個越界四邊形 → 修完 0
```

**修法**
`NO_PREV_SAMPLE = -2` 取代 `-1`,`assembleStrip` 與 `buildRibbonRails` **兩份都要改**。
`check:3d` 加了會真的紅的斷言「no index reaches past the ribbon's own vertex buffer」。

**順手**:`MIN_RIBBON_RUN_M = 15` —— `ground()` 每拒絕一個取樣點緞帶就斷一次,
剩兩三格的殘骸是躺在坡上的黑色紙屑。量到 35 段短於 15 m,合計約 300 m / 39 km
(0.8%)。**刻意不做**「掉太多樣本就整條放棄」:河濱那個 chunk 拒絕 48% 的
取樣點,卻有 95% 的長度落在 100 m 以上的長段,按比例砍會刪掉整片路網卻修不到
任何東西。

---

### 二、穿山:高度查詢跟畫出來的 mesh 不是同一件事

**症狀**
明明畫了地形裙邊,單車還是會衝進山裡;裙邊「裡面」甚至有道路和路燈。

**根因**
`sampleChunkHeight` 用「投影到兩個 section 中心之間的線段」找格子,而 section
中心相隔約 25 m、橫向容許到走廊半寬 500 m。**只要路線轉彎比半寬還急(也就是
每一個街角),垂直切片就會交叉、走廊自己疊到自己身上**,投影因此指到幾百公尺
外的格子。

拿它跟真正畫出來的 mesh 對照(往下 raycast):平地直線 chunk 只有 **66%** 一致,
兩個山區 chunk 是 **29%** 和 **8.5%**。也就是說在山裡,高度查詢有九成是錯的 ——
而所有東西都靠它:道路、路線標線、路燈、金幣,以及**騎士自己的海拔**。

**修法**
`terrain-chunk.ts` 直接對格子四邊形建 CSR 空間索引(`buildCellIndex` /
`sampleByCellIndex`),精確回答「哪一格蓋住這個點」。

**附帶陷阱**
`sampleChunkHeight(..., Number.POSITIVE_INFINITY)` **不會**回傳最大值 ——
`Math.abs(h - Infinity)` 對每個候選都是 `Infinity`,所以它回傳第一個。想要最高
的那一層要用 `maxChunkHeight()`。這個誤解一度讓「被埋住」檢查和我自己的稽核
同時失效。

---

### 三、道路政策:白名單,不是黑名單

**症狀**
山裡畫出根本不存在的一堆路;捷運高架被當成馬路貼在地上。

**根因**
原本把整個 `transportation` 圖層都當路,而兩邊算繪器的顏色/寬度查表對認不得的
class 都**退回成一條灰色馬路** —— 於是沒人想過的 class 全被漆成柏油。

大直山區實測:`path` / `track` 佔該圖層 **42%**,一個 1 km 方框裡就有 135 條
登山步道。

**修法**
`road-classes.ts` 成為**兩個算繪器共用**的政策來源(刻意不 import THREE/Phaser,
因為 `mvt-projection` 跑在 Web Worker 裡)。白名單只有
`motorway / trunk / primary / secondary / tertiary / minor`。

隧道排除(隧道在山**裡**,貼在山**上**等於把路畫過山脊),3D 端在洞口放
portal 標記。**差點踩到的回歸**:把隧道排除在 `'road'` 之外,會連帶讓 2D 的
隧道區域偵測失效 —— 所以 2D 那邊給了獨立的 `'tunnel'` type,不再靠 `'road'` 承載。

---

### 四、房子讓開騎乘路線

**根因(三件事疊加)**
OpenMapTiles 在 z14 會**合併相鄰建物**(密集台北圖磚 95% 是 MultiPolygon,一個
合併街廓會把裡面的巷子一起吞掉)、GPX 本身飄幾公尺、火柴盒的 body 是 OBB 不是
輪廓(斜的 footprint 盒子會溢出自己的牆)。

實測 12,485 個 footprint:中心線直接穿過 **37** 個,4 m 內共 **95** 個(0.76%)。
但實際需要處理的**盒子**有 **102** 個 —— 差額就是 OBB 溢出輪廓的那些,**只查
資料永遠看不到**。

**修法**
把盒子往路外拉(沿被侵入那一面縮短該軸、對面留原地),收斂不了才丟。刪掉一個
4610 m² 的合併街廓只為修 2 m 重疊,會留下 70 m 的洞。

**兩個非直覺的發現**
1. **面取樣要算 Lipschitz 誤差**。距離對折線是 1-Lipschitz,兩個取樣點之間真值
   可以再低 `step/2`。用 4 m 間距要求 4 m 淨空,實測只有 **2.20 m** —— 剛好半格。
2. **真兇是塑膠積木自己**。`buildBuildingBody` 會把中間層積木抽出一截當屋簷,
   刻意跳過一樓 —— 但矮房子 round 成 3 層、每層 1.8 m,所謂「中間層」就在膝蓋
   高度。**「樓層」不等於「高度」,要用公尺判斷。**

---

### 五、`check:3d` 一個 throw 就整套停 —— 「130 過」是假的

route line 為了除錯面板分層改名成 `route/core`,`diorama.ts` 還在
`getObjectByName('core')`,拿到 undefined 就 throw,**整套測試從那裡停住**。

那句「130 過、1 個既有的紅」被當基準線引用了很多輪,聽起來無害,實際上藏著
**三分之一的測試**。後面三個區塊因此長草很久:

- `buildGroundRibbon` 少了早已移除的 `fallback` 參數
- waterway / aeroway 測試沒傳 `ground`,吃到預設的 `() => null`(**什麼都不畫**)

**修法**
每個區塊獨立 `try/catch`,crash 記成 failure 而不是 exit。修好過期呼叫後:
**202 過、0 紅 —— 先前有 70 個斷言從來沒執行過。**

*看 ✓ 的數量,不要只看 ✗ 的行數。*

---

### 附:量過但別再試的死路

**走廊格子歸屬制**(讓每一格只屬於一個 chunk,想解決走廊自我重疊):
地形覆蓋率從 **38.1% 掉到 18.1%**,直接砍掉一半地形。已還原,別再試。

---

### 教訓

1. **視覺 bug 在無頭探針裡重現不出來 ≠ 沒有 bug。** CPU 光柵器會丟掉退化三角形,
   WebGL 不會。這種時候要去稽核 buffer,不是繼續渲染 PNG。
2. **量測若一直「乾淨」而畫面一直錯,是量錯了東西。** 頂點稽核對「頂點之間」
   的錯誤天生失明;高度查詢的稽核不能拿高度查詢當基準,要拿畫出來的 mesh。
3. **不要用會跟真實資料撞號的哨兵值。** `-1` 撞 `i - 1`,而 `setIndex()` 的
   Uint16 判斷只看「有沒有 ≥ 65535」,負數一路無聲通過。
4. **回歸測試要實測會紅。** 這次兩個新斷言都還原過 bug 確認會失敗才留下。
5. **改了物件名稱,記得測試也在讀它。**
6. **探針裡有一份 `makeGroundFn` 的鏡像副本**(`render-probe.ts` 有大寫警告)。
   它漂移過不只一次,每次漂移探針就會把「修好了」回報給一個遊戲從沒見過的版本。
   改 groundFn 要同一個 commit 改兩邊。

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
