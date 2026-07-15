# littleCycling - Claude Code 規範

## 重要
- 任何架構、設計、功能規格相關問題，請參閱 **DEVPLAN.md**

## 外部資料源版權規範
- **所有圖資、地形 / 高程、天氣等外部資料源都必須注意版權與使用政策**（不只授權條款，也包含 tile usage policy、商用限制等）。
- 新增或更換任何外部資料源前，**先確認版權，並主動告知開發者，取得確認後才可繼續**——不可自行決定接入。
- 目前已使用且確認乾淨的資料源清單見 **DEVPLAN.md「外部資料源與版權」**;署名字串集中在 `packages/shared/src/attributions.ts`。
- 底圖一律走 **OpenFreeMap**;**禁止**直連 OSM 官方圖磚 `tile.openstreetmap.org`(違反其 Tile Usage Policy)。

## UI 圖示規範
- 所有圖示一律使用 **Font Awesome**，不使用 emoji
- 前端（Vue 3）使用 `@fortawesome/vue-fontawesome` 套件
- 終端 UI（Ink）不受此限制

## 主題配色規範（World Style）
- 兩套手繪主題 **plastic**（糖果玩具）/ **cuphead**（1930s 橡膠管動畫）的調色盤**唯一來源**是 `packages/web/src/styles/themes.scss`（`main.ts` 匯入）。
- SCSS map 定義色票，mixin 自動吐出全域 CSS 變數，每色兩個 token：
  - `--pl-*` / `--ck-*`：實色（如 `--pl-ink`、`--ck-gold`）→ `color: var(--pl-ink);`
  - `--pl-*-rgb` / `--ck-*-rgb`：`r, g, b` 三元組 → `rgba(var(--ck-ink-rgb), 0.4);`（alpha 變體也綁同一來源）
- **禁止在元件 CSS 裡寫死主題 hex／rgba**——一律引用上述 token；改色只改 `themes.scss` 一處。
- SCSS map 的 key 必須**加引號**（`'pink':`），裸字會被 sass 當成 CSS 顏色值而觸發警告。
- 主題套用機制：`worldStyle` 鏡射到 `<body data-world-style>`（`App.vue`），語意 token（`--hud-*`、`--accent-*`、`--surface*`、`--el-*`）在 `App.vue` 的 `[data-world-style]` 區塊指到色票；teleport 到 body 的 el-drawer/dialog 因此也吃得到。
- Cyberpunk 基底 HUD 色（`#00e5ff`、`#ff2d6b`、`#050810`…）**刻意不收進色票**——它是預設外觀，住在 `App.vue :root`。
- **例外（canvas/JS 繪製吃不到 CSS var）**：`HudChart.vue`、`WorkoutElevationPreview.vue` 的 JS 調色盤、`game/phaser/*-style.ts` 的貼圖色是鏡像值，改 `themes.scss` 時需手動同步（檔內有註解標示）。
- 陷阱：plastic 的 `--hud-bg` 仍是暗藍——深色底壓在粉紙卡上會變髒灰，plastic 模式的面板底色請用紙色系 token 或 transparent，勿直接用 `var(--hud-bg)`。

## 專案結構
- **Monorepo**（npm/pnpm workspaces）
  - `packages/server` — Node.js 後端（ANT+/BLE、WebSocket、Replay、SQLite）
  - `packages/web` — Vue 3 前端（3D 遊戲）
  - `packages/shared` — 前後端共用型別、常數、功率曲線

## 前後端職責分工
- **前端（Vue）只負責 render**：呈現與互動，不承載業務邏輯。
- **邏輯一律盡量放在後端處理**（資料計算、狀態判斷、外部服務存取、git／系統操作等），前端透過 API 取結果後單純顯示。
- 例：更新檢查由後端比對 git commit 後把結果寫進 `config.json`，前端只讀 `/api/config` 決定要不要顯示提示；前端不直接打外部服務（避免 CORS 與邏輯分散）。

## 時間處理規範
- 所有時間一律使用 **timestamp（毫秒）** 儲存與傳輸
- 時間轉換、格式化一律使用 **dayjs**（不使用 Date 原生方法或 moment.js）

## 技術棧
- 後端：Node.js + TypeScript（ANT+/BLE 感測器、WebSocket server）
- 前端：Vue 3 + Vite + Pinia + MapLibre GL JS + Three.js
- 時間處理：dayjs
- 資料庫：SQLite（訓練紀錄）
- 感測器通訊：WebSocket

## 開發環境
- **系統在 Windows 上運行**，Claude 在 WSL 裡開發
- ANT+ stick 必須在 Windows 上執行（不是 WSL）
- 前端開發可在 WSL 進行
- 測試交給 user 在 Windows 執行

## 套件安裝規範
- **Claude 不可自行執行 `npm install`、`npm add` 或任何套件安裝指令**
- 若需要新增或更新套件，告知使用者，由使用者在 Windows 上執行安裝
- 原因：WSL 與 Windows 的 native module 編譯不相容（如 noble.node）
