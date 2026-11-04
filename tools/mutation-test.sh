#!/bin/bash
# 变异测试：在仓库副本上逐条注入故障，证明测试真的会红。
# 绿灯不是证据 —— 「没报错」和「该报错时会报错」是两件事，而它们长得一模一样。
# 原仓库全程只读，所有改动只发生在 $WORK 副本里。
set -u
SRC="$(cd "$(dirname "$0")/.." && pwd)"
WORK=""
PASS=0; FAIL=0

# 副本必须带上测试【实际会读到】的每一个文件。少拷一个目录，基线就不是 0，
# 于是整套变异测试在跑第一条变异之前就退出 —— 而且看起来像是"环境问题"。
# （tools/ 漏拷让这个闸门从 2026-08-10 起静默失效了二十天。）
seed_work () {
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/hawkerline-mutant.XXXXXX")" || exit 1
  cp -R "$SRC/worker" "$SRC/tests" "$SRC/web" "$SRC/tools" "$SRC/migrations" \
        "$SRC/package.json" "$SRC/package-lock.json" "$SRC/wrangler.toml" "$SRC/wrangler.test.toml" "$WORK/" 2>/dev/null
  cp -R "$SRC/.github" "$WORK/" 2>/dev/null
  ln -sfn "$SRC/node_modules" "$WORK/node_modules"
}

# 判定一律用【退出码】：node --test 的默认 reporter 随 Node 版本和是否 TTY 变化
# （CI 上是 Node 22 非 TTY），靠 grep '^✖ ' 计数会在 CI 上静默失灵。
# 退出码是稳定契约，reporter 只用来给人看。
# 副本环境自检：node_modules 链断了 / 依赖解析不了时，node --test 会瞬间失败，
# 而旧判据（数 '^✖ '）把这种「压根没跑」读成「全绿」。这里先把它挡在前面。
check_work_env () {
  if ! (cd "$WORK" && node -e "import('qrcode-svg').then(()=>process.exit(0),e=>{console.error(e.message);process.exit(1)})") 2>&1; then
    echo "❌ 变异副本里依赖解析不了（node_modules 链断了？）—— 测试根本跑不起来。"
    echo "   SRC=$SRC"
    echo "   WORK=$WORK"
    ls -ld "$WORK/node_modules" 2>&1 | sed 's/^/     /'
    return 1
  fi
}

prepare_bundle () {
  local out
  if ! out="$(cd "$WORK" && npx wrangler@4 deploy --dry-run --outdir .wrangler-dryrun 2>&1)"; then
    echo "❌ 变异副本里 wrangler dry-run 失败 —— 没有 .wrangler-dryrun，依赖它的测试会假红。"
    printf '%s\n' "$out" | tail -8 | sed 's/^/     /'
    return 1
  fi
}
run_tests () {                      # 不传参数跑全套；传入文件时只跑对应证明测试
  if [ "$#" -gt 0 ]; then
    (cd "$WORK" && node --test --test-reporter=spec "$@" 2>&1)
  else
    (cd "$WORK" && node --test --test-reporter=spec tests/*.test.mjs 2>&1)
  fi
}

run_case () {                       # run_case "名字" "perl 表达式" "证明测试（空格分隔）" [目标文件]
  local name="$1" expr="$2" tests="$3" target="${4:-worker/index.js}"
  local started=$SECONDS test_file out rc n
  local -a selected_tests
  IFS=' ' read -r -a selected_tests <<< "$tests"
  if [ "${#selected_tests[@]}" -eq 0 ]; then
    echo "  ❌ 未指定证明测试 │ $name"
    FAIL=$((FAIL+1)); return
  fi
  seed_work
  for test_file in "${selected_tests[@]}"; do
    if [ ! -f "$WORK/$test_file" ]; then
      echo "  ❌ 证明测试不存在 │ $name │ $test_file"
      FAIL=$((FAIL+1)); return
    fi
  done
  perl -0777 -i -pe "$expr" "$WORK/$target"
  prepare_bundle || { FAIL=$((FAIL+1)); return; }
  if ! cmp -s "$SRC/$target" "$WORK/$target"; then
    out="$(run_tests "${selected_tests[@]}")"; rc=$?
    printf '%s\n' "$out" > "$WORK/test-output.txt"
    echo "     tests=$tests │ injection=changed │ exit=$rc │ elapsed=$((SECONDS-started))s"
    echo "     evidence=$WORK/test-output.txt"
    printf '%s\n' "$out" | grep -E '^✖ |^not ok' | head -8 | sed 's/^/     /'
    n=$(printf '%s' "$out" | grep -cE '^✖ ' || true)
    if [ "$rc" -ne 0 ]; then
      echo "  ✅ 变红($n) │ $name"
      PASS=$((PASS+1))
    else
      echo "  ❌ 仍全绿   │ $name   ← 测试对这个缺陷是瞎的！"
      FAIL=$((FAIL+1))
    fi
  else
    echo "  ⚠️  未生效   │ $name   ← perl 模式没匹配到，变异无效"
    FAIL=$((FAIL+1))
  fi
}

# 先跑基线：不改代码必须 0 失败。否则后面每条「变红」都可能是环境问题冒充的。
BASE_STARTED=$SECONDS
seed_work
check_work_env || exit 1
prepare_bundle || exit 1
BASE_OUT="$(run_tests)"; BASE_RC=$?
printf '%s\n' "$BASE_OUT" > "$WORK/test-output.txt"
BASE=$(printf '%s' "$BASE_OUT" | grep -cE '^✖ ' || true)
echo "=== 基线（未变异）退出码：${BASE_RC}，失败标记数：${BASE} ==="
echo "    tests=tests/*.test.mjs │ elapsed=$((SECONDS-BASE_STARTED))s │ evidence=$WORK/test-output.txt"
printf '%s\n' "$BASE_OUT" | tail -9
if [ "$BASE_RC" -ne 0 ]; then
  echo "❌ 基线就不是绿的 —— 副本环境有问题，变异结果全部作废。先修环境。"
  printf '%s\n' "$BASE_OUT" | grep -E '^✖ |^not ok' | head -20 | sed 's/^/     /'
  printf '%s\n' "$BASE_OUT" | tail -15 | sed 's/^/     /'
  exit 1
fi
echo
echo "=== 变异测试：注入故障，看测试会不会红 ==="
run_case "订单金额恒为 0（全场免费）" \
  "s/total: money\(taxable \+ gst\)/total: 0/" \
  "tests/refund-engine.test.mjs"
run_case "Stripe 验签整段跳过（任何伪造 webhook 都能置 PAID）" \
  "s/(async function stripeVerify\([^)]*\) \{)/\$1 return JSON.parse(raw);/" \
  "tests/money-guards.test.mjs"
run_case "PayNow 备注直接显示 pay_ref（66 字符 cs_live_ 给顾客抄）" \
  "s/  const inv = String\(\(o && o.invoice_no\) \|\| ''\).trim\(\);/  return String((o \&\& o.pay_ref) || ''); const inv = '';/" \
  "tests/refund-engine.test.mjs"
run_case "PayNow reference 去掉 25 字符截断" \
  "s/_tlv\('01', String\(ref == null \? '' : ref\).slice\(0, 25\)\)/_tlv('01', String(ref == null ? '' : ref))/" \
  "tests/refund-engine.test.mjs"
run_case "退款优先退储值（顾客卡上收不到钱）" \
  "s/  const stripe = \\+Math.min\\(\\+amount \\|\\| 0, avail\\).toFixed\\(2\\);/  const stripe = 0;/" \
  "tests/refund-engine.test.mjs"
run_case "P0：charge.refunded 退回旧判定（退运费被当整单退）" \
  "s/  if \(own > 0 && goodsRefunded <= 0.005\) return \{ kind: 'fee_only'[^;]*;/  if (false) return { kind: 'fee_only', stripePortion, goodsCharge, goodsRefunded };/" \
  "tests/refund-engine.test.mjs"
run_case "钱包账本改回从余额倒减（错账隐藏器）" \
  "s/  const reliable = dated && !truncated && Math.abs\(cents - target\) <= WALLET_LEDGER_TOLERANCE_CENTS;/  const reliable = true;/" \
  "tests/money-guards.test.mjs"
run_case "手机号护栏用 String() 兜底（数组也当合法号）" \
  "s/  if \(typeof raw !== 'string'\) return null;          \/\/ 严格类型：array\/object\/number 一律非法/  raw = String(raw == null ? '' : raw);/" \
  "tests/money-guards.test.mjs"
run_case "充值令牌只比金额（换人复用即通过）" \
  "s/  const prevUid = prev.user_id \|\| null;\n  if \(prevUid \|\| userId\) return !!prevUid && prevUid === userId;/  return true;/" \
  "tests/money-guards.test.mjs"
run_case "预约放行闸门失效（date-only 恒拒）" \
  "s/    if \(allowFutureDateOnly && wantDate/    if (false \&\& wantDate/" \
  "tests/money-guards.test.mjs"
run_case "Telegram 复制串静默截断（丢单号与送达时间）" \
  "s/  \/\/ 按行切成两段，尽量在换行处断开，避免把一个地址劈成两半/  return [[{ text: label, copy_text: { text: s.slice(0, TG_COPY_MAX) } }]];/" \
  "tests/refund-engine.test.mjs"
run_case "订单金额层去掉优惠封顶（记下 优惠999/小计20 的矛盾行）" \
  "s/  const discountApplied = Math.min\(money\(discount\), money\(subtotal\)\);/  const discountApplied = money(discount);/" \
  "tests/refund-engine.test.mjs"
# 【等价变异·已核实】去掉 goods 的 Math.max(0,…) 不会被抓住，但这【不是测试瞎】：
# 上一行的 discountApplied 已经把 discount 封顶到 subtotal，所以 subtotal-discount 恒 >=0，
# 这个 Math.max 在当前代码路径下不可达。属于冗余防线，保留但不计入漏网。
run_case "履约状态白名单失效（任意值都收）" \
  "s/  if \(typeof s !== 'string'\) return 'new';/  s = String(s == null ? '' : s);/" \
  "tests/money-guards.test.mjs"
run_case "把 Lalamove 叫车接回可达路径（老板明确要求只报价不叫车）" \
  "s/(if \\(pathname === '\\/api\\/menu' && req.method === 'GET'\\) \\{)/if (pathname === '\\/api\\/__mut') { await lalamoveCreateOrder(env, {}, {}, {}, {}); }\\n      \$1/" \
  "tests/no-dispatch-gate.test.mjs"
run_case "退运费按钮不检查是否已退（可重复退）" \
  "s/  if \(fee > 0 && o.pay_status === 'PAID' && !\(\+o.refunded_total > 0\)\) \{/  if (fee > 0) {/" \
  "tests/refund-engine.test.mjs"

# ── 公开内容发布 ───────────────────────────────────────────────────────────
run_case "缓存命中前先查 D1（暖命中不再是零查询）" \
  "s/  let hit=null;\n  try \{ hit=await cache.match\(key\); \}/  await env.DB.prepare('SELECT 1').first(); let hit=null;\n  try { hit=await cache.match(key); }/" \
  "tests/public-cache.test.mjs" \
  "worker/public-cache.js"
run_case "店面恢复启动请求 /api/menu（正常浏览又开始打 D1）" \
  "s/function hydrateFromRelease\(\) \{/function hydrateFromRelease() { fetch('\/api\/menu');/" \
  "tests/public-cache.test.mjs" \
  "web/storefront.js"
run_case "普通导航就急着问停业状态" \
  "s/async function load\(\) \{\n  hydrateFromRelease\(\);/async function load() {\n  fetch('\/api\/store-status');\n  hydrateFromRelease();/" \
  "tests/public-cache.test.mjs" \
  "web/storefront.js"
run_case "下单绕过 menu_revision（客户端旧价直接成交）" \
  "s/menu_revision: acceptedRevisionForCart\(\) \|\| _cartRevision \|\| window.HL_MENU_REVISION,//" \
  "tests/public-cache.test.mjs" \
  "web/storefront.js"
run_case "陈旧菜单不再 409（旧价直接成交）" \
  "s/if \(menuRevision!==active \|\| changes.length\)/if (false)/" \
  "tests/release-pricing.test.mjs" \
  "worker/publication.js"
run_case "嵌入 JSON 不再转义 <（页面可被 </script> 截断）" \
  "s/\.replace\(\/<\/g,'\\\\\\\\u003c'\)//" \
  "tests/publication-core.test.mjs" \
  "worker/publication.js"
run_case "JSON-LD 少发 Offer（结构化数据缺斤少两）" \
  "s/    \.\.\.products.map\(product=>\(\{'\@type':'Offer'/    ...[].map(product=>({'\@type':'Offer'/" \
  "tests/public-render.test.mjs" \
  "worker/public-render.js"
run_case "私有响应不再 noindex（后台/发票可被索引）" \
  "s/  out.headers.set\('x-robots-tag','noindex, nofollow, noarchive'\);//" \
  "tests/public-cache.test.mjs" \
  "worker/public-cache.js"
run_case "去掉一分钟 Cron（发布永远不生效）" \
  "s/\"\* \* \* \* \*\", //" \
  "tests/restored-features.test.mjs" \
  "wrangler.toml"

echo
echo "=== 对照组：不改代码，必须全绿（证明这套框架不是恒红）==="
CONTROL_STARTED=$SECONDS
seed_work
if prepare_bundle; then
  CONTROL_OUT="$(run_tests)"; CONTROL_RC=$?
  printf '%s\n' "$CONTROL_OUT" > "$WORK/test-output.txt"
  echo "    tests=tests/*.test.mjs │ exit=$CONTROL_RC │ elapsed=$((SECONDS-CONTROL_STARTED))s │ evidence=$WORK/test-output.txt"
  printf '%s\n' "$CONTROL_OUT" | tail -9
  if [ "$CONTROL_RC" -eq 0 ]; then echo "  ✅ 对照组全绿";
  else echo "  ❌ 对照组竟然红了 —— 框架本身有问题"; FAIL=$((FAIL+1)); fi
else
  echo "  ❌ 对照组打包失败 —— 框架本身有问题"; FAIL=$((FAIL+1))
fi

echo
echo "=== 结果：$PASS 条被抓住 / $FAIL 条漏网 ==="
[ "$FAIL" -eq 0 ]
