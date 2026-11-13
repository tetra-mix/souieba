#!/usr/bin/env bash
# v2（Relay）を手元で試すためのスクリプト。リポジトリのソースをビルドして、ローカルの Relay と2人分（アリス・ボブ）の設定で動かす。
# v2 はPerson単位。アリスとボブがそれぞれ1つのPersonを持つ。
# いつもの ~/.souieba には触らない。設定・DB・ログはリポジトリの .v2-try/ に置く（git では管理しない）。
#
#   scripts/v2-try.sh check [--yes]    一通りの流れを確かめる（途中で y/N を聞く。最後に TUI が開く。--yes なら聞かずに進め、TUI も開かない）
#   scripts/v2-try.sh up               Relay を起動し、アリスとボブを用意して待つ（Ctrl-C で止める）
#   scripts/v2-try.sh as <名前> -- <コマンド...>
#                                      そのPersonとして souieba を実行する（例: as alice -- relay ui）
#   scripts/v2-try.sh reset            .v2-try/ を消して最初からにする
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/.v2-try"
PORT="${SOUIEBA_TRY_PORT:-18750}"
URL="http://127.0.0.1:$PORT"
CLI="$ROOT/apps/cli/dist/souieba.mjs"
SERVER="$ROOT/apps/server/dist/main.mjs"
export SOUIEBA_NO_UPDATE_CHECK=1 SOUIEBA_SESSION_GAP_MIN=0 SOUIEBA_TELL_INTERVAL_MIN=0

need_node() {
  command -v node >/dev/null || { echo "node が見つかりません（Node.js 22 以上が必要です）"; exit 1; }
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 22 ] || { echo "Node.js 22 以上が必要です（今は $(node -v)）"; exit 1; }
  [ -d "$ROOT/node_modules" ] || { echo "先に pnpm install を実行してください"; exit 1; }
}

build() {
  echo "ビルドしています…"
  (cd "$ROOT" && pnpm --silent build:cli >/dev/null 2>&1 && pnpm --silent build:server >/dev/null 2>&1) || { echo "ビルドに失敗しました"; exit 1; }
}

# as <人> <端末> <コマンド...>（端末は空でもよい。端末が1台だけならそれを使う）
as() {
  local who="$1"
  shift
  [ "${1:-}" = "--" ] && shift
  SOUIEBA_HOME="$WORK/homes/$who" node "$CLI" "$@"
}

start_server() {
  mkdir -p "$WORK/data"
  SOUIEBA_PUBLIC_URL="$URL" PORT="$PORT" SOUIEBA_DATA_DIR="$WORK/data" SOUIEBA_POST_GRACE_MINUTES=0 SOUIEBA_LOG_LEVEL=error \
    node "$SERVER" >>"$WORK/server.log" 2>&1 &
  SERVER_PID=$!
  trap 'kill $SERVER_PID 2>/dev/null' EXIT
  for _ in $(seq 1 50); do curl -s "$URL/healthz" >/dev/null && return 0; sleep 0.2; done
  echo "Relay が起動しませんでした（$WORK/server.log を見てください。ポート $PORT が使われているなら SOUIEBA_TRY_PORT で変えられます）"
  exit 1
}

person_id() {
  as "$1" -- relay id 2>/dev/null | grep -oE 'sb_[a-z2-7]{32}' | head -1
}

# ensure_person <人> <内部名>
ensure_person() {
  local who="$1" name="$2"
  [ -n "$(person_id "$who")" ] || as "$who" -- init "$URL" --name "$name" >/dev/null || { echo "$who の init に失敗しました"; exit 1; }
}

cmd="${1:-}"
[ $# -gt 0 ] && shift
case "$cmd" in
  as)
    [ $# -ge 2 ] || { echo "使い方: scripts/v2-try.sh as <名前> -- <コマンド...>"; exit 1; }
    need_node
    [ -f "$CLI" ] || build
    who="$1"
    shift
    as "$who" "$@"
    ;;

  up)
    need_node
    build
    start_server
    ensure_person alice alice
    ensure_person bob bob
    cat <<EOF

Relay を $URL で動かしています（DB: $WORK/data。Ctrl-C で止めます）。
アリス: $(person_id alice)
ボブ:   $(person_id bob)

別のターミナルで、たとえば:
  scripts/v2-try.sh as alice -- relay connect $(person_id bob) --name ボブ   # エージェントと同じく --yes がないと止まる
  scripts/v2-try.sh as bob -- relay ui                                       # ボブとして TUI で承認する
  scripts/v2-try.sh as alice -- relay ui                                     # アリスとして共有を許可する
  scripts/v2-try.sh as alice -- publish --current "主人は……"
  scripts/v2-try.sh as bob -- tell
EOF
    wait "$SERVER_PID"
    ;;

  check)
    YES=0
    [ "${1:-}" = "--yes" ] && YES=1
    need_node
    build
    # 確認は毎回まっさらな状態から行う（up で使う設定とは分ける）
    WORK="$WORK/check"
    [ -d "$WORK" ] && rm -r "$WORK"
    mkdir -p "$WORK"
    LOG="$WORK/check.log"
    NG=0
    log() { echo "$*" | tee -a "$LOG"; }
    ok() { log "OK  $1"; }
    ng() { log "NG  $1"; NG=$((NG + 1)); }
    # 主人が端末で y と答える操作。--yes のときは、主人の同意を得たエージェントと同じく --yes を付けて実行する
    owner() { if [ $YES -eq 1 ]; then as "$@" --yes </dev/null; else as "$@"; fi; }
    log "node $(node -v) / $(uname -sm) / $(cd "$ROOT" && git rev-parse --short HEAD 2>/dev/null)"
    start_server
    ensure_person alice alice
    ensure_person bob bob
    A="$(person_id alice)"
    B="$(person_id bob)"
    [ -n "${A}" ] && [ -n "${B}" ] && ok "init（アリス ${A} / ボブ ${B}）" || { ng "init"; exit 1; }

    out="$(as alice -- relay connect "$B" --name ボブ </dev/null 2>&1)"
    code=$?
    [ ${code} -eq 3 ] && echo "$out" | grep -q -- "--yes" && ok "エージェント（端末なし）の connect は、--yes がないと内容を出して止まる" || ng "端末なしの connect: ${code} $out"

    if [ $YES -eq 0 ]; then
      echo
      echo "===== ここから確認の質問に答えてください（y を4回、最後だけ n）====="
    fi
    owner alice -- relay connect "${B}" --name ボブ && ok "アリス: connect" || ng "アリス: connect"
    owner bob -- relay accept "${A}" --name アリス && ok "ボブ: accept" || ng "ボブ: accept"
    owner alice -- relay allow ボブ && ok "アリス: allow" || ng "アリス: allow"
    owner alice -- relay policy set "友達には趣味や週末の過ごし方は話してよい。仕事の話は共有しない。" && ok "アリス: policy set" || ng "アリス: policy"
    if [ $YES -eq 0 ]; then
      echo "（次の1回は n と答えてください。取りやめになるのが正しい動きです）"
      if as alice -- relay policy clear; then ng "アリス: policy clear が n でも実行された"; else ok "アリス: policy clear を n で取りやめた"; fi
      echo "===== 入力はここまでです ====="
      echo
    fi

    n="$(as bob -- relay contacts 2>&1 | grep -c "$A")"
    [ "${n}" = "1" ] && ok "ボブから見てアリスとの接続は1つだけ（端末ごとではない）" || ng "ボブの contacts にアリスが ${n} 件"
    n="$(as alice -- relay contacts 2>&1 | grep -c "$B")"
    [ "${n}" = "1" ] && ok "アリスから見て、ボブとの接続は1つ" || ng "アリスの contacts にボブが ${n} 件"

    out="$(as alice -- relay deny ボブ </dev/null 2>&1)"
    [ $? -eq 0 ] && ok "共有を狭める操作（deny）は確認なしで実行される" || ng "deny: $out"
    out="$(as alice -- relay allow ボブ --yes </dev/null 2>&1)"
    [ $? -eq 0 ] && ok "エージェントは --yes で allow を実行できる" || ng "allow --yes: $out"
    out="$(as alice -- tell 2>&1)"
    echo "$out" | grep -q "共有の設定が、端末の外（エージェント）から変更されました" && ok "エージェントが変えた設定を tell で知らせる" || ng "tell の知らせ: $out"

    as alice -- note "主人は週末に初めてソロキャンプに行った" >/dev/null
    out="$(as alice -- publish --current --nuance "気軽な雑談として" "主人は週末に初めてソロキャンプに行ったらしい" 2>&1)"
    echo "$out" | grep -q "ボブ に送りました" && ok "アリス: publish" || ng "アリス: publish: $out"
    out="$(as bob -- tell 2>&1)"
    if echo "$out" | grep -q "あ、そういえばアリスさん、週末に初めてソロキャンプに行ったみたいですよ。" && echo "$out" | grep -q 'nuance="気軽な雑談として"'; then
      ok "ボブ: tell に、アリスの近況と Narrator が出る"
    else
      ng "ボブ: tell: $out"
    fi
    out2="$(as bob -- tell 2>&1)"
    echo "$out2" | grep -q "ソロキャンプ" && ng "ボブが同じ近況をもう一度伝えた: $out2" || ok "ボブ: 同じPersonなので、同じ近況は2回伝えない"
    as alice -- relay sent | grep -q "ボブ: 受信済み" && ok "アリス: relay sent で受信済みが見える" || ng "relay sent"
    { echo "--- ボブの tell ---"; echo "$out"; echo "--- アリスの status ---"; as alice -- relay status; } >>"$LOG"

    log ""
    if [ ${NG} -eq 0 ]; then log "すべて OK"; else log "NG が ${NG} 件あります"; fi
    echo "結果は $LOG にあります"
    if [ $YES -eq 0 ]; then
      echo
      echo "最後に、アリスの設定で TUI を開きます。矢印キーで選び、Space で共有の許可を切り替えたり、g でグループを作ったりできます。q で閉じます。"
      read -r -p "Enter で開く（開かない場合は Ctrl-C）" _
      as alice -- relay ui
    fi
    [ $NG -eq 0 ]
    ;;

  reset)
    [ -d "$WORK" ] && rm -r "$WORK"
    echo "$WORK を消しました"
    ;;

  *)
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
