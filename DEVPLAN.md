# littleCycling 開發計畫

一個類 Zwift 的個人自行車小遊戲，紅色球球以 FPS 視角在真實 3D 地圖上沿 GPX 路線滾動，速度由感測器驅動。

## 架構概覽

**Monorepo 結構：**
```
littleCycling/
├── packages/
│   ├── server/          — Node.js 後端（ANT+/BLE、WebSocket、Replay、SQLite）
│   │   └── src/
│   │       ├── recorder.ts
│   │       ├── replay.ts
│   │       ├── cli.tsx          — Ink 終端 UI
│   │       ├── lib/             — ant-connection, ble-connection, sensor-manager, data-writer
│   │       └── ui/              — Ink components
│   ├── web/             — Vue 3 前端（3D 遊戲）
│   │   └── src/
│   │       ├── stores/          — Pinia stores
│   │       ├── components/      — Vue components
│   │       ├── composables/     — WebSocket、virtual power 等
│   │       └── game/            — Three.js 球球、金幣、地圖邏輯
│   └── shared/          — 前後端共用模組（硬體改動只改這裡）
│       └── src/
│           ├── types.ts         — sensor data types, WebSocket message types
│           ├── power-curves.ts  — 訓練台功率對照表 + 線性插值
│           ├── sensor-parser.ts — 感測器原始資料解析（SC→速度/踏頻、HR→心率、PWR→功率）
│           ├── virtual-power.ts — 輪速→虛擬功率估算
│           ├── gpx-parser.ts    — GPX/TCX 解析 → {lat, lon, ele}[]
│           ├── hr-zones.ts      — 心率區間判定 + 金幣規則
│           └── constants.ts     — 輪周長、預設值等
├── data/                — JSONL 錄製檔、SQLite DB、路線、config
│   ├── config.json      — 系統參數持久化（使用者可在設定頁修改）
│   └── routes/          — 匯入的路線（SavedRoute JSON 檔案）
├── package.json         — workspace root
└── DEVPLAN.md
```

**資料流：**
```
┌─────────────────────┐     WebSocket      ┌──────────────────────────────────────┐
│  packages/server     │ ────────────────▶ │  packages/web                         │
│                      │                    │                                      │
│  ANT+ Stick ─▶       │                    │  MapLibre GL JS: 3D 地圖 + 地形      │
│  BLE ─▶              │                    │  Three.js: 紅色球球 (custom layer)    │
│  Sensor Reader       │                    │  Pinia: 狀態管理                      │
│  JSONL Writer        │                    │  OSD: DOOM 風格 HUD (Font Awesome)   │
│  SQLite              │                    │  Canvas/SVG: 即時數據圖表             │
└─────────────────────┘                    └──────────────────────────────────────┘
         ↕
   packages/shared (共用型別 + 感測器解析 + 功率曲線 + GPX parser)
```

## 硬體

- **ANT+ Stick**: Garmin ANT+ Stick 2 (VID:0FCF, PID:1008)
- **驅動**: libusb0 (libusb-win32)
- **感測器**: ANT+ 速度/踏頻 + BLE 心率帶
- **執行環境**: Windows 11, Windows Terminal

---

## 開發階段

### Phase 1: ANT+ 記錄器 ✅ 已完成

用 Node.js CLI 錄製 ANT+/BLE 感測器資料到 JSONL 檔案。

**已建立的檔案：**
- `src/recorder.ts` — 錄製主程式（含 --verify-only 模式）
- `src/lib/ant-connection.ts` — USB stick 連線管理
- `src/lib/ble-connection.ts` — BLE 心率連線
- `src/lib/sensor-manager.ts` — 感測器掃描與資料轉發
- `src/lib/data-writer.ts` — JSONL 檔案寫入

**使用方式：**
```bash
# 在 Windows PowerShell 上執行（不是 WSL）
npm install
npx tsx src/recorder.ts --verify-only     # 驗證連線
npx tsx src/recorder.ts                    # 開始錄製
npx tsx src/recorder.ts -o my-ride.jsonl   # 指定輸出檔
```

---

### Phase 2: Replay Server ✅ 已完成

WebSocket server，讀取錄好的 JSONL 檔案，按原始時序回放資料。
讓前端開發不需要實體感測器。

**已建立的檔案：**
- `packages/server/src/lib/data-reader.ts` — async generator 逐行讀取 JSONL
- `packages/server/src/replay.tsx` — WebSocket server + Ink 終端 UI
  - 根據 `elapsed` 欄位差值控制發送間隔
  - `--speed <multiplier>` 倍速播放
  - `--loop` 循環播放
  - 每個 WebSocket client 獨立 replay 串流

**CLI：**
```bash
npx tsx src/replay.tsx recordings/my-ride.jsonl
npx tsx src/replay.tsx recordings/my-ride.jsonl --speed 2.0 --loop --port 8765
```

> ⚠️ **注意（server-authoritative 遷移後）：** 這條舊路徑（`replay.tsx` 與
> server 的 `/ws/replay` 端點，兩者都用 `ReplaySession`）只把**原始 `sensor`
> 影格**直接串給前端,**不經過 `LiveSession`、不產生 `game_state`**。遷移後
> 前端的遊戲世界靠伺服器算出的 `game_state` 驅動,所以用這條路徑播放時 HUD
> 數值會動,但紅球/地形/金幣不會動。要用真實紀錄驅動**完整遊戲**,請改用下方
> 的 `--replay` 感測來源。

#### 用真實紀錄驅動遊戲模擬（`--replay` 感測來源）

把錄製檔的感測影格照原始時序餵進 `LiveSession.handleAntData()`,走與真實
ANT+ 及 `--mock` **完全相同**的路徑,因此伺服器會算出 `game_state`、金幣、
心率區間、虛擬速度與 SQLite 樣本,重現整趟騎乘 —— 只是感測位元組來自檔案。
這是拿真實資料做端到端測試的正確方式。

**已建立的檔案：**
- `packages/server/src/lib/replay-sensor.ts` — `ReplaySensorSource`
  - 從錄製檔的 `session_start` 讀出真實感測器清單來 advertise（無 header 時
    以前 500 筆 data 的 profile+deviceId 推導）
  - 按 `elapsed` 差值原速播放,支援 `speed` 與 `loop`
  - 透過 `onFrame` 回呼接進 `LiveSession`,與 `MockSensorSource` 對稱

**Server flag（`server.ts`）：**
```bash
# 檔名依序在 <data-dir>/sessions、<data-dir>、cwd、絕對路徑尋找
npx tsx src/server.ts --data-dir ../../data \
  --replay ride-7-2026-07-10T07-28-59.jsonl --replay-loop
#   [--replay-speed N]  倍速   [--replay-loop]  播完自動重頭
```

`--replay` 優先於 `--mock`。前端照常連 `/ws/live`(dev 下 `vite` 預設把
`/api`、`/ws` 代理到 8765),整套遊戲即以真實紀錄重跑一遍。

---

### Phase 3: Ink 終端儀表板 ✅ 已完成

用 Ink (React for CLI) 的漂亮終端 UI 錄製介面。

**已建立的檔案：**
- `src/cli.tsx` — Ink app 入口
- `src/ui/Dashboard.tsx` — 主儀表板佈局
- `src/ui/SensorCard.tsx` — 感測器數值卡片（HR zone 變色）
- `src/ui/StatusBar.tsx` — 錄製時間、筆數、狀態
- `src/ui/ScanView.tsx` — 掃描等待畫面
- `src/ui/Header.tsx` — 標題
- `src/ui/ProgressBar.tsx` — 進度條
- `src/ui/DurationInput.tsx` — 時間輸入
- `src/ui/SensorLog.tsx` — 感測器日誌

---

### Phase 4: 前端遊戲 — Vue 3 + MapLibre + Three.js ✅ 已完成

紅色球球在真實 3D 地圖上沿 GPX 路線滾動，DOOM 風格 HUD 顯示即時資料。

#### 技術棧

- **Vue 3** + Composition API + Vite + **Pinia**
- **Element Plus** — 暗色主題 UI 框架（Welcome 頁面表單元件）
- **MapLibre GL JS** — 3D 地圖渲染（開源免費，無 API key）
- **Three.js** — 球球渲染（MapLibre custom layer）
- **Font Awesome** — 所有 UI 圖示（不使用 emoji）
- **Canvas/SVG** — 即時數據圖表

#### Pinia Stores

| Store | 職責 | 寫入者 | 讀取者 |
|-------|------|--------|--------|
| `sensorStore` | HR、speed、cadence、power 即時數值 | WebSocket | HUD、球球、金幣系統 |
| `gameStore` | 遊戲狀態（welcome/playing/ended）、時間倒數、圈數、金幣、combo | 遊戲邏輯 | HUD、摘要頁 |
| `routeStore` | GPX 路線點、球球位置 index、總距離 | GPX parser、球球引擎 | 地圖、minimap |
| `settingsStore` | 訓練時長、FTP 值、訓練台型號、自由漫遊開關 | 歡迎畫面 | 各處 |
| `comparisonStore` | 歷史騎乘對比選擇 | RideHistory | HUD chart |
| `catalogStore` | EuroVelo 路線目錄管理 + 下載狀態 | CatalogTab | RouteList |

#### 地圖資料來源（全部免費，無 API key）

| 資料 | 來源 | 說明 |
|------|------|------|
| 向量地圖 + 3D 建築 | OpenFreeMap | OSM 資料，fill-extrusion 渲染 3D 建築 |
| 3D 地形高程 | AWS Terrain Tiles | Terrarium PNG 編碼，30m 解析度 |
| 路線 | 使用者上傳 GPX/TCX/FIT | Garmin 碼表匯出或 EuroVelo 路線（ODbL 授權）|

#### 球球驅動邏輯

**速度（前進）：**
```
感測器優先級：
  1. 功率計（PWR profile）→ 直接使用瓦數
  2. 無功率計 → 輪速查表估算虛擬功率

Generic Fluid Trainer 功率對照表：
  速度(km/h): [0,  5,  10, 15, 20,  25,  30,  35,  40,  45,  50,  55,  60]
  功率(W):    [0, 25,  50, 85, 110, 160, 220, 300, 410, 550, 700, 890, 1100]

  使用線性插值，未來可擴充訓練台型號特定曲線。
```

**轉向（雙邊功率計）：**
```
偵測到雙邊功率計（左右腳分別回報）→ 啟用自由漫遊模式：
  左腳功率 > 右腳功率 → 球往左偏
  右腳功率 > 左腳功率 → 球往右偏
  左右平衡 → 直行
  偏轉角度 = f(左右功率差比例)

無雙邊功率計 → 軌道模式：球鎖定沿 GPX 路線行進
```

**兩種行進模式：**

| | 軌道模式（預設） | 自由漫遊模式 |
|---|---|---|
| 路線 | 球鎖定在 GPX 軌跡上 | 球可自由偏離路線 |
| GPX 黃線 | 是軌道 | 是建議路線（可離開） |
| 地圖 | 完整 3D 地圖 + 建築 | 完整 3D 地圖 + 建築 |

歡迎畫面偵測到雙邊功率計時，顯示 el-switch 讓使用者選擇是否開啟自由漫遊。
未偵測到雙邊功率計 → 開關不顯示，固定為軌道模式。

**視角偏航（Camera Yaw）：**

自由漫遊模式下球體偏轉時，相機視角也會同步左右旋轉，增強沉浸感。
此外，玩家可隨時用左右方向鍵手動旋轉視角（不限於自由漫遊模式）。

- 功率偏航：`steeringAngle * YAW_SCALE(0.5)` 疊加到相機 bearing
- 手動偏航：ArrowLeft / ArrowRight，每次 ±3°，範圍 ±45°
- 兩種來源疊加：`effectiveBearing = pos.bearing + manualYaw + steeringAngle * 0.5`
- 適用於 MapLibre 與 Three.js 兩種渲染模式

#### 遊戲流程

```
歡迎畫面                         遊戲畫面 (DOOM 風格 HUD)
┌────────────────────────────┐   ┌─────────────────────────────────────┐
│                            │   │  ♥ 126 bpm  ⚡ 23.5 km/h  ⟳ 85 rpm │ ← 頂部數值
│    🚴 littleCycling         │   │  🪙 x42  combo x3                   │ ← 金幣/combo
│                            │   │                                     │
│  ── 路線 ──                │   │                                     │
│  ▸ 環法 Stage 1  42km ▲320m│   │        3D 地圖 + 球球（全螢幕）      │
│    環法 Stage 2  65km ▲890m│   │        (MapLibre + Three.js)         │
│  [+ 上傳 GPX/TCX]          │   │                                     │
│                            │   │                                     │
│  ✅ 3D 地圖 API 連線       │   ├──────────────────┬──────────────────┤
│  ✅ 感測器已連線            │   │  ██████░░░░ 62%  │     ┌──┐ [⏹]    │ ← 底部
│  [⚙] 設定  [ ] FTP 模式   │   │                  │     │  │        │
│                            │   │  18:36 / 30:00   │     │·→│ 結束   │
│     [開始騎乘]              │   │  🔄 Lap 3        │     └──┘         │
└────────────────────────────┘   └──────────────────┴──────────────────┘
                                  進度條 + 圈數        minimap  結束按鈕
```

**歡迎畫面 Checklist（全部 ✅ 才能開始）：**
1. 選擇路線（從已儲存路線列表選擇，或上傳新 GPX/TCX）
2. 設定訓練時長（分鐘）→ 底部進度條為時間倒數
3. 3D 地圖 API 連通 → ping OpenFreeMap + AWS Terrain Tiles
4. 感測器連線 → WebSocket 連到 recorder / replay server

**可選設定：**
- FTP 訓練模式（設定 FTP 瓦數，進入結構化訓練）
- 訓練台型號（選擇功率曲線，預設 generic fluid）

#### 路線管理

使用者上傳的 GPX/TCX/FIT 不是用完即丟，而是儲存為系統內的「路線」。

**支援格式：**
| 格式 | 類型 | 說明 |
|------|------|------|
| GPX | XML text | GPS Exchange Format，最通用的路線格式 |
| TCX | XML text | Garmin Training Center XML，含訓練資料 |
| FIT | binary | Garmin Flexible and Interoperable Data Transfer，車錶原生格式（Garmin / Bryton / Wahoo） |

**FIT 匯入注意事項：**
- FIT 是二進制格式，不能用 DOMParser，需要專用 parser library（如 `@garmin/fitsdk` 或 `fit-file-parser`）
- FIT activity 檔包含 GPS trackpoints（`record` messages 裡的 `position_lat` / `position_long`）+ 感測器資料
- 只需提取 lat/lon/ele 建立 `RoutePoint[]`，其餘感測器資料忽略（路線匯入只要座標）
- **無 GPS 的 FIT 檔直接拒絕**：解析後若 `record` messages 不含 `position_lat` / `position_long`（例如室內訓練台錄製的純感測器資料），回傳錯誤告知使用者「此 FIT 檔案不含路線資訊，無法匯入」
- 前端上傳時需以 `ArrayBuffer`（非 text）傳送，後端以 binary 解析

**流程：**
1. 使用者在歡迎畫面上傳 GPX/TCX/FIT 檔案
2. 後端解析（GPX/TCX 用 DOMParser，FIT 用 FIT parser）→ 建立 `SavedRoute`
3. 透過 Server API 持久化到 `data/routes/` 目錄（JSON 格式）
4. 歡迎畫面顯示已儲存的路線列表，使用者點選即可開始
5. 路線可刪除、可重新命名

**儲存位置：** `data/routes/<id>.json`

**SavedRoute 結構：**
```typescript
interface SavedRoute {
  id: string;           // slugified filename + timestamp
  name: string;         // 顯示名稱（可編輯）
  fileName: string;     // 原始上傳檔名
  points: RoutePoint[]; // {lat, lon, ele}[]
  distanceM: number;    // 總距離（公尺）
  elevGainM: number;    // 總爬升（公尺）
  createdAt: number;    // 匯入時間 (tsEpoch ms)
}
```

**歡迎畫面路線選擇（兩個 tab）：**

```
┌── 我的路線 ──┬── EuroVelo ──┐
│              │              │
│ ▸ 自家練習   │ EV15 Rhine   │
│   12km ▲80m │  ▸ S1 Basel  │
│   週末山路   │    S2 Mainz  │
│   35km ▲420m│ EV6 Atlantic │
│              │  ...         │
│ [+ 上傳]     │              │
└──────────────┴──────────────┘
```

- **我的路線 tab**：已儲存的路線卡片（名稱、距離 km、爬升 m、匯入日期）+ 上傳按鈕
- **EuroVelo tab**：從 EuroVelo 動態爬取的歐洲自行車路線目錄（ODbL 授權）
  - 17 條 EuroVelo 路線（EV1-EV19），每條有多個分段
  - 未下載的 stage 顯示「下載」按鈕
  - 點「下載」→ server 從 EuroVelo 抓 GPX → 解析 → 存到 `data/routes/` → 自動出現在「我的路線」
  - 已下載的 stage 直接可選
- 選中的路線高亮，點「開始騎乘」進入遊戲

#### 路線匯入方式

**方式一：EuroVelo 路線目錄（新手友善）**

Server 動態爬取 EuroVelo（eurovelo.com，ODbL 授權）的歐洲長途自行車路線。
GPX 下載：`https://en.eurovelo.com/route/get-gpx/{gpxId}`，不需 API key。

**API：**

| 端點 | 說明 |
|------|------|
| `GET /api/catalog` | Server 爬取 EuroVelo 路線頁面 → 解析分段 GPX ID → 回傳 `RouteCatalog` |
| `POST /api/catalog/download` | `{ raceId, stage }` → Server fetch GPX → 解析 → 存 `data/routes/` → 回傳 `SavedRoute` |

**Server 端實作：**
1. `GET /api/catalog`：爬取 17 條 EuroVelo 路線頁面，解析各分段頁面取得 gpxId
2. 結果 cache 在記憶體（24 小時 TTL），避免頻繁請求
3. 回傳 `RouteCatalog`（型別定義在 shared/types.ts）+ 已下載 stage ID 列表

**Stage 下載流程：**
1. 前端點「下載」→ `POST /api/catalog/download` `{ raceId, stage }`
2. Server fetch `/route/get-gpx/{gpxId}` → `parseRouteFile()` → 建立 `SavedRoute` → 存 `data/routes/`
3. 回傳 `SavedRoute`（不含 points，節省傳輸）
4. 前端更新路線列表，下載過的 stage 直接可選

**Attribution / ODbL 合規：** EuroVelo GPX 於 2024-10-09 正式以 **ODbL v1.0** 開放資料釋出。
- 使用官方要求的署名原句:「*Contains information from EuroVelo GPX tracks downloaded from www.EuroVelo.com on (DATE), which is made available under the Open Database License (ODbL).*」CatalogDrawer 顯示此署名並附 ODbL 授權連結 + 官方 License & Disclaimer 文件連結。
- **匯出的分段 GPX 會嵌入 `<metadata>`**(`copyright author="EuroVelo"` + ODbL license URL + 下載日期 + 來源 link),讓署名/授權通知隨檔案留存(ODbL「keep the notice intact」)。
- 我們**不在 repo 內散布** EuroVelo 資料(GPX 快取於 gitignore 的 `data/eurovelo-cache/`,由各使用者的 server 自行向官網下載),故 Share-Alike 不觸發;EuroVelo 資料(ODbL)與專案程式碼(CC-BY-SA)授權分離。

**方式二：Auto-import（進階使用者）**

使用者可直接將 GPX/TCX/FIT 檔案放入 `data/routes/` 目錄，Server 啟動時自動掃描、驗證、匯入。

**流程：**
1. Server 啟動時，`RouteStore.autoImport()` 掃描 `data/routes/` 中的 `.gpx`/`.tcx`/`.fit` 檔案
2. 逐一解析：GPX/TCX 用 `parseRouteFile()`，FIT 用 `parseFitRoute()`
3. 驗證通過（至少有 1 個路線點）→ 建立 `SavedRoute` JSON → 原始檔案移至 `data/routes/imported/`
4. 驗證失敗或解析錯誤 → 跳過並 log 警告，不中斷其他匯入

**實作檔案：** `packages/server/src/lib/route-store.ts` — `autoImport()` 方法

---

#### 設定頁面（齒輪 icon → 側邊面板）

歡迎畫面的齒輪按鈕開啟設定面板，修改後自動寫回 `data/config.json`。

**`data/config.json` 預設值：**
```json
{
  "sensor": {
    "wheelCircumference": 2.105,
    "trainerModel": "generic-fluid"
  },
  "training": {
    "defaultDuration": 1800000,
    "hrMax": 190,
    "ftp": 200
  },
  "server": {
    "wsPort": 8765
  }
}
```

**設定項目：**
| 分類 | 欄位 | 說明 |
|------|------|------|
| 感測器 | 輪周長 (mm) | 依輪胎規格，預設 2105mm (700x23c) |
| 感測器 | 訓練台型號 | 下拉選單，影響功率曲線 |
| 訓練 | 預設訓練時長 | 分鐘，預設 30 分鐘 |
| 訓練 | HRmax | 最大心率，影響心率 zone 計算 |
| 訓練 | FTP | 功能閾值功率（瓦） |
| 伺服器 | WebSocket port | 預設 8765 |

#### 金幣獎勵系統 — 心率區間測速

根據心率區間（%HRmax）獎勵金幣，鼓勵穩定控制強度而非盲目衝刺：

```
Zone 1 (50-60% HRmax): 恢復區 — 不給幣（休息段）
Zone 2 (60-70%):       燃脂區 — 🪙 x1 / 每 N 秒
Zone 3 (70-80%):       有氧區 — 🪙 x2 / 每 N 秒
Zone 4 (80-90%):       乳酸閾 — 🪙 x3 / 每 N 秒（超時扣幣）
Zone 5 (90%+):         紅線區 — ⚠️ 警告，不給幣
```

**機制：**
- 金幣出現在路線上，球球碰到就吃掉
- 連續維持目標 zone → combo 倍率遞增
- 心率飆進 Zone 5 → 球球變暗 + 警告
- 訓練模式下系統指定目標 zone，維持住大量噴幣

#### 訓練模式

- 開始時可勾選 FTP 訓練模式
- 路線上設定 checkpoint，到達時觸發任務
  - 例：「30 秒內踏頻達到 90 RPM」
  - 未達成 → 球球停止
  - 達成 → 繼續滾動 + 獎勵金幣
- 訓練結束顯示摘要（總金幣、平均功率、心率分佈等）

#### 開發步驟

**Step 1 — 基礎建設 ✅**
- Vue 3 + Vite 專案初始化（`web/` 子目錄）
- GPX/TCX parser：解析路線 → `{lat, lon, ele}[]`
- Virtual power 模組：輪速 → 瓦數（generic fluid curve + 線性插值）

**Step 2 — 3D 地圖 + 路線渲染 ✅**
- MapLibre GL JS 整合 OpenFreeMap 向量 tiles
- AWS Terrain Tiles 啟用 3D 地形
- 3D 建築物（fill-extrusion layer）
- GPX 路線渲染為黃色 3D 線條，貼在地形上

**Step 3 — 球球 + FPS 鏡頭 ✅**
- Three.js custom layer：紅色球球
- 球球沿路線移動，速度由虛擬功率驅動
- FPS 鏡頭跟在球球後方

**Step 4 — OSD HUD ✅**
- DOOM 風格半透明 HUD 疊在 3D 地圖上
- 頂部：HR / Speed / Cadence 即時數值
- 底部左：訓練時間倒數進度條（已騎時間 / 設定時長）+ 目前圈數
- 底部右：minimap（2D 俯瞰路線 + 球球位置標記）+ 結束按鈕

**繞圈機制：** 球球到達 GPX 路線終點 → 自動回到起點繼續下一圈。
**結束條件：** 訓練時間到 或 使用者按結束按鈕 → 顯示訓練摘要。

**Step 5 — 金幣系統 ✅**
- 心率區間判定
- 金幣生成與碰撞
- combo 機制
- OSD 金幣計數器

**Step 6 — 歡迎畫面 + 訓練模式 ✅**
- GPX/TCX 上傳 + 解析
- 連線狀態檢測
- FTP 訓練模式設定
- checkpoint 任務系統

**Step 7 — WebSocket 資料串接 ✅**
- 連接 recorder 即時模式 或 replay server
- 感測器資料 → 虛擬功率 → 球球速度
- 支援 PWR profile 直接使用功率計瓦數

---

### Phase 4.5: Three.js 獨立地形渲染系統 ✅ 已完成

MapLibre GL JS 的 pitch 上限為 85°，對 FPS 騎車遊戲來說視角太鳥瞰。改用獨立 Three.js 渲染器，無視角限制。

**架構：獨立 Three.js 主畫面 + OpenFreeMap MVT 向量圖磚 3D 建模**
- Three.js 自建 `WebGLRenderer` + `PerspectiveCamera`（無 pitch 限制）
- DEM 高程來自 AWS Terrain Tiles（Terrarium PNG）
- 道路、建築、水體、土地利用從 OpenFreeMap MVT（zoom 14）解碼後直接建 3D mesh
- **完全取代** raster 衛星圖磚貼圖，改用程序化 vertex color + `MeshToonMaterial`

**核心美術風格：塑膠玩具 × 塗鴉噴漆**
- 所有物件使用 `MeshToonMaterial` + 4px gradient map，產生離散色階塑膠光澤
- 配色為螢光噴漆風格：高對比、大膽、街頭藝術感
- 建模簡潔幾何，不追求擬真 — 建築是彩色方塊，道路是平滑帶狀，水面有果凍動態
- 地形用 Perlin noise 產生 patch 色彩變化，避免單色枯燥
- 光照即使夜間也維持足夠亮度，讓塑膠色彩可辨識

**檔案：**

| 檔案 | 說明 |
|------|------|
| `game/terrain/elevation-sampler.ts` | AWS Terrarium PNG tile 解碼，RGB→高程，tile 快取，`<img>`+`<canvas>` 避 CORS |
| `game/terrain/terrain-chunk.ts` | 走廊型地形（1km 寬 × 2km 長，21 cross-sections），BufferGeometry + DEM 高程 |
| `game/terrain/terrain-chunk-manager.ts` | 分段載入（3-5 chunks）、繞圈賽快取、`onChunkLoaded` callback、raycast 地面查詢 |
| `game/terrain/mvt-fetcher.ts` | OpenFreeMap MVT tile fetch + `@mapbox/vector-tile` + `pbf` 解碼，tile 快取 |
| `game/terrain/mvt-types.d.ts` | `@mapbox/vector-tile` 的 TypeScript 類型宣告 |
| `game/terrain/cartoon-materials.ts` | 共用 toon 材質註冊表：4px gradient map、螢光噴漆色板、Perlin noise 地形配色 |
| `game/terrain/road-renderer.ts` | MVT `transportation` 圖層 → 帶狀 triangle strip 3D 道路，寬度依等級 |
| `game/terrain/building-renderer.ts` | MVT `building` 圖層 → ExtrudeGeometry 擠出彩色建築，座標 hash 選色 |
| `game/terrain/landuse-renderer.ts` | MVT `water`/`landcover`/`park`/`landuse` → 五類平面 mesh（水體/公園/林地/沙地/都市）疊在地形上 |
| `game/terrain/zone-detector.ts` | 區域偵測器：根據 MVT features 判斷騎士位置環境（tunnel/forest/urban/open），用 winding number point-in-polygon |
| `game/terrain/tree-renderer.ts` | 卡通樹木：cone+cylinder InstancedMesh，grid sampling + jitter 散佈在林地 polygon 內，每 chunk 最多 300 棵 |
| `game/terrain/day-night-lighting.ts` | 日夜循環光照參數計算（含夜間最低亮度保證） |
| `game/terrain/game-renderer.ts` | 獨立 WebGLRenderer + 場景 + 三光源 + ACES tone mapping |
| `game/terrain/fps-camera.ts` | 第三人稱俯瞰鏡頭：高度 15m、前看 80m、俯角 30°、quaternion slerp 平滑 |
| `game/terrain/route-line-mesh.ts` | Line2 金色路線（14px 寬），初始平坦 → chunk 載入後 raycast 投影貼地 |
| `game/terrain/sky-and-fog.ts` | 動態天氣（sunny/cloudy/rainy/snowy）+ 日夜循環 + 雨雪粒子，THREE.Sky + 方向光最低仰角 15° 防全黑 |
| `composables/useWeatherApi.ts` | Open-Meteo 即時天氣 API composable，雲量分類 + 15 分鐘 polling |
| `game/terrain/cycling-glasses-effect.ts` | EffectComposer 後處理：鏡片色調、暗角、弧形失真、金幣收集金色光暈、區域照明 tint overlay |
| `composables/useTerrainRenderer.ts` | 管理所有子系統：地形、MVT 建模、光照、玩家光源、區域偵測 + 風鏡照明聯動、區域感知環境粒子 |

**視角設計：**
- 無可見球體（真 FPS 理念，騎士就是鏡頭）
- 鏡頭高度 15m、俯角 30°、前看距離 80m（類似賽車遊戲鳥瞰）
- Smooth 平滑插值（quaternion slerp + position lerp）

**地形系統：**
- 走廊 1km 寬（`corridorHalfWidth = 500m`），21 個 cross-section 取樣點
- 路線切成 ~2km 段，保持 3-5 個 chunk 在場景
- 繞圈賽快取：`Map<chunkIndex, THREE.Mesh>`，離開時 `scene.remove()` 但不銷毀
- 相鄰 chunk 共享邊界頂點（`ChunkEdgeData`），無接縫裂縫
- 浮動原點（floating origin）避免浮點精度問題

**地形材質（卡通塑膠風格）：**
- `MeshToonMaterial({ vertexColors: true, gradientMap })` — 離散色階塑膠光澤
- 高程漸層 vertex color + Perlin noise patch 變化：
  - 草皮：螢光綠 `#39e75f` + 叢林綠 `#1a8f3c` + 酸黃 `#c8e620`
  - 泥土：螢光橘 `#e87d2f` + 深棕 `#8b4513`
  - 岩石：灰 `#8c8c8c` + 塗鴉灰紫 `#6a5acd`
- **不使用** raster 衛星圖磚（省頻寬 + 統一美術風格）

**MVT 3D 建模（OpenFreeMap zoom 14）：**
- **道路**：`transportation` 圖層折線 → 帶狀 triangle strip，寬度依等級（motorway 12m / primary 8m / secondary 6m / minor 4m / path 2m），raycast 投影貼地 + 0.3m z-fighting offset + `polygonOffset`
  - 色彩：瀝青黑 `#2d2d2d` → `#4a4a4a` → `#6b6b6b`
- **建築**：`building` 圖層多邊形 → `ExtrudeGeometry` 擠出，高度取 `render_height` 或預設 8m
  - 色彩：螢光噴漆色板（`#ff3366` 螢光桃 / `#00e5ff` 電光藍 / `#76ff03` 酸綠 / `#ffea00` 螢光黃 / `#d500f9` 螢光紫 / `#ff6d00` 螢光橘），用座標 hash 確定性選色
- **水體**：`water` 圖層 → 平面 mesh + 微透明電光青 `#00bcd4` + 正弦波頂點動畫 + scrolling UV 波紋
- **公園/草地**：`landcover`（class=grass/park）/ `park` → 平面 mesh + 螢光薄荷 `#00e676`
- **林地**：`landcover`（class=wood/forest）→ 平面 mesh + 深墨綠 `#1b5e20` + 卡通樹木（InstancedMesh cone+cylinder，grid 20m + jitter ±5m，每 chunk ≤300 棵）
- **沙地**：`landcover`（class=sand）→ 平面 mesh + 沙棕 `#d2b48c`
- **都市用地**：`landuse`（class=residential/commercial/industrial/retail）→ 平面 mesh + 按 class 著色（住宅灰 `#b0bec5` / 商業黃 `#ffe082` / 工業鋼灰 `#90a4ae`）
- 所有 mesh 使用 `MeshToonMaterial` + 共用 gradient map

**MVT tile URL**: `https://tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf`
**依賴**: `@mapbox/vector-tile` + `pbf`

**路線貼地：**
- 初始渲染為平坦金色線（route-first UX，地形未載完也能看到路線）
- Chunk 載入後觸發 `onChunkLoaded` → `projectRouteLineOntoTerrain()` raycast 投影
- 與騎手同用 `raycastGroundHeight()`，保證視覺一致

**物件高度管理：**
- 騎手（鏡頭）：raycast 對地形 mesh 取地面高度，fallback 為 async DEM 查詢
- 金幣：raycast 取地面高度 + hover offset，有上下浮動動畫
- 路線：chunk 載入後 raycast 投影，`heightOffset = 5m`（高於地面可見）

**光照與日夜循環（卡通夜晚 — 永遠可見）：**
- 三光源：AmbientLight + DirectionalLight + HemisphereLight
- 日夜參數由 `day-night-lighting.ts` 根據太陽/月亮仰角計算
- **卡通夜晚設計**：沒有真正的黑暗，日夜差異僅在色溫（暖白↔冷藍）和微弱亮度差
  - 夜間 ambient 0.85（白天的 ~85-90%），顏色為高亮度低飽和藍 `#b0c0d8`
  - 霧距離接近白天（near 600, far 2600），霧色為亮藍灰 `#8090a8`
  - 背景色接近霧色 `#607888`，避免地平線下出現黑色虛空
  - Exposure 統一 1.3，無亮度波動
- 方向光最低仰角 15°，避免平行光導致地形全黑
- ACES filmic tone mapping
- 玩家光源：SpotLight 頭燈 + SpotLight 地面補光 + PointLight 環境光暈
  - 頭燈瞄準地面 25m 前方（~29° 俯角），錐角 0.8rad、柔化邊緣 0.5
  - 地面補光寬角 1.0rad、短距 60m，照亮腳下 10m 前方路面
  - 日間 headlight 0.3 / groundFill 0.15 / glow 0.1，夜間 1.0 / 0.5 / 0.4
- 地形材質使用 `DoubleSide` 渲染，防止攝影機穿模時背面不可見
- 地面安全平面（Y=-2, 10km×10km），確保 terrain chunk 未載入時不會出現黑色虛空
- **地圖迷霧（Fog of War）**：fogFar 上限為 `CHUNK_LENGTH × CHUNKS_AHEAD`（6000m），確保地形邊緣永遠被霧遮蔽
  - Camera far plane = 8000m（比 fogFar 遠，避免裁切）
  - 天氣可縮短霧距（雨天 ~900m、雪天 ~1050m）

**金幣收集特效：**
- 撞到金幣時畫面邊緣閃現金色光暈（additive glow），約 0.3 秒淡出
- 透過 `CyclingGlassesEffect` shader 的 `uCoinGlow` uniform 控制
- `useCoinSpawner` 的 `onCoinCollected` callback → `terrainRenderer.triggerCoinGlow()`

**天氣系統（即時天氣 API + 雲量分類）：**
- 使用 **Open-Meteo API**（免費、無 API key）取得路線起點的即時天氣
- 天氣分類以**雲量**為主：`cloud_cover < 50%` → sunny、`≥ 50%` → cloudy
- 降水疊加：`precipitation > 0` 且溫度 > 0°C → rainy、≤ 0°C → snowy
- 四種天氣型態：`'sunny' | 'cloudy' | 'rainy' | 'snowy'`
- 遊戲啟動時 fetch 一次，之後每 15 分鐘 polling 更新
- API 失敗時隨機給天氣（增加趣味性）
- `composables/useWeatherApi.ts` — 天氣 API composable
- 雪粒子：2000 粒、3 m/s 落速、0.4 大小、白色 + sin/cos 水平漂移

**效能對比：**
| 項目 | raster 衛星貼圖（舊） | toon + MVT（新） |
|------|----------------------|------------------|
| 頻寬/chunk | ~200KB（9-16 個 zoom-17 圖磚） | ~50KB（1-2 個 zoom-14 MVT） |
| 材質記憶體 | 高（每 chunk 一張貼圖） | 低（共用 toon material + 4px gradient） |
| Draw calls/chunk | 1-2 | 4-5（terrain + road + building + water + landuse） |
| GPU 成本 | texture sampling | 更低（無貼圖取樣） |

**不需修改：** `useBallEngine.ts`、`route-geometry.ts`、`Minimap.vue`

---

### Phase 5: 訓練紀錄 — SQLite ✅ 已完成

用 SQLite 儲存所有訓練歷史，同時作為 Replay Server 的資料來源。

**實作檔案：** `packages/server/src/lib/database.ts`

**資料庫：** `data/littlecycling.db`

**Tables：**

```sql
-- 騎乘紀錄
rides (
  id            INTEGER PRIMARY KEY,
  date          TEXT,           -- ISO 8601
  duration_sec  INTEGER,        -- 總時長（秒）
  distance_m    REAL,           -- 總距離（公尺）
  avg_power_w   REAL,           -- 平均功率
  avg_hr        INTEGER,        -- 平均心率
  avg_cadence   REAL,           -- 平均踏頻
  max_hr        INTEGER,
  max_power_w   REAL,
  total_coins   INTEGER,        -- 金幣總數
  gpx_file      TEXT,           -- GPX/TCX 檔案路徑
  jsonl_file    TEXT,           -- JSONL 錄製檔路徑
  notes         TEXT
)
```

**用途：**
- Replay Server 查 DB → 列出可回放的錄製檔案（不用手動輸入檔名）
- 訓練歷史瀏覽（未來可在前端加歷史頁面）
- 訓練摘要統計（週/月里程、平均功率趨勢等）

---

### Phase 6: 整合 — Live 模式 + 訓練紀錄 + FIT 匯出 ✅ 已完成

Node server 同時做兩件事：
1. 讀 ANT+/BLE 感測器 → 推 WebSocket 給前端
2. 同時錄製到 JSONL 檔案 + 寫入 SQLite

前端可以選擇 Live 模式（直連感測器）或 Replay 模式（從 SQLite 選錄製檔回放）。

**已實作檔案：**

| 檔案 | 說明 |
|------|------|
| `packages/server/src/lib/live-session.ts` | Live 模式管理（感測器 → WebSocket + SQLite） |
| `packages/server/src/lib/fit-exporter.ts` | FIT 二進制格式匯出 |
| `packages/server/src/lib/fit-parser.ts` | FIT 檔案匯入解析 |
| `packages/server/src/routes/live-api.ts` | Live WebSocket API |
| `packages/server/src/routes/ride-api.ts` | 騎乘紀錄 REST API（CRUD + 匯出） |

#### 訓練紀錄存 SQLite

訓練進行中，感測器資料逐筆寫入 SQLite（時間戳、HR、power、cadence、speed）。
訓練結束時計算摘要並寫入 `rides` table（平均功率、平均心率、總距離等）。

**新增 Table：**

```sql
-- 感測器逐筆紀錄（每秒一筆）
ride_samples (
  id         INTEGER PRIMARY KEY,
  ride_id    INTEGER REFERENCES rides(id),
  elapsed_ms INTEGER,        -- 從訓練開始的毫秒數
  hr         INTEGER,        -- 心率 bpm
  power_w    REAL,           -- 功率（瓦）
  cadence    REAL,           -- 踏頻 rpm
  speed_kmh  REAL            -- 速度 km/h
)
```

#### FIT 檔案匯出（上傳 Strava）

使用者可從訓練歷史將任一筆紀錄匯出為標準 **FIT 檔案**（Garmin Flexible and Interoperable Data Transfer），
上傳至 Strava / Garmin Connect / TrainingPeaks / intervals.icu 等平台。

**FIT 格式重點：**
- Garmin 制定的二進制格式，自行車運動業界標準（Garmin / Bryton / Wahoo 車錶原生格式）
- 室內訓練台不含 GPS 座標，只有時間戳 + 感測器數據（HR、power、cadence、speed）
- Strava 接受無 GPS 的 FIT 檔，上傳後顯示為 **Indoor Cycling**（無地圖，有功率/心率圖表）
- 需要 FIT SDK 或第三方 library 產生標準 FIT binary

**匯出流程：**
1. 使用者在訓練歷史頁面選擇一筆紀錄 → 點「匯出 FIT」
2. Server 從 SQLite 讀取 `ride_samples` → 組裝 FIT binary
3. 回傳 `.fit` 檔案供下載
4. 使用者手動上傳至 Strava（或未來串接 Strava API 自動上傳）

**FIT 檔案內容（室內訓練）：**
| FIT Record | 欄位 |
|------------|------|
| `file_id` | type=activity, manufacturer, product |
| `session` | sport=cycling, sub_sport=indoor_cycling, total_timer_time, avg_power, avg_heart_rate, avg_cadence |
| `record` (每秒) | timestamp, heart_rate, power, cadence, speed |
| `lap` | 每圈摘要 |
| `activity` | total_timer_time, num_sessions |

---

### 額外功能（原計畫外）✅ 已完成

以下為開發過程中新增、原計畫未涵蓋的功能：

- **Element Plus UI 框架** — Welcome 頁面全面遷移至 Element Plus 暗色主題元件（表單、按鈕、摺疊面板等），Game HUD 維持自訂樣式
- **歷史騎乘對比** — `comparisonStore` + `useComparison` composable，可選擇歷史紀錄與當前騎乘即時對比
- **Debug 系統** — `debug-api.ts`（server）/ `debug-logger.ts`（web）/ `debug-writer.ts`（server），開發除錯用資料記錄
- **EuroVelo 路線目錄** — 動態爬取 EuroVelo（ODbL 授權）歐洲自行車路線 GPX + `catalogStore` 管理下載狀態
- **Auto-import** — Server 啟動時自動掃描 `data/routes/` 中的 GPX/TCX/FIT 檔案，驗證後匯入系統
- **RideHistory 元件** — 訓練歷史列表 + FIT 匯出 + 對比選擇
- **騎行風鏡系統** — 一片式弧形面罩 SVG 鏡框覆蓋層（`GlassesOverlay.vue`），鏡框色由 `el-color-picker` 自由選擇，動態計算多層漸層（radialGradient + specular highlight + shadow）營造 3D 立體感
  - **5 種鏡片模式**：Clear / Dark / Red / Yellow / Auto，遊戲中以 `el-segmented` 即時切換（`HudBottomRight.vue`）
  - **Auto 模式**：依 Open-Meteo 天氣自動選鏡片（sunny→dark, cloudy→red, rainy/snowy→yellow）
  - **鏡片痕跡**（`lens-marks-manager.ts`）：512×512 CanvasTexture，天氣觸發雨滴/雪/灰塵痕跡，撞金幣產生金色划痕，5-10 秒自然消退
  - **隧道視覺**（`tunnel-vision-pass.ts`）：HR Zone 4-5 + 高速（>30km/h）觸發邊緣徑向模糊，模擬高強度運動視覺收窄
  - **Render pipeline**：`RenderPass → GlassesShaderPass → TunnelVisionPass`（GPU）→ `GlassesOverlay`（z-5）→ `Hud`（z-10）
  - **區域照明**（`zone-detector.ts`）：根據 MVT features 偵測騎士位置環境（tunnel > forest > urban > open），透過風鏡 shader 疊加區域 tint — 林地變暗綠（brightness 0.8）、隧道大幅變暗冷色（0.45）、都市微暖（1.05）、開闊不變，500ms 平滑過渡
  - **區域感知環境粒子**：鏡片痕跡依區域生成 — 林地高頻葉子、開闘區偶爾葉子+少量灰塵、都市/隧道只有灰塵，天氣粒子（雨/雪）不受區域影響
- **地面填色分層** — MVT landcover/landuse 拆分五類地面 mesh：水體（電光青）、公園（薄荷綠）、林地（深墨綠）、沙地（沙棕）、都市用地（按 class 著色），各層 height offset 防 z-fighting
- **卡通樹木** — `tree-renderer.ts`，低多邊形 cone+cylinder InstancedMesh，grid sampling 20m + jitter ±5m 散佈在林地 polygon 內，point-in-polygon 過濾，deterministic hash 控制 scale（0.7-1.4×）/ rotation / canopy 色變，每 chunk 單一 draw call（≤300 棵 ≈ 30K triangles）
- **Minimap 指南針** — 右上角指北針（N 箭頭品紅色 + S 箭頭暗青色 + 十字環 + E/W 刻度），隨地圖旋轉反向旋轉保持指北
- **Minimap 球心置中修正** — 球永遠固定在 SVG 中心，路線以球為原點等比例投影，旋轉繞中心不會將路線甩出可視範圍
- **FPS 計數器** — `config.debug` 開啟時在 `HudTopBar` 顯示即時 FPS
- **NES 風格音效系統** — 純 Web Audio API 合成，零音檔零依賴
  - **合成器**（`game/audio/nes-synth.ts`）：方波 + 三角波，模擬 NES APU 的 2 pulse + 1 triangle 聲道
  - **7 種遊戲音效**：金幣收集（方波 C6→E6 叮聲）、Combo 遞增（音高隨等級升高）、Zone 5 警報（低頻方波 A2 脈衝 + LFO 調變）、圈數完成（三角波 C5→E5→G5 arpeggio）、遊戲開始/結束 jingle、**分段切換**（三角波 G5→C6 兩音提示）
  - **環境音**（`game/audio/ambient-noise.ts`，僅 Three.js 模式）：風聲（white noise + bandpass filter，頻率/音量隨速度 0-60km/h 即時連動）、雨聲（noise + highpass + 隨機正弦波雨滴，天氣切換時 1.5 秒淡入/淡出）
  - **統一管理**（`game/audio/audio-manager.ts`）：AudioContext 延遲建立（符合瀏覽器 autoplay 政策）、`config.sound.enabled` el-switch 控制全域開關
  - **觸發整合**：`useCoinSpawner` 碰撞 → 叮聲、`useCoinSystem` combo 變化 → 升頻音、`coinSystem.redLine` → 持續警報、`gameStore.laps` → 圈數音效、`weatherApi` → 雨聲、`ballEngine.speedKmh` → 風聲、`workoutTracker.segmentChanged` → 分段切換音
- **生成式主題曲 BGM**（`game/audio/generative-bgm.ts`）— 一樣純 Web Audio 合成，零音檔零依賴（也因此完全避開 SoundFont／取樣音源的授權問題）；原型與試聽頁在 `plan/theme-music-demo-opus.html`，**那份 demo 的程式碼就是這支檔案的內容**（照抄，見 `CUSTOM_WORLD_INSTRUCTIONS.md` §0.0）
  - **seed 決定曲子**：mulberry32 PRNG，seed 由路線 ID 雜湊（`seedFromString`，FNV-1a）而來 → **每條路線都有固定不變的專屬主題曲**；自由騎乘無路線則用固定 seed
  - **三套曲風跟著 `map.worldStyle` 走。設計原則跟視覺同一條：樂器從那個世界的「材料」推出來，不是先挑曲風再套上去**：
    - `plastic` → **積木・發條玩具進行曲**（2/4、C 大調、132 BPM、16 小節）：I-V-vi-IV 的玩具版和聲、旋律是一個 4 音十六分細胞在整首變形（B 段 bar 8–11 整組上移三度）、樂句每 4 小節收在主音。聲部＝音樂盒（基音 + 一根**不準**的泛音 ×5.9）／玩具鋼琴（方波過帶通 + 敲擊瞬態）／橡皮筋低音（三角波 + 濾波器下掃）／木魚。**沒有一個長音——塑膠不延音**
    - `cuphead`（紙板）→ **快樂的辦公室**（3/4 快三拍、D 大調、138 BPM、16 小節）：節奏骨架交給**打字機**（辦公室的脈搏不是鼓），行末鈴四小節響一次。聲部＝尺（壓在桌邊彈，衰減時音高微微下掉的 boing——它是旋律）／氈槌鋼琴（伴奏）／迴紋針／鉛筆／紙的摩擦／卡紙 thump／pad。**這個世界是有金屬的**（迴紋針、圖釘、訂書針），金屬補上這個世界缺的高頻
    - `circuit`（電子）→ **開機自檢**（4/4、A 小調五聲、140 BPM、16 小節）：第 1 小節是真的自檢掃描（方波由低到高每次 +3 半音、繼電器一路喀噠），然後主題進來；bar 10–11 是收束段（抽掉織體只留旋律與骨架）。聲部＝方波（旋律踩正拍 + 十六分琶音退到旋律以下的內聲部）／三角波低音／繼電器（兩段差 6 ms 的爆音）／高帽。**底噪從頭響到尾**：50/100/150/250 Hz 市電哼聲 + 7.4 kHz 線圈嘯叫（0.07 Hz LFO 慢飄）——板子通電就在響
  - **關鍵作曲約束**（隨機但不會變噪音）：音符只從音階級數取（`deg`）、每個聲部用 `fold` 折回自己的音域避免撞到旋律、動機細胞由 seed 抽一次然後整首變形（所以聽得出是同一首曲子，不是隨機遊走）
  - **排程**：lookahead scheduler（`setInterval` 每 25 ms 只負責提前 180 ms 把音排進 AudioContext 時間軸，不直接發聲，JS timer 抖動不影響節奏準度）；音符表依拍排序後逐一往前掃，掃完整首就 `loopN++` 接下一輪
  - **迴轉速連動曲速**：`audioManager.updateCadence` → `bgm.setCadence`，50-120 rpm 對應該曲基準 BPM 的 ±34%。**換速度時會把 `startAt` 重新錨定**，讓拍數位置連續——不然 spb 一變整首會瞬移
  - **開關**：`config.sound.bgmEnabled`（`SettingsPanel` el-switch，巢狀在 `sound.enabled` 之下——主音效關掉 BGM 一併靜音）；`worldStyle` 中途切換會即時換曲風（含電子底噪的起停）
  - **驗收**：`scripts/headless-check/music-vs-demo.ts`（跟著 `npm run check:3d` 跑）把 demo 的原始碼從 HTML 切出來執行，逐音符、逐 Web Audio 事件（節點型別／連線拓樸／每一個排上時間軸的參數）、以及**驅動排程器**跟正式版比對。耳朵驗不到的東西它全驗；音色好不好聽它驗不到
  - **Welcome 也有 BGM，且無縫接進遊戲**：`AudioManager` 是 **app 單例**（`getAudioManager()`），Welcome 與 Game 共用——若各自 `new` 一個，離開 Welcome 時得 `close()` 掉 AudioContext，音樂會在轉場斷掉重來。
    - `useThemeBgm()`（`composables/useThemeBgm.ts`）統一兩個 view 的接線：主音效／BGM 開關、`worldStyle`、seed 來源
    - **seed 取自當前選中的路線**（未選則用固定 lobby seed），所以在 Welcome 選路線就會即時換成那條路的主題曲，等於試聽
    - `startBgm(style, seed)` **只在曲子真的變了才重播**——GameView 進場時用同樣的 style+seed 再呼叫一次是 no-op，這正是無縫的關鍵
    - **autoplay 政策**：Welcome 載入時不能自己出聲，改在首次 `pointerdown`／`keydown` 起播（一次性監聽）
    - 騎乘結束不停 BGM，一路播過 summary 回到 Welcome；GameView `onUnmounted` 改呼叫 **`stopGameSounds()`**（停 redline 警報與環境音）而非 `dispose()`，後者會關掉共用的 AudioContext
    - 環境音改由 `setAmbientEnabled()` 控制（原本綁在 constructor 的 `isThreeJs`）：context 可能早在 Welcome 就因 BGM 建好了，所以 `AmbientNoise` 改成需要時才補建
- **FTP 結構化訓練系統** — 可選 5 種內建訓練模式，HUD 分段進度條 + 3D checkpoint flag + 訓練摘要
  - **訓練模式**（`shared/src/workouts.ts`）：Sweet Spot / VO2max / Endurance / FTP Test / Tabata，每個 profile 用百分比時間定義分段，依使用者設定的總時長等比縮放
  - **分段顏色方案（Cyberpunk）**：熱身冷藍 `#4a90d9` / Recovery 螢光綠 `#00e676` / Endurance 穩定綠 `#66bb6a` / Sweet Spot 琥珀黃 `#ffab00` / Threshold 螢光橘 `#ff6d00` / VO2max 警報紅 `#ff1744` / Sprint 螢光紫 `#d500f9`
  - **HUD 分段進度條**（`HudBottomLeft.vue`）：每段按時長比例佔寬度、當前段斜線 hatch pattern（`repeating-linear-gradient` 白色半透明條紋 + `stripe-scroll` 動畫）、三角形游標（`--hud-cyan`）隨 elapsedMs 滑動、下方顯示分段名 + 目標 %FTP → 瓦數
  - **訓練追蹤**（`composables/useWorkoutTracker.ts`）：追蹤 currentSegment / segmentIndex / targetWatts / isOnTarget（±10%），分段切換觸發 `segmentChanged` → NES 音效
  - **3D Checkpoint Flag**（`game/terrain/checkpoint-flag.ts`，僅 Three.js 模式）：InstancedMesh 圓柱 pole + 彩色旗幟 mesh，放置在分段邊界對應路線位置，騎手經過後 fade 至 0.2 透明度
  - **GameSummary 訓練結果**：顯示 workout 名稱 + 整體達標評等 + 各分段 target FTP% → 瓦數
  - **Welcome 頁面選擇器**（`StartChecklist.vue`）：el-select Workout Mode（6 選項含 Free Ride）+ 分段預覽色條 + 描述文字
  - **gameStore 整合**：`selectedWorkoutId` / `workoutSegments`，`startGame()` 時 `buildWorkoutSegments()` 展開，`reset()` 清空
- **統一功率評測標準（PWR 優先，速度估算 fallback）** — 前後端所有「該踩幾瓦」的評測都吃同一個訊號源
  - **Server 下發有效瓦數**：`game_state` 新增 `powerW`（有真實 PWR 感測器用實測瓦數；無 PWR 用輪速查訓練台功率曲線估算；感測器斷線歸零）+ `powerSource: 'meter' | 'estimated'`（標記來源，供 UI 顯示「估算功率」徽章）
  - **修正歷史 bug**：舊前端把 `speedKmh`（km/h）直接當「現在功率」餵給 workout on-target 判定（±10% 瓦數容差），導致結構化訓練幾乎永遠 OFF TARGET；server 端隨機事件早已改用 `lastWatts`，此次把 workout 路徑一併統一
  - **前端消費點全面切換**：`useWorkoutTracker`（on-target 判定）、`HudTopBar` POWER 欄位（無 PWR 時顯示估算瓦數而非速度）、`useGameLoop` 時間序列（speed-only 設定也有功率曲線圖）都改讀 `gameStateStore.powerW`
- **訓練段落主題化 + 標尺儀錶 HUD** — 結構化訓練的每個分段以「事件」的敘事語言呈現，解決「單獨騎時不知道該踩幾瓦」
  - **段落主題**（`shared/src/workouts.ts` `getSegmentTheme()`）：依分段名稱關鍵字（warm/cool/recovery/rest）與目標強度（%FTP）對應 8 種故事主題——晨間出發（暖身）/ 補給站（恢復）/ 順風巡航（≤79%）/ 逆風來襲（80-94%）/ 長坡爬升（95-109%）/ 警車追擊（110-139%）/ 終點衝刺（≥140%）/ 夕陽返家（緩和），每個主題含名稱、Font Awesome 圖示、主色、畫面 tint、風味提示語；純呈現層，不影響目標與評分
  - **標尺儀錶**（`PowerGauge.vue`，通用元件）：水平標尺，目標值置中、±容差綠帶（功率 ±10%、踏頻 ±15%，與 server 判定一致）、現值指針（帶內變綠 glow）、量程 target ±40%、即時指引文字（▲ 再加 XW / ✓ 穩住節奏 / ▼ 收一點 XW）
  - **HudWorkoutBar.vue**：訓練模式常駐中央底部面板——主題圖示+故事名+分段名、風味提示、PowerGauge、可選踏頻目標、分段倒數（撐過 M:SS）、ON/OFF TARGET 狀態、`powerSource === 'estimated'` 時顯示「估算功率」徽章；分段切換時以 `:key` 重播進場動畫
  - **HudEventBar 同步升級**：隨機事件面板也插入 PowerGauge（踏頻事件顯示 rpm 標尺，其餘顯示瓦數標尺）
  - **畫面色調**：`Hud.vue` 的 tint overlay 合併邏輯——進行中的隨機事件優先（短而強烈），否則套用當前訓練段落主題 tint（長而含蓄，opacity 0.05-0.10）
  - **圖示補註冊**：`main.ts` 補上 `faWind` / `faCircleXmark` / `faCloudShowersHeavy` / `faGem` / `faCarSide` / `faFeather` / `faMoon`（隨機事件目錄既有圖示先前未註冊，運行時不渲染）
- **HR Zone 指示器** — `HudTopBar.vue` HR 面板底部新增 5 個 `heart-pulse` 圖示，標記當前心率區間
  - 5 個 Font Awesome `heart-pulse` 圖示排成一行，每個使用對應 zone 的 CSS 變數色彩（`--zone-1` ~ `--zone-5`）
  - 當前 zone 的圖示 opacity 1 + `drop-shadow` glow，其餘 opacity 0.2
  - 圖示右方顯示 zone 名稱標籤（如 "Z3 AEROBIC"）
  - 無感測器連線時不顯示（`v-if="hr != null"`）
  - HR metric 區塊使用 `flex-wrap: wrap`，zone bar 佔滿寬度作為第二行
  - `currentZone` computed 呼叫 `getHrZone(heartRate, hrMax)` 取得 `HrZone { zone, name, coinsPerTick }`
- **訓練行事曆** — `el-drawer`（720px, rtl）雙月檢視 + 每日騎乘次數 + 騎乘詳情 + d3.js 統計圖表
  - **CalendarMonth.vue**：CSS grid 7 欄月曆，dayjs 計算日期偏移，cyan badge 顯示當日騎乘次數，today 黃色標記，未來日期灰化
  - **DayRideList.vue**：點擊日期後右欄切換為當日騎乘列表（時間、時長、心率/功率/速度/金幣摘要），可點開查看詳情或匯出 FIT
  - **RideDetailDrawer.vue**：巢狀 el-drawer 顯示單次騎乘摘要 + 3 張 d3.js 圖表（時間序列多線圖、HR Zone 分佈橫條圖、功率直方圖）
  - **TrainingCalendar.vue**：主 drawer，雙月並排或月+日列表切換，月份導航
  - **useCalendar composable**：管理 drawer 開關、月份導航、日期選擇、騎乘載入、詳情 drawer 狀態
  - **Server API**：`GET /api/rides/calendar?from=&to=`（日期範圍內各日騎乘次數）、`GET /api/rides/:id/samples`（單次騎乘所有樣本資料）、`GET /api/rides?date=YYYY-MM-DD`（日期篩選）
  - **useRideCharts.ts**：d3.js 圖表渲染函數 — `renderTimeSeriesChart()`（HR/Power/Speed/Cadence 四線 + 雙 Y 軸）、`renderZoneDistribution()`（HR Zone 1-5 水平長條圖）、`renderPowerHistogram()`（20W bin 功率分佈）
- **Picture-in-Picture 浮動視窗** — 用 Document PiP API（Chrome/Edge 116+）將整個遊戲搬到 always-on-top 浮動視窗，讓用戶邊騎車邊看影片
  - **useDocumentPiP composable**（`composables/useDocumentPiP.ts`）：PiP 視窗生命週期管理 — 開啟（800×500）、CSS 樣式注入（複製所有 stylesheet 到 PiP document）、`pagehide` 自動清理、程式關閉
  - **PiPSidebar.vue**（`components/game/PiPSidebar.vue`）：右側 140px 直排精簡數據面板 — HR（zone 色帶）/ 速度 / 功率 / 踏頻 / 圈數 / 經過時間+進度條 / STOP 按鈕，直接讀取 Pinia stores
  - **DOM 搬移策略**：用 `appendChild` 將 `.game-content` wrapper（含 canvas + PiPSidebar）搬到 PiP 視窗，保留 WebGL context 不中斷；PiP 關閉時 `prepend` 搬回主視窗
  - **Canvas 自適應**：搬移後調整 canvas/map 尺寸為 `calc(100% - 140px)`（扣除 sidebar 寬度），監聽 PiP 視窗 `resize` 事件同步更新；搬回時恢復 `100vw × 100vh`
  - **HUD 模式切換**：PiP 啟用時隱藏完整 HUD（Hud.vue + GlassesOverlay），主視窗顯示佔位畫面（「GAME RUNNING IN FLOATING WINDOW」+ 返回按鈕）
  - **Game Loop 背景保活**（`composables/useGameLoop.ts`）：監聽 `visibilitychange`，分頁隱藏時取消 rAF 改用 `setTimeout`（~10fps），物理/數據持續更新但跳過 3D 渲染；分頁可見時恢復 rAF
  - **HUD PiP 按鈕**：`HudBottomRight.vue` 新增 cyan 配色按鈕（`fa-up-right-from-square`），`v-if="pipSupported"` 控制顯示（Firefox/Safari 自動隱藏）
  - **遊戲結束處理**：PiP 視窗中按 STOP → 自動關閉 PiP → GameSummary 顯示在主視窗
  - **TypeScript**：`types/document-pip.d.ts` 宣告 `DocumentPictureInPicture` 介面
- **GameSummary 五角雷達圖** — 結算畫面 d3.js 雷達圖（radar/spider chart），本次騎乘 5 項指標 vs 同路線歷史 PB
  - **五軸**：Power（平均功率）/ Speed（平均速度）/ HR Eff（速度/心率比 — 有氧效率）/ Cadence（平均踏頻）/ Zone Sustain（Z2+Z3 時間%，Seiler 極化訓練理論）
  - **GameStats 擴充**（`useGameLoop.ts`）：新增 `avgCadence` + `zoneSustainPct` 累計邏輯
  - **PB 端點**（`GET /api/rides/best?routeId=&hrMax=`）：按 `avg_power_w` 降序查同路線最佳紀錄 + 從 ride_samples 即時計算 Zone Sustain
  - **renderRadarChart()**（`useRideCharts.ts`）：5 頂點均勻分佈、3 圈同心五角刻度線、PB 金色多邊形 + 當前 cyan 多邊形、Orbitron 標籤
  - **GameSummary.vue 整合**：遊戲結束 fetch PB → d3 渲染 → 圖例（cyan THIS RIDE / gold PERSONAL BEST），無路線時不顯示，面板寬度 600px
- **中央倒數計時 overlay**（`components/game/CountdownOverlay.vue`）— 在「訓練分段結束前」與「總訓練時間結束前」的最後 60 秒，於畫面正中央顯示大字倒數
  - **兩種模式**：`NEXT PHASE IN`（分段即將結束，青色 + `flag` 圖示）/ `FINISH IN`（總時間即將結束，金色 + `flag-checkered` 圖示）；最後 10 秒轉紅並加強脈動（`data-urgent`）
  - **觸發邏輯**（`GameView.vue` `activeCountdown` computed）：復用既有 `useWorkoutTracker.segmentRemainingMs` 與 `gameLoop.elapsedMs`，零新增資料管線；分段剩餘或 `targetDurationMs - elapsed` ≤ 60s 時觸發，兩者同時落窗時（profile 課表最後一段結束正好等於時間到）以「結束」為優先避免標籤打架；自由騎乘（無課表）只觸發 finish 倒數
  - **非阻擋式**：`pointer-events: none` + 僅中央暈影,騎士仍看得見路面繼續踩踏;巨大數字每秒以 `:key` 重播 pop 動畫;僅在 `state==='playing' && !isPaused && hasStarted` 顯示（不蓋起始提示/暫停畫面）,時間到後 `state='ended'` 自然消失
  - **PiP 相容**：放在 `.game-content` 內,子母畫面同步顯示;尊重 `prefers-reduced-motion`
- **手動暫停 = 全停（2026-07-23）** — 過去手動暫停只凍結 sim 物理，時鐘與錄製照跑（方案甲全面適用），玩家按暫停後 ride 時長、SQLite 樣本、jsonl、FIT 距離都繼續累積。現在拆成兩種暫停：**手動暫停**（暫停鍵/Space/起始提示的 born-paused）→ ride 時鐘停（sim `pausedWallMs` 唯一權威，`elapsed = wall − pausedMsTotal()`）、raw jsonl / SQLite 樣本 / 統計與 FIT 距離積分全部凍結（`LiveSession.manualPauseActive()` 閘門，accumSpeed 會重置積分錨點防止恢復時跨暫停積分）、`durationMs` 扣除暫停時間；WS 廣播照常（HUD 暫停中仍看得到即時心率），client 時鐘在暫停時鎖定 server 錨點不外插。**Idle 自動暫停**（30 秒沒踩）維持方案甲：時鐘與錄製照跑。附帶效果：deferred start 的「起始提示等待期」現在完全不進紀錄。
- **起點視窗（2026-07-23）** — 歡迎頁展開的高度圖上方新增 `RouteStartWindow.vue`：整條路線的距離軸高度剖面 + 一個可拖曳的視窗（寬度 = 目標騎乘時間 × 路線配速，GPX 時戳優先、無則 20km/h），視窗左緣 = 起騎里程。狀態存 `gameStore.startOffsetM`（換路線歸零），經 `pendingStart.game.startOffsetM` 送後端。**核心原則：`cumulativeDistance` 一律維持「已騎」空間（0 起算，統計/金幣/finishTarget 預測不變），只在「映射到路線位置」時加 offset**——server sim（laps/wrapped/金幣落點/實體終點）與 client `gameStateStore.sample()` 用同一條公式；chunk preload 以起點 chunk 為中心（`preloadIndices`，loop 會繞回、非 loop 截斷）；checkpoint 旗改存已騎距離軸（順便修掉繞圈比較的舊 bug）；終點飛船呼叫端把兩個 cum 各加 offset。已知限制：幽靈車 trace 若來自「有 offset 的騎乘」會錯位（trace 只存已騎距離、rides 表未記 offset）；`WorkoutElevationPreview` 的分段預覽仍從路線 0 起繪。
- **錄製時機修正（延後至通過起始提示）** — 過去 `StartBar.launchGame()` 在導航進遊戲「之前」就 `POST /api/live/start`,導致後端在「踩踏/Space 繼續」提示還沒通過時就進入 `recording`（建 ride、開 jsonl、啟動計時）。改為把 start body 暫存於 `gameStore.pendingStart`,由 GameView 的 `beginRide()` 在第一次 unpause（通過提示）時才真正呼叫;`beginInFlight` 旗標防重複 start,成功後對 Space/點擊路徑主動補送 `/api/live/resume`（sim 出生 `paused=true`,踩踏路徑靠 tick auto-start,無功率訊號的 Space 路徑需主動 resume 否則球卡死）;失敗以 `revertToPrompt` 還原提示供重試。附帶徹底解決 replay/mock 在提示期間把球推走的問題（提示前根本無 server sim）

---

### Phase 7: Phaser.js 2D Excitebike 橫軸清關遊戲模式 ✅ 已完成

在 MapLibre (2D 地圖) 和 Three.js (3D 地形) 之外，新增第三種渲染模式：Phaser.js 驅動的 NES 風格橫軸捲軸騎行遊戲。

**核心概念**：像 Mario / 魂鬥羅 / Excitebike，玩家從左到右逐漸展開地圖。路線海拔剖面 = 地形表面，沿途的真實地理資料（建築物、樹林、水體）渲染成 2D 場景元素。

**視覺風格（雙風格 Strategy 模式）** ✅ 已完成：

2D 側捲模式支援兩種可切換的視覺風格，透過 **Strategy 設計模式** 實作：

| 風格 | 說明 | 預設 |
|------|------|------|
| **塑膠風（plastic）** | 延續 Three.js 的霓虹/平面卡通風格 — 純色填充、幾何形狀、螢光色系、CRT 掃描線 | ✅ |
| **手繪風（cuphead）** | 1930 年代 Cuphead 手繪動畫風格 — 搖擺墨線、水彩質感填充、斜線陰影、復古暖色調、膠片噪點 | |

- 使用者在 Welcome 頁 StartChecklist 透過 `el-segmented` 切換（僅 Phaser 模式顯示）
- 設定存入 `config.json`（`map.phaserStyle: 'plastic' | 'cuphead'`）
- 所有視覺元素都是程序化 Canvas 2D 繪製（無外部圖檔），手繪效果透過演算法模擬
- 風格切換需重新載入 Phaser scene

**Strategy 介面**（`PhaserStyleStrategy`）：
- 每個視覺元素（地形、建築、樹、水、草、天空、雲、山脈、騎士、金幣、標記、覆蓋層）都有對應方法
- 渲染器（scene / terrain-builder / weather）委託 strategy 繪製，不 hardcode 風格邏輯
- 工廠函數 `createStyleStrategy()` 用 dynamic import code-split

**Cuphead 手繪風核心技法**：
- 搖擺墨線：以位置為 seed 的確定性偏移，chunk 載入時預計算
- 水彩填充：多 pass 半透明矩形疊合，模擬水彩暈染
- 斜線陰影（cross-hatch）：平行斜線 alpha 疊加，模擬版畫陰影
- 有機 blob：8-12 點不規則路徑，模擬手繪輪廓
- 膠片噪點：預渲染 canvas texture，每 4 幀位移 0-3px + 暖棕色調
- 騎士：64×64 橡皮管風格（圓潤肢體、派切眼、白手套）
- 色票：復古暖色（鼠尾草綠、暖奶油、磚紅、芥末金）

**MVT 地物取樣半徑** ✅ 已完成：
- `FEATURE_CORRIDOR_M` 從 500m 加大至 1000m（1km），確保路線沿途建築等地物正確出現

**山脈形狀差異化** ✅ 已完成：
- 山脈形狀生成移入 Strategy（`generateMountainPoints()`），兩種風格各有獨特山脈輪廓
- 每次 session 隨機產生 `mountainSeed`，確保超遠景山脈不會每次看起來一樣
- Plastic：sine 波疊合 + seed 相位偏移（保持原有平滑曲線風格）
- Cuphead：三角形尖峰（200-400px 寬、18-28% skyH），10% 平頂山、15% 雙峰變體，seed 控制峰高/峰寬/分佈

**不移植**：風鏡系統（GlassesOverlay）— 3D 專屬後處理效果，2D 模式不適用。

**直接複用**：NES 音效（nes-synth.ts）、環境音（ambient-noise.ts）、天氣 API（useWeatherApi.ts）、天文計算（sun-moon-calc.ts）、MVT 資料取得（mvt-fetcher.ts）、所有遊戲邏輯 composables（ballEngine, coinSpawner, coinSystem, gameLoop）。

#### 架構設計

**Phaser ↔ Vue 整合**：
- Dynamic `import('phaser')` 做 code splitting（Phaser ~1MB gzip，不用此模式的使用者不該付代價）
- 關閉 Phaser 內建遊戲迴圈，由現有 `useGameLoop` 統一驅動（每 frame 手動呼叫 `scene.update()` + `game.renderer.render()`），跟 Three.js 模式做法一致
- Bridge 機制：純 JS 物件（非 Vue reactive，效能考量），Vue game loop 每 frame 寫入，Phaser scene update() 讀取

```typescript
interface PhaserBridge {
  distanceM: number;       // ballEngine 的行進距離
  elevationM: number;      // 當前海拔
  speedKmh: number;        // 速度
  cadenceRpm: number;      // 踏頻（驅動踩踏動畫）
  isDarkened: boolean;      // Zone 5 紅線
  weather: string;          // sunny/cloudy/rainy/snowy
  sunElevation: number;     // 太陽仰角（日夜）
  moonPhase: number;        // 月相
}
```

#### 地形系統

**海拔剖面 → 2D 地形**：
- `RoutePoint[]` + `cumulativeDists[]` 每 5m 取樣海拔，垂直誇大 3-5 倍
- X = 距離 × scale (~3 px/m)，Y = 海拔（Phaser Y 反轉）
- `Phaser.GameObjects.Graphics` 繪製填充地面（地表以下 = 棕色/土色填充）

**MVT 地物渲染**（複用 `mvt-fetcher.ts` 取得路線附近 vector tile features）：

| MVT Layer | 2D 呈現 |
|-----------|---------|
| `building` | 矩形方塊站在地形表面上，高度 = 建築高度（或預設 8m），霓虹配色（複用 building-renderer 調色盤） |
| `landcover` (forest) | 簡筆像素樹 sprite（三角形 + 矩形樹幹），隨機高度/間距散布 |
| `landcover` (grass/park) | 地面填色改為綠色段落 |
| `water` | 地形線以下填藍色 + 水波動畫 |
| `landcover` (sand) | 地面填色改為黃色段落 |

**地物定位**：MVT features `[lng, lat]` → 計算距路線最近點的 route distance → X 座標。只取路線兩側 ~200m 內。

**Chunk 式載入**：路線分成 ~500m 的 2D chunk，騎士前方 2-3 個 chunk 預載，後方銷毀。

#### 天氣 / 日夜 / 星空

複用現有資料來源（useWeatherApi + sun-moon-calc），做 Phaser 視覺層：

- **天空背景**：`Graphics` 畫全螢幕漸層（日間藍天 / 黃昏橘紅 / 夜間深藍）
- **星空**：400 顆星 `fillCircle()`，太陽 < -6° 全亮，天氣遮蔽（cloudy 15% / rainy 5% / snowy 10%）
- **月亮**：圓形 sprite，亮度隨月相變化
- **雨/雪**：Phaser `ParticleEmitter`（雨 = 垂直短線 / 雪 = 慢速飄落 + sin 漂移）
- **雲**：橢圓形 sprite 水平飄動
- **霧**：半透明灰色矩形疊加

#### 騎士 Sprite

- 程式化生成 spritesheet（Canvas → dataURL → Phaser texture）
- 像素風格塑膠公仔：圓形頭、矩形身體、線條四肢 + 腳踏車輪廓
- 4-6 幀踩踏動畫，速度 = cadenceRpm 映射
- 坡度 → sprite 旋轉角度（上坡傾斜、下坡俯衝）
- Zone 5 → 紅色閃爍 tint

#### 金幣系統

- 實作 `CoinLayerInterface`（需先把介面從 `three-layer.ts` 提取到 `coin-interface.ts`，`CoinVisual.mesh` 改 `unknown`）
- `spawnCoin(lngLat, altitude)` → 反查 route distance → Phaser 世界座標
- 物件池 + 收集動畫（放大 + 淡出）+ NES 音效直接複用

#### 視覺打磨

- CRT 掃描線疊加
- Workout segment 彩色帶（天空背景垂直色條）
- 距離刻度標記（地面每 500m / 1km）
- 起點/終點旗幟 sprite
- 迷你進度條（頂部路線完成度）

#### 新建檔案

| 檔案 | 說明 |
|------|------|
| `game/coin-interface.ts` | `CoinVisual` + `CoinLayerInterface` 提取（renderer-agnostic） |
| `game/phaser/phaser-game.ts` | Phaser.Game 工廠（dynamic import + config） |
| `game/phaser/excitebike-scene.ts` | 主場景（create/update，組裝所有子系統） |
| `game/phaser/terrain-builder.ts` | 海拔地形 + MVT 地物 2D 渲染 + chunk 管理 |
| `game/phaser/phaser-weather.ts` | 天氣/日夜/星空/雨雪粒子 Phaser 版 |
| `game/phaser/cyclist-sprite.ts` | 騎士 sprite + 踩踏動畫 |
| `game/phaser/phaser-coin-layer.ts` | `CoinLayerInterface` Phaser 實作 |
| `game/phaser/phaser-style-strategy.ts` | ✅ Strategy 介面定義 + `createStyleStrategy()` 工廠（dynamic import code-split） |
| `game/phaser/plastic-style.ts` | ✅ 塑膠風 Strategy 實作（從各檔案抽出原有繪圖邏輯） |
| `game/phaser/cuphead-style.ts` | ✅ Cuphead 手繪風 Strategy 實作 |
| `game/phaser/cuphead-palette.ts` | ✅ Cuphead 復古暖色調色票 |
| `game/phaser/cuphead-draw.ts` | ✅ Cuphead 專用繪圖工具（搖擺墨線、水彩填充、斜線陰影、有機 blob） |
| `composables/usePhaserRenderer.ts` | Vue ↔ Phaser 橋接（對標 useTerrainRenderer API） |

#### 修改檔案

| 檔案 | 變更 |
|------|------|
| `shared/src/config.ts` | `renderMode` 加 `'phaser'`；`map` 加 `phaserStyle: 'plastic' \| 'cuphead'` ✅ |
| `game/three-layer.ts` | `CoinVisual` / `CoinLayerInterface` 搬到 `coin-interface.ts` |
| `views/GameView.vue` | 加 `isPhaser` 分支（canvas + init + game loop deps + cleanup） |
| `components/welcome/StartChecklist.vue` | Phaser 模式顯示世界風格 `el-segmented`（塑膠風/手繪風），隱藏鏡框設定 ✅ |
| `components/welcome/SettingsPanel.vue` | 渲染模式下拉加 `Phaser.js (2D)` ✅ |
| `composables/usePhaserRenderer.ts` | 讀取 `phaserStyle` → `createStyleStrategy()` → 傳入 scene/terrain/weather ✅ |
| `game/phaser/phaser2d-scene.ts` | 繪圖函數委託 `this.strategy` 對應方法 ✅ |
| `game/phaser/terrain-builder.ts` | MVT 地物渲染委託 strategy ✅ |
| `game/phaser/phaser-weather.ts` | 天空/雲/山繪圖委託 strategy；山脈形狀由 `strategy.generateMountainPoints()` 生成 + `mountainSeed` 隨機化 ✅ |
| `game/terrain/mvt-projection.ts` | `FEATURE_CORRIDOR_M` 500 → 1000（1km） ✅ |
| `game/audio/audio-manager.ts` | 環境音啟用 flag 從 `isThreeJs` 改為 `isThreeJs || isPhaser` |

**依賴**：`npm install phaser`（使用者在 Windows 執行）

---

## 視覺風格

本遊戲採用**多層風格設計**，3D 渲染、2D 渲染、UI 各有獨立的美術方向：

| 層面 | 風格 | 說明 |
|------|------|------|
| **3D 場景渲染** | 積木 / 瓦楞紙（可切換） | Strategy 模式雙風格：**積木**＝階梯量化地形 + 凸點 studs + 亮面塑膠原色;**瓦楞紙**＝等高線疊層 + 牛皮霧面 + 墨線描邊。全程序化 vertex color、零貼圖 |
| **2D 場景渲染** | 塑膠風 / 手繪風（可切換） | Strategy 模式雙風格：塑膠風延續 3D 霓虹配色，手繪風為 1930s Cuphead 風格（搖擺墨線 + 復古暖色） |
| **UI / HUD** | Cyberpunk 2077 | 深色底 + 霓虹青/黃/品紅光暈、Orbitron 字型、大寫字距、斜切角 `clip-path`、掃描線動畫、故障閃爍 |

### 3D 世界風格策略（`TerrainStyleStrategy`）

3D 渲染改採與 Phaser 2D（`PhaserStyleStrategy`）對稱的 Strategy 模式——一套建構邏輯、兩種「手作拼裝」風格，由 config `map.worldStyle` 跨模式統一驅動：

| `worldStyle` | Phaser 2D | Three.js 3D |
|---|---|---|
| `plastic` | 霓虹平塗 | **積木**（cubic step + studs + 亮面原色） |
| `cuphead` | 手繪墨線 | **瓦楞紙**（contour sheet + 牛皮霧面 + 反殼墨線） |

- **共用量化引擎**（`game/terrain/quantized-terrain.ts`）：把走廊高程量化成**平頂 cell + 垂直落差面 + 邊界裙邊**;以**絕對高程**量化 → 層相位固定世界座標、跨 chunk 無縫（不受 floating origin 影響）。積木＝小格 + studs、瓦楞紙＝大層 + 墨線,一引擎兩組參數。
- **策略介面**（`game/terrain/terrain-style-strategy.ts` + `plastic-terrain-style.ts` / `paper-terrain-style.ts`）:各 renderer（terrain-chunk / building / road / landuse / tree）向注入的 strategy 取材質 / 顏色 / 幾何 / studs 裝飾 / 墨線 / 後處理;`createTerrainStyleStrategy()` dynamic import code-split。
- **紙後處理**解耦於「騎行眼鏡」效果:屬 strategy(`createPostPass`),`CyclingGlassesEffect.setStylePass()` 掛為最後 pass,關眼鏡不消失。
- **即時調參面板**（`StyleTuningPanel.vue`,掛 `config.debug`）:層高 / 格子 / studs / 瓦楞 / 墨線 / 紙後處理滑桿——後處理即時、幾何 debounce 觸發地形重建。實機由 user 在 Windows 拉「好看又不卡」的甜蜜點後固化 `defaultStyleParams()`。
- **命名債**:舊 config key `map.phaserStyle` 已改名 `map.worldStyle`(server `ConfigStore.load` 自動遷移舊值);值 `cuphead` 與 DOM `data-world-style` / CSS 主題不動。
- **版權**:全程序化、零外部模型 / 貼圖;積木相關程式碼 / UI 一律用通用詞 blocks / studs / brick,不掛任何商標。

**3D 積木 / 瓦楞紙世界**（Phase 4.5 + 世界風格策略詳述）：
- 地形量化成階梯 / 疊層 cell,建築坐落階梯,樹為方塊 / 卡紙,不使用衛星圖磚貼圖,完全程序化 vertex color
- 積木:cell 頂鋪 InstancedMesh 凸點 studs、亮面原色;瓦楞紙:牛皮霧面 + 反殼法(inverted hull)墨線輪廓

### 3D 第三人稱「書桌小世界」（diorama 模式,現行唯一 3D 模式）

3D 從「第一人稱寫實地圖」改為 **3DS 遊戲風的第三人稱 diorama**:世界骨架(MVT 建築 / 道路 / 森林 + DEM 真實高程)完全不動,只換造型與視角。造型全部掛在 `TerrainStyleStrategy` 上,renderer 骨架零改動。

| 元件 | `cuphead`(瓦楞紙文具都市) | `plastic`(塑膠積木糖果都市) |
|---|---|---|
| 單車擺件 `bike-ornament.ts` | 迴紋針單車(TubeGeometry 一筆彎折車架 + Torus 輪 + 橡皮擦座墊) | 玩具積木單車(黑胎 + 黃輪轂 + 亮面粉紅車架) |
| 遠山 / 地平線 `mountain-ring.ts` | 三角尖峰 + 10% 平頂、書桌木色收尾盤 | sine 疊合量化成 6 階積木階梯、玩具紫地墊 |
| 建築裝飾 | 摺蓋屋頂 + 封箱膠帶 + 蠟筆窗戶 | 斜屋頂 / 凸點頂蓋 + 亮面白窗 |
| 道路 | 紙膠帶(斜紋)+ 立可白虛線 | 亮面路板 + 白虛線 |
| 路線標記 `route-line-mesh.ts` | 螢光筆塗痕(黃綠 1.8m + 淡暈 4.0m) | 霓虹膠帶(粉紅 1.6m + 紫暈 4.2m) |
| 樹 | 剪紙十字插樹(alphaTest 卡片) | 堆疊方塊樹 |
| 街燈 `street-lamp.ts` | 鉛筆路燈(筆尖夜間發光) | 積木街燈(透明黃磚頭) |
| 金幣 / Checkpoint | 金色圖釘 / 大頭針 + 便利貼旗 | 凸點圓磚 / 積木旗座 |

- **相機**(`fps-camera.ts`):預設 `mode: 'third'`,**完全照 demo 的「跟騎」相機**——
  - **FOV 55°**(`game-renderer.ts` `DEFAULT_FOV`)。舊的 75° 是第一人稱廣角,會把世界推遠、透視誇張——**相機放哪都還是像舊鳥瞰視角,元兇就是它**。
  - 幾何 = demo 值 × 0.66(demo 是 7m 車、後 17 / 高 9.5 / 看車前 8m @ y=4;我們的車 ~4.6m):**後 11.2m / 高 6.3m / 看車前 5.3m @ y=2.6**。
  - **手感來自不對稱**:位置 `lerp(target, min(dt × 3.2, 1))`(每幀只追 ~5.3%,過彎時鏡頭甩出弧線再收回),**視線每幀硬 `lookAt` 不做 slerp**。舊版兩者都平滑 → 鏡頭像鎖在軌道上。
  - `cameraHeight` 滑桿改成**純縮放**(15 → 1.0 = demo 構圖,clamp 0.45–2.2),不再有「視高」語意;pitch 滑桿只微調視線目標高度。
  - `mode: 'first'` 保留(第一人稱時單車自動隱藏),仍用原本的即時跟隨 + slerp。
  - **`mode: 'orbit'` 自由視角**(`orbit-camera.ts`,HUD 的「跟車/自由」segmented):拖曳旋轉、滾輪縮放、永遠看向單車。指標事件**只在自由視角期間掛載**,否則正常騎乘的滾輪會被沒人在用的相機吃掉。
  - **視線淨空**(`camera-collision.ts`):判斷的是**相機到單車那條視線有沒有被地形擋住**,不是「地形有沒有高過相機」。**下坡時兩者不等價**——剛翻過的坡頂會擋在相機與單車之間,但它可能還低於相機,「相機有沒有埋進地裡」永遠不會觸發,單車就這樣消失在紙板後面。作法:沿視線取樣 5 點,解出「要抬多高整條視線才越得過去」,抬高相機 + 視線壓向單車(變俯視)。**升快(12/s)落慢(2/s)**:地面在階梯間跳動,逐幀跟隨會讓鏡頭上下抖。
  - **升鏡**(`camera-lift.ts`):課表換段 → `peek`(1.2s 升 / 2.6s 停 / 1.2s 落);剩 10 秒 → `finale`(升起並保持,結算 dialog 開在俯瞰畫面上)。優先序 **自由視角(使用者) > 升鏡 > 跟車**,使用者隨時能奪回相機。刻意**不碰 gameStore 狀態機**(`state='ended'` 會立刻開結算 + 寫 DB,插 cinematic 相位風險大)—— 這也是 F6 flyover 當初被砍掉的原因。
- **單車動畫**:輪子 / 曲柄隨速度轉,過彎依 yaw 變化率傾斜。本體 local forward = +x、輪軸 = z;`bike-ornament.ts` 負責行為,造型由 strategy 的 `buildBikeOrnament()` 提供。
- **遠山**:兩圈環形剪影**只平移不旋轉** → 自然視差(對齊 Phaser 2D 雙層山脈);seed 每 session 隨機。地平線收尾盤是**環形**(內徑 > 走廊半寬),避免下坡時蓋掉山谷地形;**必須寫深度**——three 的 `Sky` 是 BackSide 天空盒,連下半球都畫,不寫深度會被天空蓋掉。
- **街燈**:回收式 pool(~10 盞沿路滑動),長路線成本恆定;白天 `light.visible = false`,不讓十幾顆 PointLight 空轉。
- **路線標記**:照 demo —— **畫在路面上的靜態塗痕**(窄實色 core + 寬淡暈 glow 兩層 ribbon,`MeshBasicMaterial`、`depthWrite: false`、renderOrder 10 / 9),離地 0.6m(路面在 terrain + 0.3m)。**沒有箭頭跑道燈、沒有追逐動畫、沒有 bloom**——舊的發光引導線浮在 5m 高、像 HUD 疊在世界上,與 diorama 不合。因此 **bloom layer 現在無人使用**,`setBloomEnabled(false)`(兩套皮皆是);`BLOOM_LAYER` 常數保留給未來的發光物件。
- **天空 / 日夜**(2026-07-14 改版,`gradient-sky.ts` + `day-night-lighting.ts`):
  - **拆掉 three 的 Preetham `Sky`**,換成 demo 的**漸層天空盒**(BackSide 球 + 兩色垂直漸層量化成 5 階)。Preetham 是物理大氣模型:低於民用曙暮光就**全黑**、陰天在地平線**爆 HDR 白**——所以舊管線必須「夜晚藏天空、非晴天藏天空」,並把 `toneMappingExposure` 壓到 0.6–0.9。**那個壓低的曝光就是整個場景發黑的主因。**
  - **曝光恆定 1.05**(demo 值,`TONE_MAPPING_EXPOSURE`),日夜/天氣**一律不再動曝光**;氣氛全部交給色票 + 霧。
  - 日夜端點下放 strategy:`skyPalette: { day, night }`(SkyMood = 天空上下色 / 霧 / 主光 / 半球光 / 環境光),值直接取自兩個 demo 的 DAY/NIGHT。**夜晚下限 = demo 夜**(ambient 0.18),寫死在 `day-night-lighting` 出口的 `Math.max`,任何(時段 × 天氣)組合都不得更暗。
  - **陰天 = 平光 + 灰 + 霧,但亮**:雲會散射光,`ambientMul` 往**上**調(cloudy 1.3)、`directionalMul` 只壓主光(0.5)。舊版陰天把 ambient 和曝光一起壓 → 灰天變黑天。
  - 日夜關閉時走**同一條** palette 管線(`legacyCelestial()`),不再有另一套寫死的 legacy 燈光/霧(舊的 `updateSky`/`updateLightingLegacy`/`updateFogLegacy` 已刪)。
- **地圖元素涵蓋率**(2026-07-14 擴充,依 `scripts/mvt-survey/survey.mjs` 的全量盤點):
  - `mvt-fetcher` 抓 8 個 layer:transportation / building / water / **waterway** / landcover / landuse / park / **aeroway**。刻意**不抓** housenumber / poi / boundary / transportation_name —— 那是文字標籤資料,3D 世界用不到(佔圖磚全部 feature 的約 2/3)。
  - **河流溪流**(`waterway-renderer.ts`):既有的 water layer 是**面**(湖泊),流動的水是**線** —— 這是盤點裡最大的視覺洞(~1,290 筆)。ribbon 寬度按 class(river 6m…ditch 1.5m),離地 0.15m(**低於道路 0.3m**,水從橋下過)。**`brunnel=tunnel`/`culvert` 一律跳過**——那是路面底下的涵管,畫出來會是橫躺在柏油路上的藍帶子。
  - **地面色塊**(`landuse-renderer.ts`):新增濕地 / 農田 / 運動場;機構用地(school/hospital/…)併入 urban(它們就是建成地,房子本來就走 building layer)。**LanduseRenderResult 是 `layers[]` 陣列**——以前是 5 個具名 mesh 欄位、chunk-manager 有 5 處逐一列舉,加一種地物就得改 5 個地方、漏一個就洩漏。加地物現在只要在 specs 表加一列。
  - **機場**(`aeroway-renderer.ts`):跑道 30m / 滑行道 15m 灰帶 + 停機坪;每個 aerodrome 質心停一台玩具飛機(紙=繫留飛機氣球、積木=積木小飛機)。
  - **遠 chunk 線狀 overlay 隱藏(「天上一堆線」的真相)**(2026-07-24,`chunk-manager.update()` 尾段):走廊世界的本質限制——路線爬山的 chunk(南港/內湖段地形合法地到 136-340m)只有 ±500m 的窄走廊,從市區看過去**山體不存在、只剩爬山的路 ribbon+圍欄浮在空中**,幾十條微斜帶白虛線的黑線就是髮夾彎的側面(從 4 月起就存在,只是以前沒人從市區平地看向山區段)。修法(最終版):ring 距離 >1 的 in-scene chunk **只留地形本體**,其餘 overlay(路/圍欄/水/跑道/landuse/建築+屋頂裝飾/樹/窗燈)全部 `visible=false`——連續三輪 inventory 各抓到一類殘留(路→landuse 板→山坡屋頂板),一條規則終結打地鼠;用 `chunkMeshList` 迭代,未來新增 overlay 自動涵蓋。每幀在 update() 設定、零重建,騎近(±1)自動全部顯示。所有 chunk mesh + 導引線已命名(`chunk5/building`、`route/glow`),scene-inventory 傾印直接顯示身分。**最終兇手 = 導引線本體**:route/glow 是 4.2m 寬、透明度 0.28 的深紫 halo ribbon,26,688 頂點橫跨全程 45km、沿山脊爬到 y 193m,unlit(MeshBasic)在天空前讀作黑線——而且它是全域 mesh,豁免於所有 chunk 層級隱藏,所以連續七輪修復它紋絲不動。修法:`setRouteLineWindow`(geometry.setDrawRange,頂點沿路線排序、每段 6 index)只畫騎士 current chunk ±1 的區段,跨 chunk 時更新一次,近處引導功能不變。debug 另備「點擊驗屍」:點畫面任一像素 → raycast → 命中物件名字進 log+console(監聽掛 window 捕獲層,眼鏡框 overlay 吃不掉)。**點擊實測定論(2026-07-24)**:使用者點「黑線」命中的是 **1-32m 外、y 25-37 的自己 chunk 的地形**——爬坡髮夾彎的走廊疊層就在騎士身邊,而且相機曾距地形 1m=卡在幾何體內。→ **switchback 疊層消歧義修復**:`sampleChunkHeight`/`raycastGroundHeight` 加 `preferY`(騎士當前高度;首幀用 GPS 高程種子),同一 (x,z) 有多層走廊時選最近的那層,不再瞬移到錯誤的層/把相機塞進山壁。剩餘設計題:疊層走廊本身的視覺(山無實體)→ 側裙已到 chunkMin−6m,選項是把 baseY 壓到全 route 最低點讓山段成實心量體。**終局(headless CPU 渲染器定罪+驗證)**:`scripts/headless-check/render-probe.ts` 用正式管線蓋出 chunk 2-4+導引線,以騎士視角 CPU 光柵化成 PNG——**本地完整重現了「巨大黑色尖拱直插天空」**。根因:overlay 的 ground fn 在「爬坡走廊回頭跨過山谷」處撿到上層甲板的 150m 高度,馬路 ribbon 隨之射向天空。修法(渲染前後對照驗證):ground fn 以**該點原始 DEM 高程**選層(路躺在真實地面上,DEM 是單值真相),再加 **12m 理智檢查**——最近的層離真實地面仍超過 12m 就代表這裡只有高架甲板經過、沒有真的地面,直接裁掉。曾試「前一取樣點連續性」判層→**倒退**(錯誤會被鎖層拖著爬上尖刺),勿再嘗試。**「天上纜線」= 橋樑圍欄**(rail-only 渲染 pass 定罪):台北的數公里級高架(brunnel=bridge)每條都長了兩道 1.1m 細圍欄,幾十條貼地蜿蜒的細條側看=滿天電纜。`BRIDGE_RAILS_ENABLED=false` 停用生成(機制保留,未來可只給「短距離跨水橋」開圍欄)。
    **第二發點擊定罪**:近距離(24m)直接命中 `route/glow`——導引線投影頂點時沒做疊層消歧義,在髮夾彎區頂點一下投下層一下投上層,整條線在空中亂竄=騎士身邊的「黑線」;修法:`_routeGpsY`(每頂點 GPX 高程)作為投影的 preferY,線永遠貼在離 GPX 高度最近的那層。**第二回合發現**:landuse 平板才是「頭頂線」大宗——merged 後的水面/公園/urban 色塊是「一疊漂浮在各自質心高度的水平板」(爬山 chunk 內 y 7..340m),側面看每片=一條細線;由 debug 模式的 **scene/inventory 探針**(騎乘 20 秒後自動傾印全場景 bbox)定罪。相機俯角讓「地平線上方 3~18°」的內容出現在畫面上緣,體感=「在頭頂」。
  - **建築主體鏡射 bug(四月起潛伏)**(2026-07-24,`building-renderer.ts` `footprintToShape`):shape 存了場景座標的 z(已含負號),但 `rotateX(-90°)` 本身就把 shape-Y 映到**負的**世界 Z——雙重負號讓所有 MVT 擠出建築主體**沿原點東西軸鏡射到世界另一側**,而 OBB 裝飾(屋頂/窗戶/窗燈,直接用世界座標)留在正確位置。以前 Polygon-only 建築稀少沒人發現;MultiPolygon 修復後整座城市進來,症狀變成「屋頂懸浮沒身體 + 天空黑色大片(鏡射城市的背光牆)」。修法:shape 存 +lat 公尺並**反向走訪 ring**(鏡射會翻手性,反向走訪翻回來,cap 朝向/法線不變)。**這是家族性 bug**——同一個「shape 存場景 z + rotateX(-90°)」模式共三處:建築 `footprintToShape`、**landuse `buildFlatPolygon`(水面/公園/運動場/urban 色塊全部鏡射——「河濱公園沉入水底」其實是別處鏡過來的水面蓋在公園上)**、**aeroway `buildSlabGeometry`(鏡射的松山機場停機坪=地平線上的深灰大板)**,三處同款修復;`mountain-ring` 的 disc 是圓對稱不受影響。驗證工具:`scripts/headless-check/dazhi-repro.ts`(真實路段+真實 DEM+真實 MVT 走正式管線,掃描每個 mesh + instanced matrix 的 bbox/NaN/z 正負——就是它抓到 body 與 slab 的 z 全在鏡射側)。
  - **Bare-earth 壓平:市區幽靈高塔的根治**(2026-07-24,`chunk-manager` flatten 區段 + `elevation-sampler.correction`):terrarium DEM 在密集市區是**表面模型**——大樓高度被烤進地形柵格(台北實測 30-50m 假塔,河濱磚 maxEle 48m)。後果鏈:地形長出黑綠色高塔 → 馬路貼地爬上塔頂看起來像「飛天橋」 → 建築質心取樣到自己造成的 DEM 尖峰而浮空(只看得到屋頂)。修法:chunk build **先抓 MVT 再蓋地形**,把 padded bounds 內全部建築 footprint(不做 ownership 過濾——地形要跨 chunk 縫一致)註冊進全域 registry(質心 ~1m 去重),每個 footprint 的「街道地板」= ring 周邊 ~8 點取樣最低值;`sampler.correction` 掛勾把落在 footprint 內的所有 DEM 取樣 clamp 到地板——地形/建築/樹/水全部消費同一份 bare-earth。配套:**建築基座改踩地形網格**(`ground(質心)`,fallback 才用量化 DEM)+ 3m 地基裙;**build 期 ground fn 改 grid-only**(舊版走廊外取樣掉進真實 mesh raycast fallback,單 chunk overlayBuild 曾到 40-60 秒);ownership 索引預投影成 Float32Array。**Overlay 貼地規則(2026-07-24 最終版,開發者拍板)**:ribbon/建築的 ground fn 只查**自己 chunk 的 height grid**,不再 fallback 到鄰居 grid——貼鄰居會讓路伸出自己的綠色走廊、懸空跨到下一段走廊(「路從山體長出來」)。走廊外的段落直接裁掉,擁有那段的 chunk 會在它自己的地形上畫;代價是 chunk 縫隙處路可能有小斷口,可接受。**事後實測更正**:大直磚的 DEM 其實沒有想像中的高塔(>15m 只佔 9.9%,多為真實山坡),壓平的實測效果有限(footprint 內外差 p50 0.7m/p99 6.4m,僅 ~8% 建築差 >3m)——「黑色大片」的真兇是上面那條建築鏡射 bug。壓平保留(對 8% 的建築地基仍有 3-6m 的修平效果,成本低)。
  - **全部 landuse 平板 = 多點最低值 + 向下取整**(2026-07-24 推廣,原本只有水面):公園/urban/運動場等仍用「質心+round」時,市區 tread 0m 的地方平板會被入位到 6m——**整座城市蓋著一層懸浮 6m 的色塊天花板**:騎士騎進板子下面(穿模全綠)、每片板的背光邊緣=一條黑線(滿天細線的大宗、且無視地形穿山)。統一改 floor-min 後平板釘在「它碰到的最低 tread」:高 tread 處藏進地形下(正確的失敗模式,地形本身的顏色頂上)。
  - **水面高度 = 多點最低值 + 向下取整**(2026-07-23,`landuse-renderer.ts` `buildFlatPolygon` 的 `waterLevel` 模式):大水域 slab 原本只取質心一點高度再**四捨五入**量化——河心 3.2m 入成 6m、岸邊公園 2.9m 捨成 0m,實差 0.3m 被放大成 6m 反轉,河濱公園整片「沉入水底」。水面(僅 `water` layer)改為:沿 ring 取樣(~24 點)取**最低值**、下限 clamp「質心減一階」(擋 terrarium DEM 河道雜訊,該區 tile 實測有 −28m)、**floor 量化**(水面永不被入位到高於真實水位)。其他地物維持質心+round;waterway 線是貼地 ribbon 不受影響。
  - **MultiPolygon 建築修復**(2026-07-23,`building-renderer.ts` `extractBuildingsFromMVT`):z14 OpenMapTiles 會把相鄰建築合併成 MultiPolygon,而萃取器從四月寫成以來只認 `Polygon`——密集市區 95%+ 的建築(大直磚 1,342 棟、南松山磚 3,319 棟,含 161m 高樓)整批被跳過,「市區怎麼沒房子」就是它。現在逐子多邊形拆成獨立 footprint(共用該 feature 的高度),每棟走同一套 ownership + ground 檢查。配套:**建築預算改為畫質檔位參數** `maxBuildingsPerChunk`(low 800 / medium 2000 / high 3000,面積排序保留地標,取代原本的 3000 常數)——N100 低檔玩得動,高檔看完整城市;跟其他 geometry knob 一樣只影響之後新蓋的 chunk。
  - **橋樑 = 貼地道路 + 圍欄**(2026-07-23,`ribbon-geometry.ts` `buildGroundRibbonWithRails` + `road-renderer.ts`):`brunnel=bridge` 跟一般道路一樣**逐點貼地**,只多兩條 1.1m 圍欄(獨立 `railMesh`,素色材質,跟著路面高度走、跟 ribbon 同步斷開),離地 0.38m(略高於一般路 0.3m,立體交叉時橋壓在路上不 z-fight)。**曾實作過「兩端錨定+線性內插」的立體橋面**(含騎士 GPS 高程仲裁吸附),但多條平行/分層的橋各自錨定會疊出「雙層橋」假象——開發者拍板:玩具 diorama 不做 city skyline,橋=平面道路+圍欄,整套 deck 機制已拆除。
  - **Overlay 所有權去重**(2026-07-23,`chunk-manager` ownership 區段):每個 chunk 的 MVT 範圍外擴 ~500m,相鄰走廊重疊帶的地物以前會被**兩個 chunk 各蓋一份**(高度基準不同 → 一份埋地下 + z-fight)。現在「離哪個 chunk 的路段最近,誰蓋」(route point 空間網格查最近點,確定性、與載入順序無關):線類(路/水/跑道)**逐取樣點裁切**(兩邊各蓋自己那段、貼自己的網格,無縫),面/點類(建築/樹/landuse/停機坪/飛機)**整件歸屬**(質心判定)。
  - **廢除 ribbon fallback 高度公式**:probe 打不到(走廊外沒地形)就把 ribbon **斷開**,不再用「單點量化」公式亂補——它跟地形的「格平均量化」不是同一個函數,會差整整一階(塑膠 6m/紙板 12m),路一跨出走廊邊界就瞬間跳一層。建築質心 probe 打不到也直接跳過(不再浮空)。slab/飛機的質心 fallback 保留。
  - **隧道不畫幾何**,改用「一整排密集亮著的燈」表現(見上方街燈)。
  - 盤點對帳:rendered **28.5% → 38.3%**、fetched_ignored **1,126 → 323**。改 renderer 後請同步更新 `survey.mjs` 的 `classify()` 並重跑。
- **環境 zone 只染色、不調暗**(`cycling-glasses-effect.ts` `ZONE_MODIFIERS`):原本 tunnel 會把**整個畫面 ×0.45**、forest ×0.80。那是第一人稱的沉浸設計(你人在隧道裡);diorama 俯瞰玩具世界、世界裡根本沒有隧道幾何,畫面無故變黑就是 bug——**「有些地區突然變很黑」就是它**。而且後處理的亮度乘算是繞過 `day-night-lighting` 那條「不得比 demo 夜更暗」硬地板的後門。現在 `brightnessMul` 一律 1.0,只保留極淡 tint(forest 綠)。zone 偵測本身保留(鏡片痕跡等仍在用)。
- **EffectComposer 鏈尾必須有 `OutputPass`(「夜間全黑」的根因,2026-07-24)**:three r152+ 渲染進 render target 時**強制關閉 tone mapping、輸出維持 linear**(`getParameters` 裡 `currentRenderTarget !== null` → `NoToneMapping` + `LinearSRGBColorSpace`),而遊戲每一格都走 composer(RenderPass→Bloom→眼鏡→Tunnel→style)——鏈尾沒 OutputPass 就是「沒 ACES、linear 當 sRGB 直出」:白天陰影面壓成純黑、夜間整個 palette(linear ~0.05)直出=全黑,demo 直繪(`renderer.render()`)才正常,palette/floor 機制本身無辜。修法:眼鏡 composer 與無眼鏡 standalone postComposer 鏈尾都加 `OutputPass`(每格自動讀 `renderer.toneMapping`/`toneMappingExposure`,1.05 這時才真正生效);`setStylePass` 改 `insertPass` 插在 OutputPass 之前,**OutputPass 永遠是最後一個 pass**——未來新增任何 composer/pass 都要遵守。注意鏡片 tint/contrast 與紙後處理現在吃 linear 輸入,參數觀感若偏請直接調 preset。
- **天氣粒子 / 後處理**:`sky-and-fog.ts` 的雨雪雲星、`lightning-bolt.ts`、紙後處理沿用。
- **自檢**:`npm run check:3d` —— headless(Node + stub canvas,不開 WebGL)實際建出兩套皮的單車 / 遠山 / 街燈 / 金幣 / 建築裝飾,驗證幾何朝向、相機在騎手後方、遠山視差錨定、收尾盤畫序。WSL 可跑(繞開只裝了 Windows 版的 esbuild / rollup native binary)。
- **視覺規格來源**:`paper-town-demo.html` / `plastic-town-demo.html`(repo 根目錄)與 `plan/ref-demo-*-src.js`。

**2D 雙風格**（Phase 7 詳述）：
- **塑膠風**：3D 塑膠世界「壓扁」成 2D — 螢光配色、幾何形狀、CRT 掃描線覆蓋層
- **手繪風**：Cuphead 1930s 動畫風 — 搖擺墨線輪廓、水彩質感填充、斜線陰影、膠片噪點覆蓋層、復古暖色調（鼠尾草綠/暖奶油/磚紅）、64×64 橡皮管騎士
- 兩種風格共用相同 Strategy 介面（`PhaserStyleStrategy`），渲染器零耦合

**Cyberpunk 2077 UI**：
- 全域 CSS 變數定義在 `App.vue`：`--hud-cyan`、`--hud-yellow`、`--hud-magenta`、`--hud-glow-*`、`--clip-panel-*`
- 字型：`Orbitron`（標題/標籤）+ `Rajdhani`（內文）
- 面板斜切角（`clip-path: var(--clip-panel-*)`）取代圓角
- 霓虹光暈（`filter: drop-shadow`）、掃描線飄移動畫、故障閃爍標題
- Welcome 頁面 + Game HUD + 訓練摘要 均使用此風格

### 分區驅動建築（demo 已落地／`packages/` 未接）

**現況的缺口。** `landuse-renderer` 的 `isUrbanLanduse()` 認得 **11 種** class:

```
residential  commercial  industrial  retail
school  hospital  university  college  kindergarten  library  education
```

但 `URBAN_COLORS`(cartoon-materials.ts)只有 4 個 key,而且 `retail` 與 `commercial` 同色 ——
實際只畫得出 **3 種顏色**。其餘 **7 種**(school / hospital / university / college /
kindergarten / library / education)一律 `?? URBAN_COLORS.residential` fallback 成住宅
灰。**辨識了、抓進來了、投影成幾何了,然後畫成一模一樣。**

而且那個色是**整個 chunk 取眾數**(`getDominantUrbanColor`),不是逐多邊形上色。

建築更徹底:**建築與土地分區是兩條互不相通的管道**。兩者吃同一包 `mvtFeatures`,
但取不同 layer(建築 = `building`,分區 = `landuse` / `landcover` / `park`),而
`buildBuildingMeshes(footprints, sampler, origin×3, strategy, ground, routeDistanceAt)`
的參數裡**沒有一個欄位跟分區有關**。所以每個 style 只有一種建築本體(積木 = 疊片塔、
瓦楞紙 = 橡皮擦塊),連已經有專屬顏色的 `industrial` 都長得跟住宅一樣。

**改造路徑。** 關鍵是 `terrain-chunk-manager` 已經有 `registerUrbanZones(mvtFeatures)`
把 urban 多邊形抓出來了 —— 只是目前只留「是不是市區」拿去**壓平地形**(市區把 DEM 夾到
路線高度附近),沒留 class。所以這不是新增管道,是把既有的東西接出來:

1. `registerUrbanZones()` 順手保留 **class 與 ring**,建立 bbox 索引(多邊形已解過,不必
   重解 MVT)
2. `buildBuildingMeshes()` 多收一個 `zoneAt(lon, lat)` callback;bbox 先篩、再做點在多邊
   形內測試,逐棟一次,成本可接受
3. `TerrainStyleStrategy.buildBuildingBody(box, seed)` 加第三個參數 `zone`
4. 各 style 用 zone **偏移建築型別的抽樣機率**,不是硬對應 —— 分區「傾向」某種房子,混雜
   一點才像真的城市

第 1 步不改任何視覺,三個世界行為不變,可獨立驗證。

**分區建築對照(demo 已定案)。** 五種分區、五種形體語言,同一世界內不得撞號 —— 撞號的
定義不只是輪廓,**手感(材質)也算**:

| 分區 | 積木(玩具箱) | 瓦楞紙(評圖模型) | 電子(單晶片) |
|---|---|---|---|
| 住宅 | 黏土像素屋(方塊堆疊・霧面) | 橡皮擦屋(直角塊＋底部紙套) | 電解電容(套管圓柱) |
| 商業／零售 | 抽抽樂塔(橫條疊高・霧面彩色) | 彩色索引標籤片台(蓋沿一排標籤片＋分格視窗帶＋斜出片口) | 輝光管招牌(暖橘數字) |
| 工業 | 杯塔(梯形收分・半透明) | 膠帶台(厚底座＋捲軸＋鋸齒刀口) | 變壓器(矽鋼片疊層＋銅線圈) |
| 學校 | **字母積木**(矮寬一長排・浮凸字母) | 算盤(框＋彩珠橫向排列) | DIP IC(黑塑封・一排腳) |
| 醫院 | 骨牌牆(豎片並排・白底黑點＋紅三角) | 藥盒／OK繃盒(白底紅三角) | 白陶瓷封裝 DIP＋紅色 LED |

踩過的坑,別再走一次:

- **薄片會消失。** chase cam 的眼睛只在騎士上方 6.3 m(`fps-camera.ts` 的 `CHASE_UP`),
  側對騎手的薄片幾乎沒有面積。字母積木要排成有厚度的一長排、骨牌要排兩排以上、卡片類
  厚度不得低於 0.3。紙牌屋就是因此被換掉的。
- **鏤空會在天際線開洞。** 逆光或夜間整棟消失。量體一律實心。
- **手感撞號比輪廓撞號更難察覺。** 第一版三種建築有兩種都是硬亮面塑膠,遠看只像三個尺
  寸;換成黏土(霧面軟)之後才分得開。
- **一個元件只能有一個身分。** 電子世界的排針既然當了等高線疊層的裙邊,欄杆就得換成
  銅柱 —— 否則遠看兩處長一樣,詞彙量虛胖。
- **字母不要用系統字型。** 騎乘距離會糊,且跨機器不一致;用幾何線條自己畫。

**已實作 vs 已定案。** 這兩件事必須分開記,否則會出現「清單上寫著、實際沒做」
(純銅散熱鰭片就這樣漏了一輪)。落地前請以程式碼為準,不要以本表為準。

目前狀態(2026-07-26):

| 範圍 | 狀態 |
|---|---|
| `plan/*-demo.html` 六個 demo(3D×3、Phaser 2D×3) | **已實作** —— 上表五種分區、五種建築全部畫得出來,含分區取樣與空分區保底 |
| `packages/web` 真實遊戲 | **未接** —— 上面「改造路徑」四步一步都還沒動 |

demo 的分區取樣一律用 **Fisher–Yates 洗牌袋**,不是逐段獨立亂數 —— 獨立亂數在 8 km
尺度會嚴重偏斜(整段全是住宅)。落地時請沿用同一個作法。

**空分區要保底。** 「讀到分區但沒生出房子」跟「本來就是空地」在畫面上無法區分,但前者
是 bug。demo 用 `zoneSpans()` 取出每段的分區區間,若整段一棟都沒抽中,強制補一棟該分區
的主建築。circuit 世界實測:沒有保底時 72 格有 14 格空,加上之後 75 格 0 空。

**醫院符號用紅色三角形,不用紅十字。** 白底紅十字是日內瓦公約與各國國內法保護
的標誌,遊戲裡當醫院圖示雖然常見,但它是受保護標誌而非通用符號。三角形辨識度
足夠且無此問題。

**版權。** 一律取通用玩法／通用封裝外型,不印廠牌字樣、料號、商標或包裝圖騰;配色走
`themes.scss` 色票。疊紙牌屋、交叉堆疊抽取式積木塔、骨牌、字母積木、算盤、JEDEC 封裝
外型皆為公共領域或通用形制。**meeple 的人形剪影有具體權利人,不使用**(checkpoint 用
傳統車床輪廓的棋子)。

---

### 建築的燈歸建築所有(要改 `packages/`)

**現況是錯的。** `building-renderer.ts` 的 `collectFacadeWindowPlacements()` 拿建築的 OBB,
用 `box.width / colSpacing` 切欄、`box.height / rowSpacing` 切列,在 ±z 兩個面上蓋一格窗戶
的網格,再用 `skipProb` 挖幾格讓它不要太整齊。**它完全不知道自己蓋在什麼東西上。**

分區驅動建築一落地,這件事會立刻變得很難看:抽抽樂塔、黏土像素屋、杯塔、骨牌牆、字母
積木、輝光管招牌、DIP IC、電解電容、橡皮擦、標籤片台、膠帶台、算盤、藥盒 —— 十三種
形體,會被蓋上**同一種**小方格。電容不該有窗戶;IC 不該有窗戶;骨牌的窗戶就是它自己的
點;抽抽樂塔的窗戶就是**那些方形的短面**(每層交錯 90°,短面本來就露在外面、本來就在對
的位置)。

**規則:決定形體的那個東西,必須同時決定燈。** 把兩者拆開,就會做出「有窗戶的電容」。

demo 裡已經有兩個做對的例子可以照抄:
- 黏土像素屋:「窗是**換色不是挖洞**」—— 第二層前後各兩格換成亮黃的體素。
- 骨牌牆:「骨牌上的**點就是窗**」。

**介面改法**(跟分區驅動建築的四步一起做,它們是同一條管道):

```ts
/**
 * 這棟建築的燈在哪。回傳的座標系跟 buildBuildingBody() 完全相同(box 的區域
 * 座標),由建築 renderer 批次成一個 InstancedMesh。
 *   - 回傳空陣列 = 這種建築沒有燈(電容、IC、橡皮擦)。
 *   - 省略這個 hook = 退回 facadeWindows 的通用網格。
 */
buildBuildingLights?(box: BuildingBox, seed: number, zone: ZoneKind): WindowPlacement[];
```

`facadeWindows` **降級成「沒有 matchbox 主體時的退路」** —— 也就是只服務直接擠出 MVT
footprint 的那條舊路徑,不再蓋在每一個主題造型上。`building-renderer.ts:391` 那個
`if (strategy.facadeWindows)` 要改成「先問 `buildBuildingLights`,沒有才退回網格」。

**先在 demo 做,再移植。** demo 是這件事的規格:每種分區建築在 demo 裡自己宣告夜間的燈,
移植的人照著接就好,不必重新設計十三種建築的燈長在哪。

---

### 招牌、壓克力罩、bloom、電流脈衝(demo 規格)

四項跨六個 demo 的共用規格。**六個 demo 必須用同一套機制**,只有「載體」不同 ——
不然三個世界會長出三套互相衝突的招牌邏輯,移植時要重寫三次。

#### 招牌

**共用機制(六個 demo 完全一致):**

| 項目 | 規則 |
|---|---|
| 掛在哪 | 商業／零售分區的建築,面向路線那一側;學校與醫院各掛一塊(識別符號) |
| 不掛 | 住宅、工業 |
| 比例 | 固定 **3:1**(寬:高)—— 三個世界載體不同但比例相同,遠看才是「同一種東西」 |
| 寬度 | `min(建築寬 × 0.8, 上限)`,不得比建築寬 |
| 掛高 | 建築高度的 **0.55–0.7** 之間 |
| 傾角 | 向下傾 **8°** —— 騎士眼睛在 6.3 m,平掛的招牌看不到 |
| 內容 | 最多 **4 個字符**,字高 ≥ 招牌高的 0.55,筆畫寬 ≥ 字高的 1/8 |
| 字形 | **幾何筆畫網格,不可用系統字型**(騎乘距離會糊,跨機器不一致) |
| 分區內容 | 商業 = 2–4 字母的假店名(決定性 RNG 從固定詞庫抽);學校 = `ABC`;醫院 = 紅色三角形 |
| 配色 | 底 = 該世界該分區色票,字 = 該世界的 ink 色 |

**各世界的載體**(不可互換 —— 每個都必須是那個世界貨架上**還沒被用掉**的東西):

- **瓦楞紙 → 標籤機浮凸標籤帶**(圓角長條、壓紋的白色浮凸字、底色是塑膠帶)。
  *不用便利貼*:商業分區的建築本體已經在用同一批螢光色紙,撞號。
- **積木 → 玩具組附的貼紙**(印刷貼紙貼在一塊平板上,**貼歪 3–6°**、一角有氣泡、四周留白邊)。
  *不用字母積木*:字母積木已經是學校建築,撞號。貼紙是平的印刷品,凸字是立體的,分得開。
- **電子 → 電子紙模組**(霧面灰白底、純黑字、極細黑框、側邊一條 FPC 排線接到建築)。
  **不發光** —— 這是它跟輝光管(商業建築本體)的分工:輝光管發橘光,電子紙是反射式的,
  夜裡靠路燈照。反射式正是電子紙的物理特性,順便讓兩者不撞號。

#### 壓克力罩天空

整個世界是**擺在桌上的模型**,所以它罩在一個壓克力罩底下。三個世界都成立:評圖模型本來
就收在壓克力罩裡、玩具是展示盒、電路板是防塵/防靜電罩。

- 半徑放在**遠山圈之外**(瓦楞紙的遠山在 640,罩子取 900–1000),高度到天頂。
- `side: BackSide`、很低的不透明度、輕微染色。既有的天空球(r=1100 的 `skyMat`)**保留**,
  罩子疊在它內側。
- 要看得到它**是一個罩子**,不能只是一層染色:底部與桌面交界要有一圈**較厚的壓克力邊**
  (不透明度higher 的帶),頂部曲面要有一兩道**長條高光**(壓克力罩一定有的那種反光)。
- **天氣 = 染色 + 扭曲**:雨天罩子外側起水珠(較冷的染色 + 一層流動的水痕),既有的世界內
  降雨保留不動。

#### bloom

**不是三個世界都要。**

| 世界 | bloom | 理由 |
|---|---|---|
| 電子 | **強**(夜間) | 走線、輝光管、LED —— 這個世界的識別性就是發光 |
| 積木 | **很弱**,只在夜間 | threshold 拉高,只讓路燈與金幣的高光溢出 |
| 瓦楞紙 | **不做** | 廣告顏料不會發光。加了就不是這個世界了 |

**demo 的 three.js bundle 裡沒有任何後製 addon**(實測三個世界皆為
`EffectComposer=0 UnrealBloomPass=0 OutputPass=0 RenderPass=0 ShaderPass=0 CopyShader=0`),
所以走不了 `EffectComposer` 那條路。也**不可以**自己貼一份 addon bundle、不可以從 CDN 載
(離線 + 外部相依)、不可以 `npm install`(專案規範禁止)。

**改成用 three core 手刻最小 bloom**:`WebGLRenderTarget` + 全螢幕 quad + `ShaderMaterial`
→ 場景進 RT → bright-pass(半解析度)→ 可分離高斯模糊水平/垂直各一次 → 加法合成。
兩級就夠;`UnrealBloomPass` 的五級 mip 對這幾個世界是浪費,而且目標機是 N100。

**兩個一定會踩的坑:**

1. **最後那個合成 pass 必須自己做 sRGB encode**(或把 RT 的 `texture.colorSpace` 設對)。
   three r152+ 對 render target 不做 tone mapping / sRGB 轉換 —— 這正是 `OutputPass` 原本
   在補的事。漏掉的直接後果是**夜間全黑**。驗收要實際比對「有 bloom vs 沒 bloom」的夜間
   亮度,不能只看有沒有光暈。
2. **不可以把 `renderer.render(scene, camera)` 換掉。** headless probe 是靠攔截
   `renderer.render()` 拿到 scene 的,改成只呼叫 composer 會讓四個 demo 全部驗不了。
   作法:composer 建立包在 try/catch 裡,失敗就 `usePost = false`,animate 迴圈走
   `usePost ? composer.render() : renderer.render(scene, camera)`。headless 一定走後者。
   這同時也是 N100 的低階退路,不是只為了測試。

#### 踏頻 → 電流脈衝(只有電子世界)

- **踏頻決定脈衝的行進速度**,**功率決定亮度**。
- demo 沒有真實感測器,用 UI 滑桿模擬:踏頻 **60–110 rpm**、功率 **80–320 W**。
- 必須跟既有的 `applyDayNight(k)` 與 `powerOn` **相乘**,不是取代 —— 斷電時不管踩多用力
  都不會亮。
- 2D 版用同一組映射。

---

---

## 外部資料源與版權（圖資 / 地形 / 天氣）

> 以下為目前實際使用的外部資料源，**皆已確認授權乾淨**（免費 / 開放授權，無 API key，無商業盜用）。
> 新增或更換任何圖資 / 地形 / 天氣來源前，務必先確認版權並取得開發者同意 —— 見 CLAUDE.md「外部資料源版權規範」。

| 用途 | 來源 | Endpoint | 授權 | 署名處 |
|------|------|----------|------|--------|
| 向量底圖 + 樣式 | **OpenFreeMap**（資料為 OSM） | `tiles.openfreemap.org/styles/*`、`/planet` | 免費公開實例;資料 OSM **ODbL** | 設定面板 Data Sources |
| 3D 地形高程（DEM） | **AWS Terrain Tiles**（Terrarium 編碼,底層 SRTM/GMTED 等） | `s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` | AWS Open Data,免費 | 設定面板 Data Sources |
| 即時天氣 / 風 | **Open-Meteo** | `api.open-meteo.com/v1/forecast` | 免費(**僅限非商用**);資料 **CC-BY 4.0** | 設定面板 Data Sources |
| 路線 GPX | **EuroVelo** | `en.eurovelo.com/route/get-gpx/{id}` | **ODbL** | 路線目錄抽屜 + 匯出 GPX metadata |
| 字型 | **Google Fonts**（7 字族） | `fonts.googleapis.com/css2?family=…`、`fonts.gstatic.com` | **OFL-1.1**（皆為開放字型授權） | 不需畫面署名（OFL 無此要求） |

- 署名字串集中定義於 `packages/shared/src/attributions.ts`(`DATA_ATTRIBUTIONS`),由後端經 `/api/config` 注入、前端只 render;EuroVelo 走 catalog API(`eurovelo-catalog.ts`)。
- **明確禁用**:OpenStreetMap 官方 raster 圖磚伺服器 `tile.openstreetmap.org` —— 其 [Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/) 禁止遊戲這類重度 / 高頻自動化取圖(會被封 IP)。底圖一律走 OpenFreeMap。
- **商業化注意**:Open-Meteo 免費授權僅限非商用;若日後商業化,天氣來源需改付費訂閱或換供應商。
- **字型**:`packages/web/index.html` 自 Google Fonts CDN 載入 Orbitron / Rajdhani / Fredoka / Quicksand / Cabin Sketch / Patrick Hand / Noto Sans TC,皆 OFL-1.1 且**非 vendored**(repo 內零字型檔),故無散布疑慮。OFL 不要求畫面署名。

### 已評估之合規判斷(勿重複稽核)

以下項目曾被稽核提出,經評估後**維持現狀**,理由記錄於此以免日後重複討論:

- **OSM / OpenFreeMap 署名位置**:署名位於 Welcome 畫面設定抽屜的 Data Sources 區塊(`SettingsPanel.vue`,讀 `DATA_ATTRIBUTIONS`),遊戲畫面(threejs / phaser 模式)無常駐署名。**判定合規**:ODbL §4.3 的要求是「a notice reasonably calculated to make any Person... aware」——標準是「合理可知」,**未規定畫面浮水印**;OSMF Attribution Guidelines 的角落署名慣例係針對「可瀏覽地圖」,對 app / 遊戲這類 Produced Work,credits / about 類位置一般可接受。Welcome 為每次騎乘必經畫面且署名一鍵可達,故符合。(注意 `SettingsPanel` 僅掛載於 `WelcomeView.vue`,遊戲進行中不可達——已知且接受。)

### FIT encoder:已移除 Garmin SDK 相依

**決策**:`@garmin/fitsdk`(專有)已由 `@markw65/fit-file-writer`(MIT、零執行期相依)取代。相依樹自此 100% 開源,使用者不再於 `npm install` 被迫接受 Garmin 條款,亦解除 Garmin §2(c)「不得散布 SDK 給第三方」對日後打包(Docker / Electron / pkg)的封鎖。

**替換前的驗證**(2026-07,ride 43 / 11,402 samples / 33.6 min / 8300 m):
- 兩個 encoder 輸出皆為決定性(各跑兩次 MD5 穩定)。
- 逐欄位比對:2005 筆 records 在 timestamp / power / heart_rate / cadence / speed / distance **六個序列零差異**;session / lap / activity 純量欄位全數相同(含 Strava 關鍵的 `total_elapsed_time` = 2017.601、`total_distance` = 8297.84,均非 0)。
- Strava 實測接受 candidate;隨後上傳 baseline 被以 **duplicate** 拒絕 —— 等於 Strava 自身 parser 確認兩檔為同一場活動。
- MD5 不同屬正常(definition message 的 local type 分配、CRC 連動等合法編碼差異),不可作為判準。

**兩個必須留意的 markw65 特性**(已在 `fit-exporter.ts` 以註解標示):
1. **scaled field 截斷而非四捨五入** —— `writeFieldValue` 以位元遮罩寫入(ToInt32),使每個 scaled float 低 1 LSB。故 caller 端以 `q()` 預先四捨五入補正。若 markw65 日後改為四捨五入,`q()` 會反過來使值高 1 LSB(誤差 0.001 m/s / 0.01 m,無害,但屆時應移除 `q()`)。
2. **無 `antplus_device_type` 欄位** —— 該欄在 FIT profile 是 `device_type`(num 1) 的 subfield,markw65 僅解析 base field map。改寫 base field `device_type` 同一數字碼,解碼語意正確。
   **附帶修正**:舊版 `mesg.antplusDeviceType = antType` 其實是 **no-op**——Garmin SDK 靜默丟棄該欄位(已用 fit-file-parser 確認舊輸出完全無 `device_type`)。新版會正確寫入,屬修正而非回歸。

## 注意事項

- **WSL vs Windows**: ANT+ stick 是 Windows USB 裝置，Node server 必須在 Windows 上跑
- **驅動衝突**: ANT+ stick 同時只能被一個 app 使用（跑 recorder 時 Zwift 不能用）
- **Node >= 20**: Ink v6 要求
- **感測器休眠**: 速度/踏頻感測器需要轉動輪組或曲柄才會醒來
- **驅動問題**: 如果遇到 `LIBUSB_ERROR_NOT_SUPPORTED`，用 Zadig 換成 WinUSB

## JSONL 錄製格式

```jsonl
{"type":"session_start","ts":"...","tsEpoch":...,"stickInfo":{...},"sensors":[...]}
{"type":"data","ts":"...","tsEpoch":...,"elapsed":1234,"profile":"HR","deviceId":12345,"data":{...}}
{"type":"data","ts":"...","tsEpoch":...,"elapsed":1500,"profile":"SC","deviceId":67890,"data":{...}}
{"type":"session_end","ts":"...","tsEpoch":...,"elapsed":1800000,"totalRecords":5400}
```

`elapsed` 欄位（毫秒）是 replay 時控制時序的關鍵。

---

Kelunyang@2026 by claude with :heart: | [GitHub](https://github.com/kelunyang/littleCycling)
