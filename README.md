# littleCycling

一個類 Zwift 的個人自行車小遊戲。紅色球球以 FPS 視角在真實 3D 地圖上沿 GPX 路線滾動，速度由感測器驅動。

## 架構

Monorepo 結構，使用 npm workspaces：

```
littleCycling/
├── packages/
│   ├── server/    — Node.js 後端（ANT+/BLE 感測器、WebSocket、Replay、SQLite）
│   ├── web/       — Vue 3 前端（3D 地圖遊戲）
│   └── shared/    — 前後端共用型別、常數、功率曲線、感測器解析
├── data/          — JSONL 錄製檔、SQLite DB、路線、設定
└── DEVPLAN.md     — 完整開發計畫與規格
```

**資料流：**
```
感測器 (ANT+/BLE) → Server (WebSocket) → Web 前端 (3D 遊戲)
                        ↕
                  packages/shared
```

## 技術棧

| 層級 | 技術 |
|------|------|
| 後端 | Node.js + TypeScript, Fastify, WebSocket |
| 感測器 | incyclist-ant-plus (ANT+), noble (BLE) |
| 終端 UI | Ink v6 (React for CLI) |
| 前端 | Vue 3 + Vite + Pinia |
| 3D 地圖 | MapLibre GL JS + OpenFreeMap + AWS Terrain Tiles |
| 3D 球球 | Three.js (MapLibre custom layer) |
| 圖示 | Font Awesome |
| 時間處理 | dayjs |
| AI 教練 | LLM agentic 工具鏈（自帶 API key）；支援 Anthropic (Claude) 與 OpenAI 相容端點（OpenAI / DeepSeek / 本地 Ollama 等） |
| 資料庫 | SQLite |
| 反向代理（選用） | Caddy |

## 環境需求

- **Node.js >= 20**
- **Caddy**（**選用**）— 反向代理，統一前後端與 WebSocket 入口。**開發時不需要**：Vite dev server 已內建 proxy（`/api` 與 WebSocket 都轉發到後端 `:8765`），開 `http://localhost:5173` 即可。只有想要一個 production-like 的統一入口（`:3000`）時才需要，見「Caddy 反向代理（選用）」一節。
- **ANT+ Stick**: Garmin ANT+ Stick 2（需安裝 WinUSB 驅動，透過 Zadig）
- **執行環境**: ANT+ 相關功能須在 **Windows** 上執行（非 WSL），前端開發可在 WSL 進行

## 快速開始

### 1. 一鍵安裝 + 建置（推薦）

在專案根目錄執行，會依序完成安裝依賴與建置所有套件（shared → server → web）：

```bash
npm run setup
```

> **每次 `git pull` 之後也請重跑 `npm run setup`**：`dist/` 不進版控，原始碼更新後若沒重新 build，後端／前端會抓到舊的 `@littlecycling/shared` 而報 `has no exported member`。此指令是冪等的，相依沒變時 `npm install` 幾乎瞬間完成。

<details>
<summary>或分兩步手動執行</summary>

```bash
# 安裝依賴（會編譯 better-sqlite3 / noble 等 native module，須在對應平台執行）
npm install

# shared 套件需先編譯，後端和前端都依賴它（shared → server → web）
npm run build
```

</details>

### 2. 啟動後端 (Server)

後端有多種啟動模式：

```bash
# 啟動完整 Server（WebSocket + REST API）
npm run server -w packages/server

# 啟動 Ink 終端儀表板（互動式錄製介面）
npm run start -w packages/server

# 純錄製模式（CLI）
npm run record -w packages/server

# Replay 模式（用錄製檔驅動「後端完整模擬」，不需實體感測器；見下方「沒有感測器的快速體驗路徑」）
#   在專案根目錄執行：npm run replay

# BLE 心率測試
npm run ble:test -w packages/server
```

> **注意**: 涉及 ANT+ Stick 的指令必須在 **Windows PowerShell / Terminal** 中執行，不能在 WSL 中執行。

### 3. 啟動前端 (Web)

```bash
# 開發模式（Vite dev server，支援 HMR）
npm run dev -w packages/web

# 正式建置
npm run build -w packages/web

# 預覽建置結果
npm run preview -w packages/web
```

### 4. 一鍵啟動開發模式

`npm run dev` 會同時啟動所有服務（shared watch + server + web），並顯示 Ink 儀表板。**預設不啟動 Caddy**（不需要）：

```bash
# 一鍵啟動（不含 Caddy，開發推薦）
npm run dev

# 額外一起啟動 Caddy 反向代理（選用，:3000 統一入口）
npm run dev:caddy
```

儀表板會顯示每個服務的狀態（starting / ready / error）、即時感測器數值，下方即時輸出所有服務的 log。按 **`Ctrl+C`** 停止所有服務。

開啟 `http://localhost:5173` 即可使用。一鍵模式會另起一個內部 dev proxy（`:8770`），Vite 的 `/api` 與 WebSocket 都經由它轉發到後端 live server（`:8765`）。若有加 `--caddy`，也可改開統一入口 `http://localhost:3000`。

**用錄製檔重播（不需感測器）**：把 `npm run dev` 換成 `npm run replay -- <file.jsonl>`（省略檔名則自動挑最新的一支），後端會用該錄製檔驅動完整遊戲模擬（見「沒有感測器的快速體驗路徑」）。

### 5. Caddy 反向代理（選用）

開發時**不需要** Caddy——Vite dev server 已內建 proxy 統一前後端與 WebSocket。只有想要一個 production-like 的單一入口時才用它。

啟動後 Caddy 將前端（:5173）和後端（:8765）統一代理到 `:3000`：

- `/api/*`、`/ws/*` → 後端 Fastify（:8765）
- 其餘請求 → 前端 Vite dev server（:5173）

如需自訂設定，可複製一份自用：

```bash
cp Caddyfile.example Caddyfile
# 編輯 Caddyfile（已被 .gitignore 忽略）
caddy run --config Caddyfile
```

也可以直接使用範例檔啟動：

```bash
caddy run --config Caddyfile.example
```

正式部署時，編輯 Caddyfile 切換為 static file serving（參見檔案內註解）。

### 6. 手動分別啟動

如果不想用一鍵模式，也可以開 4 個 Terminal 分別啟動：

```bash
# Terminal 1 — 編譯 shared（watch 模式）
npm run dev -w packages/shared

# Terminal 2 — 啟動後端 server
npm run server -w packages/server

# Terminal 3 — 啟動前端 dev server（開 http://localhost:5173 即可用）
npm run dev -w packages/web

# Terminal 4 —（選用）Caddy 反向代理，想要 :3000 統一入口時才需要
caddy run --config Caddyfile.example
```

如果沒有實體感測器，改用 **server `--replay`**——讓後端用錄製檔跑完整遊戲模擬。把上面 Terminal 2 的 server 換成帶 replay 的版本即可（其餘 Terminal 不變，Vite 預設就打 `:8765`）：

```bash
# Terminal 2（改）— 後端用錄製檔驅動模擬，取代 live server
cd packages/server
npx tsx src/server.ts --replay ride-7-2026-07-10T07-28-59.jsonl   # 裸檔名會自動去 data/sessions/ 找
```

> 也可直接用一鍵模式的 replay：在專案根目錄跑 `npm run replay -- <file.jsonl>`（一次起 shared + server[replay] + web + dev proxy）。

### 路線匯入

**方式一：網頁上傳**

在歡迎畫面點「上傳」按鈕，選擇 GPX / TCX / FIT 檔案即可匯入。

**方式二：Auto-import（直接放檔案）**

將 GPX / TCX / FIT 檔案直接放入 `data/routes/` 目錄，Server 啟動時會自動掃描並匯入：
- 支援格式：`.gpx`、`.tcx`、`.fit`
- 匯入成功後，原始檔案會移至 `data/routes/imported/`
- 匯入失敗（無路線點）的檔案會被跳過，不影響其他匯入

**方式三：EuroVelo 路線目錄**

歡迎畫面的「EuroVelo」tab 可瀏覽並下載歐洲長途自行車路線（ODbL 授權），下載後自動出現在路線列表。

## 開發階段

| Phase | 內容 | 狀態 |
|-------|------|------|
| 1 | ANT+ 記錄器（CLI 錄製感測器資料到 JSONL） | ✅ 完成 |
| 2 | Replay Server（WebSocket 回放 JSONL） | ✅ 完成 |
| 3 | Ink 終端儀表板（互動式錄製 UI） | ✅ 完成 |
| 4 | 前端遊戲（Vue 3 + MapLibre + Three.js） | ✅ 完成 |
| 4.5 | Three.js 獨立地形渲染（塑膠玩具風格） | ✅ 完成 |
| 5 | 訓練紀錄（SQLite 儲存歷史） | ✅ 完成 |
| 6 | Live 整合模式 + FIT 匯出 | ✅ 完成 |
| 7 | Phaser.js 2D 橫軸捲軸遊戲模式（塑膠風/手繪風雙風格） | ✅ 完成 |
| 8 | AI 教練（LLM agentic 工具鏈、課表/報告入 SQLite、Markdown 渲染） | ✅ 完成 |

## 遊戲特色

- **真實 3D 地圖**：OpenFreeMap 向量地圖 + AWS 地形高程 + 3D 建築物（河流、機場跑道、隧道路燈等程序化細節）
- **雙手繪主題**：**糖果玩具風**（MeshToonMaterial 離散色階 + 螢光噴漆配色）與 **復古手繪風**（1930s 橡膠管動畫、瓦楞紙質感），完全程序化渲染，跨 Three.js / Phaser 兩種模式
- **GPX 路線**：支援上傳 GPX/TCX/FIT，或從 EuroVelo 目錄下載歐洲長途路線
- **感測器驅動**：ANT+ 速度/踏頻 + BLE 心率，支援虛擬功率估算
- **金幣系統**：依心率區間獎勵金幣，combo 倍率機制，鼓勵穩定配速
- **Cyberpunk HUD**：霓虹風格即時顯示心率、速度、踏頻、功率、金幣
- **雙模式**：軌道模式（沿 GPX 路線）或自由漫遊（需雙邊功率計）
- **FTP 結構化訓練**：5 種內建訓練模式 + HUD 分段進度條 + 3D checkpoint flag
- **天氣系統**：Open-Meteo 即時天氣 + 動態日夜循環 + 雨雪粒子
- **騎行風鏡**：5 種鏡片模式 + 隧道視覺效果 + 區域照明
- **NES 音效**：純 Web Audio API 合成，零音檔零依賴
- **Picture-in-Picture**：Document PiP 浮動視窗，邊騎車邊看影片
- **訓練行事曆**：雙月檢視 + d3.js 統計圖表 + FIT 匯出至 Strava
- **雷達圖對比**：本次騎乘 vs 同路線歷史 PB 五軸雷達圖
- **AI 教練**：LLM agentic 工具鏈，透過一組唯讀分析工具（騎乘歷史、FTP 趨勢、zone 分布、課表 compliance、HR drift…）讀你的訓練資料庫，產出個人化課表與報告（Markdown 渲染，課表/報告存進 SQLite、可視覺化）；自帶 API key，provider 在設定面板自訂

詳細規格請參閱 [DEVPLAN.md](DEVPLAN.md)。

## License

本專案原始碼以 **CC-BY-SA 4.0** 授權。

**相依樹 100% 開源**：全部套件皆為 permissive license（MIT / ISC / BSD-2 / BSD-3 / Apache-2.0），無任何 GPL / AGPL / LGPL / SSPL / 商用限制授權，亦無專有套件。

### 刻意避開 Garmin FIT SDK

FIT 檔的讀寫**完全不經過 Garmin 的專有 SDK**：匯入用 `fit-file-parser`（MIT）、匯出用 `@markw65/fit-file-writer`（MIT），兩者皆為開源的 clean-room 實作。

本專案**不使用、不相依、也不散布** `@garmin/fitsdk`。使用者 `npm install` 時不會取得該套件，因此**無須接受 Garmin 的專有授權條款**（其條款明訂「BY USING THE LICENSED TECHNOLOGY, YOU SIGNIFY YOUR AGREEMENT」，並禁止將 SDK 轉散布給第三方）。這也讓本專案日後若要打包散布（Docker / Electron 等）不受該條款封鎖。

> **若遇到 FIT 匯出的問題（檔案無法產生、Strava 或其他平台拒收、數據異常），請聯絡開發者**，不要改用 Garmin SDK 繞過——那會讓上述的授權乾淨度失效。回報時請附上該筆騎乘的 ride id 與平台的錯誤訊息。

外部資料源（圖資 / 地形 / 天氣 / 路線 / 字型）的授權與署名見 [DEVPLAN.md「外部資料源與版權」](DEVPLAN.md)。

---

## AI 輔助安裝指南（給 AI 助手的補充資訊）

以下資訊專門提供給 AI 助手（如 ChatGPT、Claude、Copilot 等）引導使用者安裝和排錯。

### 最低需求

- **Node.js >= 20**（必要）
- **作業系統**：Windows 11（ANT+ 感測器功能）；前端開發可在 macOS / Linux / WSL 進行
- **瀏覽器**：Chrome 或 Edge（推薦）。PiP 浮動視窗功能需要 Chrome/Edge 116+，Firefox / Safari 不支援

### 沒有感測器的快速體驗路徑

大多數使用者不會有 ANT+ stick 和自行車感測器。請引導他們使用 **Replay 模式**——把一段內建錄製檔餵進後端，由**後端跑完整遊戲模擬**（虛擬速度、金幣、zones 全部照真實騎乘計算）。

```bash
npm run setup           # 安裝依賴 + 建置所有套件（clone 後、以及每次 git pull 後都跑這個）

# 一鍵啟動，並用錄製檔驅動後端模擬（shared + server[replay] + web + dev proxy）
npm run replay                                       # 自動挑 data/sessions/ 最新的一支
npm run replay -- ride-7-2026-07-10T07-28-59.jsonl   # 或指定某一支
```

開啟 `http://localhost:5173` 即可看到遊戲畫面自動重播。錄製檔放在 `data/sessions/`，傳**裸檔名**即可（會自動解析）；可加 `--replay-speed 2`（加速）或 `--replay-loop`（循環）。

> ⚠️ **請用 `npm run replay`，不要用 `npm run dev -- --replay <file>`**：root 的 `dev` 是 `npm run dev:all -w packages/server` 的兩層 workspace 轉發，npm 會把 `--replay` flag 吃掉（只剩檔名當裸參數，replay 不會啟動）。`replay` 是單層轉發，所以 `--` 後的參數會完整傳到 dev-runner。

### 使用的 Port

| Port | 用途 | 服務 |
|------|------|------|
| 5173 | Vite 前端 dev server（**開發預設入口**，proxy 含 /api 與 WebSocket） | packages/web |
| 8765 | live server：WebSocket + REST API（`--replay` 也在此埠，驅動後端模擬） | packages/server |
| 8766 | 舊 replay server（`/ws/replay`，只丟原始 frame、**繞過模擬**，已不建議） | packages/server |
| 8770 | 一鍵模式的 dev proxy（Vite → 這裡 → 8765 或 8766，自動切換） | dev-runner |
| 3000 | Caddy 反向代理統一入口（**選用**，`--caddy` 才啟動） | Caddy |

如果有 port 衝突，WebSocket（live）port 可在 `data/config.json` 的 `server.wsPort` 修改。

### `data/config.json`

- **首次啟動 server 時自動生成**，使用者不需要手動建立
- 預設值定義在 `packages/shared/src/config.ts` 的 `DEFAULT_CONFIG`
- 如果使用者遇到設定問題，可以刪除 `data/config.json` 讓 server 重新生成預設值

### 常見問題排錯

| 問題 | 原因 | 解決方式 |
|------|------|----------|
| `LIBUSB_ERROR_NOT_SUPPORTED` | ANT+ stick 驅動不對 | 用 [Zadig](https://zadig.akeo.ie/) 將 ANT+ stick 驅動換成 **WinUSB** |
| ANT+ 在 WSL 不能用 | WSL 無法存取 Windows USB 裝置 | ANT+ 相關指令必須在 **Windows PowerShell / Terminal** 執行 |
| `EADDRINUSE :8765` | WebSocket port 被占用 | 關閉其他佔用 8765 的程式，或改 `data/config.json` 的 `server.wsPort` |
| 前端連不上 WebSocket | Server 沒啟動 / port 不對 | 確認 server 正在運行，且前端的 WebSocket URL 指向正確 port |
| PiP 按鈕沒出現 | 瀏覽器不支援 Document PiP | 使用 Chrome 或 Edge 116 以上版本 |
| `npm install` 失敗（native module） | Windows / WSL 編譯環境不同 | 務必在 **Windows** 上執行 `npm install`，不要在 WSL |

### 專案架構快速理解

```
packages/shared  →  共用型別 + 業務邏輯（先 build 這個）
packages/server  →  Node.js 後端（感測器 + WebSocket + REST API + SQLite）
packages/web     →  Vue 3 前端（3D/2D 遊戲 + HUD + 設定）
data/            →  運行時資料（config、routes、DB，全被 gitignore）
```

Build 順序：`shared → server → web`（`npm run build` 會自動處理）

### 三種渲染模式

使用者在歡迎畫面可以選擇渲染模式（設定面板 → 渲染模式）：

| 模式 | 引擎 | 說明 |
|------|------|------|
| MapLibre (2D) | MapLibre GL JS | 2D 地圖 + Three.js 球球疊加層 |
| Three.js (3D) | Three.js | 獨立 3D 塑膠玩具世界，FPS 視角 |
| Phaser.js (2D) | Phaser.js | NES 風格橫軸捲軸，支援塑膠風/手繪風切換 |

---

## 做一套自己的視覺世界

內建三套完整世界（積木 / 瓦楞紙 / 電子）。要做第四套，或想知道現有三套是怎麼長出來的：

| 文件 | 它回答什麼 |
|------|------|
| [`CUSTOM_WORLD_INSTRUCTIONS.md`](CUSTOM_WORLD_INSTRUCTIONS.md) | 一套世界要交付什麼、設計法則、效能預算、驗收工具、踩過的坑 |
| [`plan/DEMO_POC_GUIDE.md`](plan/DEMO_POC_GUIDE.md) | demo 要長成什麼樣才配叫 POC —— 必備控制列、四個地形 profile |
| [`plan/demo-gaps.md`](plan/demo-gaps.md) | 反方向：gameview 遇得到而 demo 仲裁不了的情況 |
| [`plan/port-inventory.md`](plan/port-inventory.md) | 移植進度盤點 |

世界的 demo 是 `plan/*-demo.html`，單檔 HTML、零 build、開瀏覽器就看得到。
**它們不是原型 —— 那份程式碼會被直接搬進前端。**

---

Kelunyang@2026 by claude with :heart: | [GitHub](https://github.com/kelunyang/littleCycling)
