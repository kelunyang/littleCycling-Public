#!/bin/bash
set -e

# 一鍵雙推：把目前 main 的 commit 同時部署到
#   1) origin（littleCycling，私有）      —— 原樣推送，含 sessions 等測試資料
#   2) public（littleCycling-Public，公開）—— 經 publish-public.sh 消毒後推送
#
# 前提：變更已經 commit 完成（本腳本只負責「推送已提交的內容」，不自動 commit）。
# 用法：scripts/deploy.sh ["公開 repo 的 commit message"]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MSG="${1:-Update public release $(date +%Y-%m-%d)}"

# 必須在 main 上（publish-public.sh 也是以 main 為來源）
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then
  echo "Error: 必須在 main 分支執行（目前在 '$BRANCH'）。"
  exit 1
fi

# 工作區必須乾淨（publish-public.sh 用 worktree，未提交的變更不會被帶上）
if [ -n "$(git status --porcelain)" ]; then
  echo "Error: 工作區不乾淨，請先 commit 或 stash。"
  exit 1
fi

# ── 1) 私有 origin ──
echo "▶ 推送到 origin（私有 littleCycling）…"
git push origin main
echo "✓ origin 完成"
echo ""

# ── 2) 公開 public（消毒後）──
echo "▶ 發布到 public（公開 littleCycling-Public，含個資過濾）…"
bash "$SCRIPT_DIR/publish-public.sh" "$MSG"

echo ""
echo "✓ 雙推完成。"
