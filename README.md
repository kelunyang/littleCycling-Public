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
| 2 | Replay Server（WebSocket 回放 JSONL） | 開發中 |
| 3 | Ink 終端儀表板（互動式錄製 UI） | ✅ 完成 |
| 4 | 前端遊戲（Vue 3 + MapLibre + Three.js） | 開發中 |
| 5 | 訓練紀錄（SQLite 儲存歷史） | 計畫中 |
| 6 | Live 整合模式 | 計畫中 |

## 遊戲特色

- **真實 3D 地圖**：OpenFreeMap 向量地圖 + AWS 地形高程 + 3D 建築物
- **GPX 路線**：支援上傳 GPX/TCX，或下載環法/Giro/Vuelta 賽事路線
- **感測器驅動**：ANT+ 速度/踏頻 + BLE 心率，支援虛擬功率估算
- **金幣系統**：依心率區間獎勵金幣，鼓勵穩定配速
- **DOOM 風格 HUD**：即時顯示心率、速度、踏頻、功率、金幣
- **雙模式**：軌道模式（沿 GPX 路線）或自由漫遊（需雙邊功率計）

詳細規格請參閱 [DEVPLAN.md](DEVPLAN.md)。

---

kelunyang@2025 | [GitHub](https://github.com/kelunyang/littleCycling)
