#!/bin/sh
# 生成物（DB のマイグレーション・Worker の型）が、schema.ts と wrangler.toml に対して最新かを確かめる。
# 変えたのに作り直し忘れていると、デプロイした Worker と手元の定義がずれるため、CI とデプロイの前に走らせる。
set -eu
cd "$(dirname "$0")/.."

pnpm --filter @souieba/server db:generate >/dev/null
pnpm --filter @souieba/server exec wrangler types --check >/dev/null

# 新しいファイルができた・内容が変わった、のどちらも見つける
if [ -n "$(git status --porcelain -- apps/server/drizzle apps/server/src/db/migrations.gen.ts)" ]; then
  echo "マイグレーションが最新ではありません。pnpm --filter @souieba/server db:generate --name <名前> を実行して、できたファイルをコミットしてください。" >&2
  git status --short -- apps/server/drizzle apps/server/src/db/migrations.gen.ts >&2
  exit 1
fi
echo "生成物は最新です"
