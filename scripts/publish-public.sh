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

# ── 傳播刪除 ──
# 上面的 checkout 只「寫入」main 有的檔案，不會刪除 main 已移除的檔案，
# 所以 worktree 仍留著 public-main 舊 tip 的殘檔，add -A 後就永久留在公開 repo。
# 逐一清掉「public-main 有、main 沒有」的檔案，讓刪除也能同步出去。
comm -23 <(git ls-tree -r --name-only public-main | sort) \
         <(git ls-tree -r --name-only main | sort) \
  | while IFS= read -r ghost; do
      [ -n "$ghost" ] && rm -f "$WORK_DIR/$ghost"
    done

# ── 個資過濾 ──
# 原則：私有 repo 可以攜帶騎乘紀錄（機器間同步用），公開 repo 一律剝除。
# 這裡刪掉 worktree 裡的個資檔後才 add -A，所以公開 repo 既收不到新檔，
# 之前误发布的同路徑檔案也會在下次 publish 時被標成刪除、從公開 tip 移除。
rm -rf "$WORK_DIR/data/sessions"
find "$WORK_DIR" -path "*/recordings/*.jsonl" -delete
rm -f "$WORK_DIR"/data/*.jsonl \
      "$WORK_DIR"/data/*.db "$WORK_DIR"/data/*.db-shm "$WORK_DIR"/data/*.db-wal \
      "$WORK_DIR"/data/config.json
rm -rf "$WORK_DIR/plan"
# deploy.sh 描述私有↔公開的雙推流程，公開 repo 不該出現（publish-public.sh 本身留著即可）
rm -f "$WORK_DIR/scripts/deploy.sh"
echo "Sanitized: sessions / recordings / db / config / plan / deploy.sh stripped from public sync"

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
