#!/bin/bash
set -e

# 確認 public remote 存在
if ! git remote get-url public &>/dev/null; then
  echo "Error: 'public' remote not found. Run: git remote add public <url>"
  exit 1
fi

# 確認 public-main branch 存在
if ! git rev-parse --verify public-main &>/dev/null; then
  echo "Error: 'public-main' branch not found. Create it first:"
  echo "  git checkout --orphan public-main && git commit -m 'Initial public release' && git checkout main"
  exit 1
fi

# 儲存目前 branch
CURRENT_BRANCH=$(git branch --show-current)

# 確保工作目錄乾淨
if [ -n "$(git status --porcelain)" ]; then
  echo "Error: Working directory not clean. Commit or stash changes first."
  exit 1
fi

# 取得 commit message（可選參數或預設）
MSG="${1:-Update public release $(date +%Y-%m-%d)}"

# 切到 public-main，同步 main 的檔案
git checkout public-main
git checkout main -- .
git add -A

# 如果有變更才 commit
if git diff --cached --quiet; then
  echo "No changes to publish."
else
  git commit -m "$MSG"
  git push public public-main:main
  echo "Published to public repo!"
fi

# 切回原本 branch
git checkout "$CURRENT_BRANCH"
