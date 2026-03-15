# littleCycling - Claude Code 規範

## 重要
- 任何架構、設計、功能規格相關問題，請參閱 **DEVPLAN.md**

## UI 圖示規範
- 所有圖示一律使用 **Font Awesome**，不使用 emoji
- 前端（Vue 3）使用 `@fortawesome/vue-fontawesome` 套件
- 終端 UI（Ink）不受此限制

## 專案結構
- **Monorepo**（npm/pnpm workspaces）
  - `packages/server` — Node.js 後端（ANT+/BLE、WebSocket、Replay、SQLite）
  - `packages/web` — Vue 3 前端（3D 遊戲）
  - `packages/shared` — 前後端共用型別、常數、功率曲線

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
