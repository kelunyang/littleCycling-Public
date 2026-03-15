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

**Attribution：** `Route data © EuroVelo (eurovelo.com), available under ODbL`

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
- **FTP 結構化訓練系統** — 可選 5 種內建訓練模式，HUD 分段進度條 + 3D checkpoint flag + 訓練摘要
  - **訓練模式**（`shared/src/workouts.ts`）：Sweet Spot / VO2max / Endurance / FTP Test / Tabata，每個 profile 用百分比時間定義分段，依使用者設定的總時長等比縮放
  - **分段顏色方案（Cyberpunk）**：熱身冷藍 `#4a90d9` / Recovery 螢光綠 `#00e676` / Endurance 穩定綠 `#66bb6a` / Sweet Spot 琥珀黃 `#ffab00` / Threshold 螢光橘 `#ff6d00` / VO2max 警報紅 `#ff1744` / Sprint 螢光紫 `#d500f9`
  - **HUD 分段進度條**（`HudBottomLeft.vue`）：每段按時長比例佔寬度、當前段斜線 hatch pattern（`repeating-linear-gradient` 白色半透明條紋 + `stripe-scroll` 動畫）、三角形游標（`--hud-cyan`）隨 elapsedMs 滑動、下方顯示分段名 + 目標 %FTP → 瓦數
  - **訓練追蹤**（`composables/useWorkoutTracker.ts`）：追蹤 currentSegment / segmentIndex / targetWatts / isOnTarget（±10%），分段切換觸發 `segmentChanged` → NES 音效
  - **3D Checkpoint Flag**（`game/terrain/checkpoint-flag.ts`，僅 Three.js 模式）：InstancedMesh 圓柱 pole + 彩色旗幟 mesh，放置在分段邊界對應路線位置，騎手經過後 fade 至 0.2 透明度
  - **GameSummary 訓練結果**：顯示 workout 名稱 + 整體達標評等 + 各分段 target FTP% → 瓦數
  - **Welcome 頁面選擇器**（`StartChecklist.vue`）：el-select Workout Mode（6 選項含 Free Ride）+ 分段預覽色條 + 描述文字
  - **gameStore 整合**：`selectedWorkoutId` / `workoutSegments`，`startGame()` 時 `buildWorkoutSegments()` 展開，`reset()` 清空
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

---

### Phase 7: Phaser.js 2D Excitebike 橫軸清關遊戲模式 🔲 規劃中

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
| **3D 場景渲染** | 塑膠玩具世界 | `MeshToonMaterial` 離散色階塑膠光澤、螢光噴漆配色、簡潔幾何建模、卡通日夜循環（永遠明亮） |
| **2D 場景渲染** | 塑膠風 / 手繪風（可切換） | Strategy 模式雙風格：塑膠風延續 3D 霓虹配色，手繪風為 1930s Cuphead 風格（搖擺墨線 + 復古暖色） |
| **UI / HUD** | Cyberpunk 2077 | 深色底 + 霓虹青/黃/品紅光暈、Orbitron 字型、大寫字距、斜切角 `clip-path`、掃描線動畫、故障閃爍 |

**3D 塑膠玩具世界**（Phase 4.5 詳述）：
- 建築是螢光色方塊、道路是平滑帶狀、水面有果凍動態
- Perlin noise 地形色彩變化（螢光綠 / 酸黃 / 噴漆橘）
- 不使用衛星圖磚貼圖，完全程序化 vertex color

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

---

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
