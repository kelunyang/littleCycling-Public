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
| 資料庫 | SQLite |
| 反向代理 | Caddy |

## 環境需求

- **Node.js >= 20**
- **Caddy** — 反向代理，統一前後端與 WebSocket 入口（**必裝**，[安裝指南](https://caddyserver.com/docs/install)）。專案已提供 `Caddyfile.example`，複製後即可使用：
  ```bash
  cp Caddyfile.example Caddyfile
  caddy run
  ```
- **ANT+ Stick**: Garmin ANT+ Stick 2（需安裝 WinUSB 驅動，透過 Zadig）
- **執行環境**: ANT+ 相關功能須在 **Windows** 上執行（非 WSL），前端開發可在 WSL 進行

## 快速開始

### 1. 安裝依賴

```bash
# 在專案根目錄
npm install
```

### 2. 建置所有套件

shared 套件需要先編譯，後端和前端都依賴它。使用以下指令一次建置所有套件（shared → server → web）：

```bash
npm run build
```

### 3. 啟動後端 (Server)

後端有多種啟動模式：

```bash
# 啟動完整 Server（WebSocket + REST API）
npm run server -w packages/server

# 啟動 Ink 終端儀表板（互動式錄製介面）
npm run start -w packages/server

# 純錄製模式（CLI）
npm run record -w packages/server

# Replay 模式（回放 JSONL 錄製檔，前端開發用，不需要實體感測器）
npm run replay -w packages/server

# BLE 心率測試
npm run ble:test -w packages/server
```

> **注意**: 涉及 ANT+ Stick 的指令必須在 **Windows PowerShell / Terminal** 中執行，不能在 WSL 中執行。

### 4. 啟動前端 (Web)

```bash
# 開發模式（Vite dev server，支援 HMR）
npm run dev -w packages/web

# 正式建置
npm run build -w packages/web

# 預覽建置結果
npm run preview -w packages/web
```

### 5. 一鍵啟動開發模式

`npm run dev` 會同時啟動所有服務（shared watch + server + web + caddy），並顯示 Ink 儀表板：

```bash
# 一鍵啟動（含 Caddy 反向代理）
npm run dev

# 不啟動 Caddy
npm run dev:no-caddy
```

儀表板會顯示每個服務的狀態（starting / ready / error），下方即時輸出所有服務的 log。按 `q` 停止所有服務。

開啟 `http://localhost:3000` 即可使用（Caddy 統一入口）。

### 6. Caddy 反向代理

Caddy 將前端（:5173）和後端（:8765）統一代理到 `:3000`：

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

### 7. 手動分別啟動

如果不想用一鍵模式，也可以開 4 個 Terminal 分別啟動：

```bash
# Terminal 1 — 編譯 shared（watch 模式）
npm run dev -w packages/shared

# Terminal 2 — 啟動後端 server
npm run server -w packages/server

# Terminal 3 — 啟動前端 dev server
npm run dev -w packages/web

# Terminal 4 — Caddy 反向代理
caddy run --config Caddyfile.example
```

如果沒有實體感測器，可以用 replay 模式代替 server：

```bash
npm run replay
```

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

## 遊戲特色

- **真實 3D 地圖**：OpenFreeMap 向量地圖 + AWS 地形高程 + 3D 建築物
- **塑膠玩具美術風格**：MeshToonMaterial 離散色階 + 螢光噴漆配色，完全程序化渲染
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

詳細規格請參閱 [DEVPLAN.md](DEVPLAN.md)。

## License

本專案原始碼以 **CC-BY-SA 4.0** 授權。

第三方依賴各有其授權（MIT / ISC / BSD / Apache-2.0 等），均為 permissive license。

**注意**：`@garmin/fitsdk` 為 Garmin 專有授權，不可作為 CC-BY-SA 內容重新散佈。該套件由使用者在 `npm install` 時自行從 npm registry 取得，本 repo 不包含其原始碼。

---

## AI 輔助安裝指南（給 AI 助手的補充資訊）

以下資訊專門提供給 AI 助手（如 ChatGPT、Claude、Copilot 等）引導使用者安裝和排錯。

### 最低需求

- **Node.js >= 20**（必要）
- **作業系統**：Windows 11（ANT+ 感測器功能）；前端開發可在 macOS / Linux / WSL 進行
- **瀏覽器**：Chrome 或 Edge（推薦）。PiP 浮動視窗功能需要 Chrome/Edge 116+，Firefox / Safari 不支援

### 沒有感測器的快速體驗路徑

大多數使用者不會有 ANT+ stick 和自行車感測器。請引導他們使用 **Replay 模式**：

```bash
npm install
npm run build
npm run replay          # 會回放內建的錄製資料，不需要任何硬體
```

然後另開 terminal 啟動前端：

```bash
npm run dev -w packages/web
```

開啟 `http://localhost:5173` 即可看到遊戲畫面（無 Caddy 時直接連 Vite dev server）。

### 使用的 Port

| Port | 用途 | 服務 |
|------|------|------|
| 3000 | Caddy 反向代理統一入口 | Caddy |
| 5173 | Vite 前端 dev server | packages/web |
| 8765 | WebSocket server（感測器資料） | packages/server |

如果有 port 衝突，WebSocket port 可在 `data/config.json` 的 `server.wsPort` 修改。

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
| FIT 匯出功能需要 `@garmin/fitsdk` | Garmin 專有授權套件 | `npm install` 會自動從 npm 安裝，不需額外操作 |

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

Kelunyang@2026 by claude with :heart: | [GitHub](https://github.com/kelunyang/littleCycling)
