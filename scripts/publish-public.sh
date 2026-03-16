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

# 確保工作目錄乾淨
if [ -n "$(git status --porcelain)" ]; then
  echo "Error: Working directory not clean. Commit or stash changes first."
  exit 1
fi

# 取得 commit message（可選參數或預設）
MSG="${1:-Update public release $(date +%Y-%m-%d)}"

# 使用 worktree 避免切換分支（SQLite 鎖定檔案會導致 checkout 失敗）
WORK_DIR=$(mktemp -d)
trap 'git worktree remove --force "$WORK_DIR" 2>/dev/null; rm -rf "$WORK_DIR"' EXIT

git worktree add "$WORK_DIR" public-main

# 同步 main 的檔案到 worktree
git --work-tree="$WORK_DIR" checkout main -- .

# 在 worktree 中操作
cd "$WORK_DIR"
git add -A

# 如果有變更才 commit
if git diff --cached --quiet; then
  echo "No changes to publish."
else
  git commit -m "$MSG"
  git push public public-main:main
  echo "Published to public repo!"
fi
