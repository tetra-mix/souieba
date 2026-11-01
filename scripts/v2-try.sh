#!/usr/bin/env bash
# v2（Relay）を手元で試すためのスクリプト。リポジトリのソースをビルドして、ローカルの Relay と2人分（アリス・ボブ）の設定で動かす。
# 2.1.0 から ID は人ごと。アリスは端末（エージェント）を2台（ClaudeA1・ClaudeA2）、ボブも2台（ClaudeB1・ClaudeB2）持つ。
# いつもの ~/.souieba には触らない。設定・DB・ログはリポジトリの .v2-try/ に置く（git では管理しない）。
#
#   scripts/v2-try.sh check [--yes]    一通りの流れを確かめる（途中で y/N を聞く。最後に TUI が開く。--yes なら聞かずに進め、TUI も開かない）
#   scripts/v2-try.sh up               Relay を起動し、アリスとボブを用意して待つ（Ctrl-C で止める）
#   scripts/v2-try.sh as <名前> [<端末>] -- <コマンド...>
#                                      その人（の端末）として souieba を実行する（例: as alice ClaudeA2 -- relay ui / as bob -- tell）
#   scripts/v2-try.sh reset            .v2-try/ を消して最初からにする
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/.v2-try"
PORT="${SOUIEBA_TRY_PORT:-18750}"
URL="http://127.0.0.1:$PORT"
CLI="$ROOT/apps/cli/dist/souieba.mjs"
SERVER="$ROOT/apps/server/dist/main.mjs"
export SOUIEBA_NO_UPDATE_CHECK=1 SOUIEBA_AGENT="" SOUIEBA_TELL_INTERVAL_MIN=0

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
  local who="$1" dev="$2"
  shift 2
  SOUIEBA_HOME="$WORK/homes/$who" SOUIEBA_AGENT="$dev" node "$CLI" "$@"
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
  as "$1" "$2" relay id 2>/dev/null | grep -oE 'sb_[a-z2-7]{32}' | head -1
}

# ensure_person <人> <1台目の端末> <2台目の端末>
ensure_person() {
  local who="$1" d1="$2" d2="$3"
  [ -n "$(person_id "$who" "$d1")" ] || as "$who" "" init "$URL" --name "$d1" >/dev/null || { echo "$who の init に失敗しました"; exit 1; }
  as "$who" "$d1" device list 2>/dev/null | grep -q -- "- $d2" || as "$who" "$d1" device add "$d2" >/dev/null || { echo "$who の device add に失敗しました"; exit 1; }
}

cmd="${1:-}"
[ $# -gt 0 ] && shift
case "$cmd" in
  as)
    [ $# -ge 2 ] || { echo "使い方: scripts/v2-try.sh as <名前> [<端末>] -- <コマンド...>"; exit 1; }
    need_node
    [ -f "$CLI" ] || build
    who="$1"
    shift
    dev=""
    if [ "$1" != "--" ]; then dev="$1"; shift; fi
    [ "${1:-}" = "--" ] && shift
    as "$who" "$dev" "$@"
    ;;

  up)
    need_node
    build
    start_server
    ensure_person alice ClaudeA1 ClaudeA2
    ensure_person bob ClaudeB1 ClaudeB2
    cat <<EOF

Relay を $URL で動かしています（DB: $WORK/data。Ctrl-C で止めます）。
アリス: $(person_id alice ClaudeA1)（端末 ClaudeA1・ClaudeA2）
ボブ:   $(person_id bob ClaudeB1)（端末 ClaudeB1・ClaudeB2）

別のターミナルで、たとえば:
  scripts/v2-try.sh as alice ClaudeA1 -- relay connect $(person_id bob ClaudeB1) --name ボブ   # エージェントと同じく --yes がないと止まる
  scripts/v2-try.sh as bob ClaudeB1 -- relay ui                                             # ボブとして TUI で承認する
  scripts/v2-try.sh as alice ClaudeA2 -- relay ui                                           # アリスとして共有を許可する（どの端末でも同じ設定）
  scripts/v2-try.sh as alice ClaudeA2 -- publish --current "主人は……"
  scripts/v2-try.sh as bob ClaudeB2 -- tell
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
    ensure_person alice ClaudeA1 ClaudeA2
    ensure_person bob ClaudeB1 ClaudeB2
    A="$(person_id alice ClaudeA1)"
    A2="$(person_id alice ClaudeA2)"
    B="$(person_id bob ClaudeB1)"
    [ -n "${A}" ] && [ -n "${B}" ] && ok "init と device add（アリス ${A} / ボブ ${B}、どちらも端末2台）" || { ng "init"; exit 1; }
    [ "${A}" = "${A2}" ] && ok "アリスの2台の端末は同じ ID" || ng "アリスの端末の ID が違う: ${A} / ${A2}"
    as alice ClaudeA1 device list | grep -q "ClaudeA2" && ok "device list に2台目が出る" || ng "device list"

    out="$(as alice ClaudeA1 relay connect "$B" --name ボブ </dev/null 2>&1)"
    code=$?
    [ ${code} -eq 3 ] && echo "$out" | grep -q -- "--yes" && ok "エージェント（端末なし）の connect は、--yes がないと内容を出して止まる" || ng "端末なしの connect: ${code} $out"

    if [ $YES -eq 0 ]; then
      echo
      echo "===== ここから確認の質問に答えてください（y を4回、最後だけ n）====="
    fi
    owner alice ClaudeA1 relay connect "${B}" --name ボブ && ok "アリス（ClaudeA1）: connect" || ng "アリス: connect"
    owner bob ClaudeB2 relay accept "${A}" --name アリス && ok "ボブ（ClaudeB2）: accept" || ng "ボブ: accept"
    owner alice ClaudeA2 relay allow ボブ && ok "アリス（ClaudeA2）: allow（1台目で作った連絡先を2台目でも使える）" || ng "アリス: allow"
    owner alice ClaudeA1 relay policy set "友達には趣味や週末の過ごし方は話してよい。仕事の話は共有しない。" && ok "アリス: policy set" || ng "アリス: policy"
    if [ $YES -eq 0 ]; then
      echo "（次の1回は n と答えてください。取りやめになるのが正しい動きです）"
      if as alice ClaudeA1 relay policy clear; then ng "アリス: policy clear が n でも実行された"; else ok "アリス: policy clear を n で取りやめた"; fi
      echo "===== 入力はここまでです ====="
      echo
    fi

    n="$(as bob ClaudeB1 relay contacts 2>&1 | grep -c "$A")"
    [ "${n}" = "1" ] && ok "ボブから見てアリスとの接続は1つだけ（端末ごとではない）" || ng "ボブの contacts にアリスが ${n} 件"
    n="$(as alice ClaudeA2 relay contacts 2>&1 | grep -c "$B")"
    [ "${n}" = "1" ] && ok "アリスの2台目から見ても、ボブとの接続は1つ" || ng "アリスの contacts にボブが ${n} 件"

    out="$(as alice ClaudeA1 relay deny ボブ </dev/null 2>&1)"
    [ $? -eq 0 ] && ok "共有を狭める操作（deny）は確認なしで実行される" || ng "deny: $out"
    out="$(as alice ClaudeA1 relay allow ボブ --yes </dev/null 2>&1)"
    [ $? -eq 0 ] && ok "エージェントは --yes で allow を実行できる" || ng "allow --yes: $out"
    out="$(as alice ClaudeA2 tell 2>&1)"
    echo "$out" | grep -q "共有の設定が、端末の外（エージェント）から変更されました" && ok "エージェントが変えた設定を tell で知らせる（どの端末の tell でも）" || ng "tell の知らせ: $out"

    # アリスの2台目から送る
    as alice ClaudeA2 note "主人は週末に初めてソロキャンプに行った" >/dev/null
    out="$(as alice ClaudeA2 publish --current --nuance "気軽な雑談として" "主人は週末に初めてソロキャンプに行ったらしい" 2>&1)"
    echo "$out" | grep -q "ボブ に送りました" && ok "アリス（ClaudeA2）: publish" || ng "アリス: publish: $out"
    out="$(as bob ClaudeB1 tell 2>&1)"
    if echo "$out" | grep -q "あ、そういえばアリスさん、週末に初めてソロキャンプに行ったみたいですよ。" && echo "$out" | grep -q 'nuance="気軽な雑談として"'; then
      ok "ボブ（ClaudeB1）: tell に、アリスの2台目からの近況と Narrator が出る"
    else
      ng "ボブ: tell: $out"
    fi
    out2="$(as bob ClaudeB2 tell 2>&1)"
    echo "$out2" | grep -q "ソロキャンプ" && ng "ボブの2台目でも同じ近況を伝えた: $out2" || ok "ボブ（ClaudeB2）: 同じ PC なので、同じ近況は2回伝えない"

    # アリスの1台目から送る
    out="$(as alice ClaudeA1 publish --current "主人は新しいカメラを買ってうれしそうだったらしい" 2>&1)"
    echo "$out" | grep -q "ボブ に送りました" && ok "アリス（ClaudeA1）: publish" || ng "アリス（ClaudeA1）: publish: $out"
    out3="$(as bob ClaudeB2 tell 2>&1)"
    echo "$out3" | grep -q "カメラ" && ok "ボブ（ClaudeB2）: アリスの1台目からの近況が出る" || ng "ボブ（ClaudeB2）: tell: $out3"
    out4="$(as bob ClaudeB1 tell 2>&1)"
    echo "$out4" | grep -q "カメラ\|ソロキャンプ" && ng "ボブの1台目で同じ近況をもう一度伝えた: $out4" || ok "ボブ（ClaudeB1）: どちらの近況も、もう伝えない"
    as alice ClaudeA1 relay sent | grep -q "ボブ: 受信済み" && ok "アリス: relay sent で受信済みが見える" || ng "relay sent"
    { echo "--- ボブの tell（ClaudeB1）---"; echo "$out"; echo "--- ボブの tell（ClaudeB2）---"; echo "$out3"; echo "--- アリスの status ---"; as alice ClaudeA1 relay status; } >>"$LOG"

    log ""
    if [ ${NG} -eq 0 ]; then log "すべて OK"; else log "NG が ${NG} 件あります"; fi
    echo "結果は $LOG にあります"
    if [ $YES -eq 0 ]; then
      echo
      echo "最後に、アリスの設定で TUI を開きます。矢印キーで選び、Space で共有の許可を切り替えたり、g でグループを作ったりできます。「端末」のタブで端末を見られます。q で閉じます。"
      read -r -p "Enter で開く（開かない場合は Ctrl-C）" _
      as alice ClaudeA1 relay ui
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
