-- Hawkerline baseline schema.
-- Apply with: npx wrangler d1 migrations apply DB --local   (add --remote for your Cloudflare account)
-- Later schema changes go into new numbered files (0002_..., 0003_...); never edit an applied migration.

CREATE TABLE orders (
  id            TEXT PRIMARY KEY,        -- uuid
  invoice_no    TEXT UNIQUE NOT NULL,    -- <INVOICE_PREFIX>-YYYYMMDD-#### (human ref)
  created_at    TEXT NOT NULL,           -- ISO8601
  customer_name TEXT NOT NULL,
  phone         TEXT NOT NULL,           -- E.164, e.g. +6591234567
  items_json    TEXT NOT NULL,           -- [{sku,name,qty,unit_price}]
  subtotal      REAL NOT NULL,
  delivery_fee  REAL NOT NULL DEFAULT 0,
  total         REAL NOT NULL,
  fulfilment    TEXT NOT NULL,           -- 'delivery' | 'pickup'
  address       TEXT,
  deliver_at    TEXT,                    -- requested date (future orders)
  pay_provider  TEXT,                    -- 'manual_qr' | 'hitpay' | 'stripe'
  pay_ref       TEXT,                    -- gateway order id / PayNow reference
  pay_status    TEXT NOT NULL DEFAULT 'UNPAID',  -- UNPAID | PAID | EXPIRED | REFUNDED
  paid_at       TEXT,
  wa_sent_at    TEXT,                    -- WhatsApp invoice sent timestamp
  raw_webhook   TEXT,                    -- gateway callback payload (audit trail)
  note          TEXT
, source TEXT NOT NULL DEFAULT 'online', pay_txn TEXT, cashier TEXT, promo_code TEXT, discount REAL NOT NULL DEFAULT 0, paid_by_balance REAL NOT NULL DEFAULT 0, route_id TEXT, unit_no TEXT, fulfil_status TEXT NOT NULL DEFAULT 'new', status_msg    TEXT, delay_minutes INTEGER, arrived_at     TEXT, status_at      TEXT, cancelled_at        TEXT, cancel_reason       TEXT, balance_refund_ref  TEXT, balance_refunded_at TEXT, client_token TEXT, deliver_time TEXT, promo_claimed INTEGER NOT NULL DEFAULT 0, service_charge REAL NOT NULL DEFAULT 0, service_charge_rate REAL NOT NULL DEFAULT 0, gst REAL NOT NULL DEFAULT 0, gst_rate REAL NOT NULL DEFAULT 0, gst_registered INTEGER NOT NULL DEFAULT 0, user_id TEXT, request_fingerprint TEXT, request_member_phone TEXT, phone_canonical TEXT, refunded_total REAL NOT NULL DEFAULT 0, menu_revision TEXT);

CREATE TABLE products (
  sku        TEXT PRIMARY KEY,
  name_cn    TEXT NOT NULL,
  name_en    TEXT NOT NULL,
  price      REAL NOT NULL,
  category   TEXT NOT NULL,              -- 'combo' | 'family' | 'protein' | 'lowcal' | 'tea'
  kcal       INTEGER,
  img        TEXT,
  -- ⚠️ description_cn / description_en / detail_cn / detail_en 【故意不在这里定义】。
  --    它们由 0023_product_description_detail.sql 用 ALTER TABLE 添加。
  --    历史上这 4 列被同时写进了本文件和 0023，导致 migrations【无法从零重放】
  --    （跑到 0023 就 duplicate column name 中断，灾备重建数据库这条路是断的）。
  --    生产库早已应用过两者、列都在，删掉这里不影响生产（历史 migration 不会重跑）。
  active     INTEGER NOT NULL DEFAULT 1,
  sort       INTEGER NOT NULL DEFAULT 0
, description_cn TEXT NOT NULL DEFAULT '', description_en TEXT NOT NULL DEFAULT '', detail_cn TEXT NOT NULL DEFAULT '', detail_en TEXT NOT NULL DEFAULT '', components TEXT NOT NULL DEFAULT '');

CREATE TABLE members (
  phone        TEXT PRIMARY KEY,        -- normalised digits, e.g. 6591234567
  name         TEXT,
  points       INTEGER NOT NULL DEFAULT 0,   -- 1 point per S$1 paid
  total_spent  REAL NOT NULL DEFAULT 0,
  orders_count INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT,
  updated_at   TEXT
, balance REAL NOT NULL DEFAULT 0, email TEXT, pass_hash TEXT, pass_salt TEXT, google_sub TEXT, birthday TEXT, admin_note TEXT, user_id TEXT, merged_to_user_id TEXT, merged_at         TEXT, archived_at     TEXT, archive_reason  TEXT, archived_by     TEXT);

CREATE TABLE payment_events (
  event_id   TEXT PRIMARY KEY,        -- Stripe event id (evt_...)
  type       TEXT,
  order_id   TEXT,
  amount     REAL,                     -- amount from the event (SGD)
  status     TEXT,                     -- resulting action: PAID|FAILED|EXPIRED|REFUNDED|MISMATCH|IGNORED
  created_at TEXT,
  raw        TEXT
);

CREATE TABLE topups (
  id TEXT PRIMARY KEY, phone TEXT NOT NULL, amount REAL NOT NULL, bonus REAL NOT NULL DEFAULT 0,
  credited REAL NOT NULL, pay_method TEXT, pay_status TEXT NOT NULL DEFAULT 'PAID',
  cashier TEXT, created_at TEXT, note TEXT
, client_token TEXT, user_id TEXT);

CREATE TABLE promo_codes (
  code TEXT PRIMARY KEY,            -- 大写
  kind TEXT NOT NULL,              -- 'percent' | 'fixed'
  value REAL NOT NULL,            -- percent: 10 = 9折; fixed: 5 = 减$5
  min_spend REAL NOT NULL DEFAULT 0,
  starts TEXT, ends TEXT,          -- YYYY-MM-DD 促销时段(含)
  max_uses INTEGER NOT NULL DEFAULT 0,  -- 0=不限
  used INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  note TEXT, created_at TEXT
, pickup_only INTEGER NOT NULL DEFAULT 0, per_account_limit INTEGER NOT NULL DEFAULT 0, fulfil_only TEXT NOT NULL DEFAULT '', first_order_only INTEGER NOT NULL DEFAULT 0, login_required INTEGER NOT NULL DEFAULT 0);

CREATE TABLE otp_codes (
  phone TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  expires TEXT NOT NULL,          -- ISO 过期时间
  tries INTEGER NOT NULL DEFAULT 0,
  created_at TEXT
);

CREATE TABLE routes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,            -- 如「今晚顺路 D9/D10/D11」
  blocks TEXT,                   -- 覆盖的座号/区域,如 "D9, D10, D11"
  fee REAL NOT NULL DEFAULT 0,   -- 拼单运费(比单独叫便宜)
  cutoff TEXT,                   -- 截单时间 ISO 或 "YYYY-MM-DD HH:MM"
  run_at TEXT,                   -- 预计送达/出发时间(可选)
  note TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT
, from_postal TEXT, to_postal   TEXT, from_addr   TEXT, to_addr     TEXT, from_lat    REAL, from_lng    REAL, to_lat      REAL, to_lng      REAL, geometry    TEXT, areas       TEXT, distance_m  INTEGER, duration_s  INTEGER);

CREATE TABLE app_settings (k TEXT PRIMARY KEY, v TEXT, updated_at TEXT);

CREATE TABLE order_events (
  id         TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL,
  actor      TEXT NOT NULL,
  type       TEXT NOT NULL,
  message    TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE wallet_events (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,              -- 'refund'（UNPAID 取消退储值 / PAID 退款退储值）
  ref        TEXT NOT NULL,              -- 与 orders.balance_refund_ref 对应
  order_id   TEXT,
  phone      TEXT,
  amount     REAL NOT NULL DEFAULT 0,    -- 退回 members.balance 的金额（正数）
  created_at TEXT,
  note       TEXT, user_id TEXT,
  UNIQUE(ref),
  UNIQUE(type, order_id)                 -- 防重复退：同一订单同一事件类型唯一
);

CREATE TABLE daily_seq (
  day TEXT PRIMARY KEY,        -- YYYYMMDD
  seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE auth_throttle (
  scope        TEXT NOT NULL,           -- 'pos_login' | 'otp_req'
  id           TEXT NOT NULL,           -- pos_login: cashier|ip ; otp_req: phone
  window_start TEXT NOT NULL,           -- 当前计数窗口起点 ISO
  count        INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,                    -- 非空且 > now 表示锁定中
  updated_at   TEXT,
  PRIMARY KEY (scope, id)
);

CREATE TABLE pos_pins (
  cashier    TEXT PRIMARY KEY,
  pin_hash   TEXT NOT NULL,           -- PBKDF2 hex
  pin_salt   TEXT NOT NULL,           -- 盐 hex
  updated_at TEXT
);

CREATE TABLE print_jobs (
  id          TEXT PRIMARY KEY,
  order_id    TEXT,
  kind        TEXT NOT NULL DEFAULT 'kitchen',   -- kitchen | receipt
  content     TEXT NOT NULL,                      -- 预渲染的小票文本（设备直接打）
  status      TEXT NOT NULL DEFAULT 'pending',    -- pending | printed
  created_at  TEXT,
  printed_at  TEXT,
  UNIQUE(order_id, kind)
);

CREATE TABLE telegram_subscribers (
  chat_id  TEXT PRIMARY KEY,
  name     TEXT,
  added_at TEXT
);

CREATE TABLE attendance_records (
  id            TEXT PRIMARY KEY,
  staff         TEXT NOT NULL,
  business_date TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK(kind IN ('in','out')),
  punched_at    TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'pos',
  note          TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE(staff, business_date, kind)
);

CREATE TABLE delivery_jobs (
  id                  TEXT PRIMARY KEY,
  order_id            TEXT NOT NULL UNIQUE,
  provider            TEXT NOT NULL,
  provider_order_id   TEXT,
  provider_status     TEXT,
  state               TEXT NOT NULL DEFAULT 'created',
  quote_id            TEXT,
  fee                 REAL NOT NULL DEFAULT 0,
  currency            TEXT NOT NULL DEFAULT 'SGD',
  rider_name          TEXT,
  rider_phone         TEXT,
  share_link          TEXT,
  dispatch_requested_at TEXT,
  assigned_at         TEXT,
  picked_up_at        TEXT,
  delivered_at        TEXT,
  cancelled_at        TEXT,
  refund_status       TEXT,
  refund_ref          TEXT,
  last_event_at       TEXT,
  raw_last            TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
, failure_reason TEXT, decision TEXT, decision_at TEXT, decision_by TEXT);

CREATE TABLE user_accounts (
  id          TEXT PRIMARY KEY,
  phone       TEXT,
  name        TEXT,
  birthday    TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE auth_identities (
  provider      TEXT NOT NULL CHECK(provider IN ('google', 'apple')),
  provider_sub  TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  email         TEXT,
  display_name  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (provider, provider_sub),
  UNIQUE (user_id, provider),
  FOREIGN KEY (user_id) REFERENCES user_accounts(id)
);

CREATE TABLE oauth_states (
  state_hash  TEXT PRIMARY KEY,
  provider    TEXT NOT NULL CHECK(provider IN ('google', 'apple')),
  user_id     TEXT,
  nonce       TEXT NOT NULL,
  origin      TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user_accounts(id)
);

CREATE TABLE promo_batches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,                          -- 老板起的批次名，如「6月组屋派发」
  kind TEXT NOT NULL,                          -- 'percent' | 'fixed'（与 promo_codes 同语义）
  value REAL NOT NULL,
  min_spend REAL NOT NULL DEFAULT 0,
  starts TEXT,                                 -- YYYY-MM-DD，SGT 营业日口径
  ends TEXT,
  login_required INTEGER NOT NULL DEFAULT 1,   -- 批次级可配：线下拉新批次可关
  fulfil_only TEXT NOT NULL DEFAULT '',        -- 与 promo_codes 同语义：pickup,discount,anytime,walkin；''=不限
  qty INTEGER NOT NULL,                        -- 老板填的目标张数（不硬编码任何业务数字）
  status TEXT NOT NULL DEFAULT 'CREATING',     -- CREATING → READY（核对行数后）| FAILED
  active INTEGER NOT NULL DEFAULT 1,           -- 老板可整批停用
  created_at TEXT,
  note TEXT
);

CREATE TABLE promo_tickets (
  code TEXT PRIMARY KEY,                       -- 票号：crypto 随机 base32（去 0/O/1/I/L），不可枚举
  batch_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ACTIVE',        -- ACTIVE → RESERVED → REDEEMED（REDEEMED 是终态）
  order_id TEXT,                               -- RESERVED/REDEEMED 时指向订单
  phone TEXT,                                  -- 核销者手机号（审计用，存顾客原文）
  reserved_at TEXT,
  redeemed_at TEXT,
  created_at TEXT
);

CREATE TABLE homepage_posters (
  id TEXT PRIMARY KEY,
  title_cn TEXT NOT NULL,
  title_en TEXT NOT NULL DEFAULT '',
  body_cn TEXT NOT NULL DEFAULT '',
  body_en TEXT NOT NULL DEFAULT '',
  badge TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',             -- small same-origin/HTTPS URL
  image_data TEXT NOT NULL DEFAULT '',            -- compressed JPG/PNG/WebP data URL; lazy endpoint only
  image_version TEXT NOT NULL DEFAULT '',
  action_type TEXT NOT NULL DEFAULT 'none',       -- none | product | promo
  action_value TEXT NOT NULL DEFAULT '',          -- SKU or promo code
  cta_cn TEXT NOT NULL DEFAULT '',
  cta_en TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  show_on_open INTEGER NOT NULL DEFAULT 1,
  show_on_home INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  starts TEXT,                                    -- YYYY-MM-DD, SGT
  ends TEXT,                                      -- YYYY-MM-DD, SGT (inclusive)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE homepage_poster_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  revision TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE promo_account_redemptions (
  code                 TEXT NOT NULL,
  phone                TEXT NOT NULL,
  uses                 INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
  reservation_order_id TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (code, phone)
);

CREATE TABLE promo_order_claims (
  order_id   TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  phone      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE store_settings_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  revision TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE order_refunds (
  id             TEXT PRIMARY KEY,
  order_id       TEXT NOT NULL,
  kind           TEXT NOT NULL,                       -- 'delivery_fee' | 'full'
  amount         REAL NOT NULL DEFAULT 0,             -- 本次退给顾客的总额 = stripe_amount + balance_amount
  stripe_amount  REAL NOT NULL DEFAULT 0,             -- 原路退回银行卡/PayNow 的部分
  balance_amount REAL NOT NULL DEFAULT 0,             -- 退回会员储值余额的部分
  -- 现金部分：顾客当初递的是现钞（线下/柜台单），系统退不了，只能记账并提示老板当面退多少。
  -- 少了这一列，现金单要么退不了、要么被硬塞进 Stripe 那一侧报错。
  cash_amount    REAL NOT NULL DEFAULT 0,
  stripe_refund_id TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',     -- pending | succeeded | failed | manual_required
  reason         TEXT,
  actor          TEXT,                                -- admin | pos:<cashier> | telegram:<chat_id>
  idem_key       TEXT NOT NULL UNIQUE,
  error          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT
);

CREATE TABLE legacy_claims (
  id               TEXT PRIMARY KEY,
  pair_code        TEXT NOT NULL,              -- 6 位数字，顾客手输
  legacy_phone     TEXT NOT NULL,              -- normPhone 后的 8 位；= members.phone
  balance_at_start REAL NOT NULL DEFAULT 0,    -- 发起时的余额快照，供老板核对
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK(status IN ('pending','awaiting_approval','committed','cancelled','expired')),
  user_id          TEXT,                       -- 顾客绑定上来的账号；pending 阶段为 NULL
  tries            INTEGER NOT NULL DEFAULT 0, -- 配对码错误次数，>=5 视同作废
  created_by       TEXT NOT NULL,              -- 'pos1' / 'pos2' / 'boss'
  bound_at         TEXT,
  decided_by       TEXT,
  decided_at       TEXT,
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user_accounts(id)
);

CREATE TABLE legacy_merges (
  id              TEXT PRIMARY KEY,
  claim_id        TEXT NOT NULL,
  legacy_phone    TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  balance_moved   REAL    NOT NULL DEFAULT 0,
  points_moved    INTEGER NOT NULL DEFAULT 0,
  spent_moved     REAL    NOT NULL DEFAULT 0,
  orders_moved    INTEGER NOT NULL DEFAULT 0,
  order_ids_json  TEXT,                        -- JSON array of orders.id
  topup_ids_json  TEXT,                        -- JSON array of topups.id
  event_ids_json  TEXT,                        -- JSON array of wallet_events.id
  status          TEXT NOT NULL DEFAULT 'committed'
                    CHECK(status IN ('committed','reversed')),
  committed_by    TEXT NOT NULL,
  committed_at    TEXT NOT NULL,
  reversed_by     TEXT,
  reversed_at     TEXT,
  reverse_reason  TEXT,
  client_token    TEXT,
  FOREIGN KEY (user_id) REFERENCES user_accounts(id)
);

CREATE TABLE public_content_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  draft_revision TEXT NOT NULL,
  active_release_id TEXT,
  activation_nonce TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE public_content_releases (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('scheduled','published','superseded','cancelled')),
  effective_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'boss',
  source_revision TEXT NOT NULL,
  checksum TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  published_at TEXT
);

CREATE TABLE public_content_release_products (
  release_id TEXT NOT NULL, sku TEXT NOT NULL,
  name_cn TEXT NOT NULL, name_en TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL CHECK(price_cents>=0),
  category TEXT NOT NULL, kcal INTEGER, image_url TEXT NOT NULL DEFAULT '',
  description_cn TEXT NOT NULL DEFAULT '', description_en TEXT NOT NULL DEFAULT '',
  detail_cn TEXT NOT NULL DEFAULT '', detail_en TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
  tags_json TEXT NOT NULL DEFAULT '[]', components_json TEXT,
  PRIMARY KEY(release_id,sku)
);

CREATE TABLE public_content_release_pages (
  release_id TEXT NOT NULL, path TEXT NOT NULL,
  content_type TEXT NOT NULL, body TEXT NOT NULL, etag TEXT NOT NULL,
  PRIMARY KEY(release_id,path)
);

CREATE TABLE product_tags (
  id TEXT PRIMARY KEY, label_cn TEXT NOT NULL, label_en TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL CHECK(tone IN ('green','gold','red','blue','neutral')),
  icon TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE product_tag_assignments (
  sku TEXT NOT NULL, tag_id TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(sku,tag_id)
);

CREATE TABLE public_media (
  hash TEXT PRIMARY KEY, content_type TEXT NOT NULL, body BLOB NOT NULL,
  byte_length INTEGER NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE public_content_events (
  id TEXT PRIMARY KEY, release_id TEXT, action TEXT NOT NULL,
  actor TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);

CREATE INDEX idx_orders_status   ON orders(pay_status);

CREATE INDEX idx_orders_deliver  ON orders(deliver_at);

CREATE INDEX idx_orders_created  ON orders(created_at);

CREATE INDEX idx_members_points ON members(points);

CREATE INDEX idx_orders_source ON orders(source);

CREATE INDEX idx_payevt_order ON payment_events(order_id);

CREATE INDEX idx_topups_phone ON topups(phone);

CREATE INDEX idx_members_email ON members(email);

CREATE INDEX idx_routes_active ON routes(active);

CREATE INDEX idx_orders_fulfil ON orders(fulfil_status);

CREATE INDEX idx_orders_arrived ON orders(arrived_at);

CREATE INDEX idx_order_events_order ON order_events(order_id, created_at);

CREATE INDEX idx_wallet_events_phone ON wallet_events(phone);

CREATE INDEX idx_wallet_events_order ON wallet_events(order_id);

CREATE INDEX idx_print_jobs_status ON print_jobs(status, created_at);

CREATE UNIQUE INDEX idx_orders_client_token ON orders(client_token) WHERE client_token IS NOT NULL;

CREATE UNIQUE INDEX idx_topups_client_token ON topups(client_token) WHERE client_token IS NOT NULL;

CREATE INDEX idx_attendance_date ON attendance_records(business_date, punched_at);

CREATE INDEX idx_attendance_staff ON attendance_records(staff, business_date);

CREATE INDEX idx_delivery_jobs_state ON delivery_jobs(state, dispatch_requested_at);

CREATE INDEX idx_delivery_jobs_provider_order ON delivery_jobs(provider, provider_order_id);

CREATE INDEX idx_delivery_jobs_decision
  ON delivery_jobs(state, decision_at);

CREATE UNIQUE INDEX idx_user_accounts_phone
  ON user_accounts(phone)
  WHERE phone IS NOT NULL AND phone != '';

CREATE INDEX idx_auth_identities_user
  ON auth_identities(user_id);

CREATE INDEX idx_oauth_states_expiry
  ON oauth_states(expires_at);

CREATE UNIQUE INDEX idx_members_user_id
  ON members(user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX idx_orders_user_id_created
  ON orders(user_id, created_at);

CREATE INDEX idx_topups_user_id
  ON topups(user_id);

CREATE INDEX idx_wallet_events_user_id
  ON wallet_events(user_id);

CREATE INDEX idx_tickets_batch ON promo_tickets(batch_id, state);

CREATE INDEX idx_tickets_order ON promo_tickets(order_id);

CREATE INDEX idx_homepage_posters_active_sort
  ON homepage_posters(active, sort, updated_at);

CREATE INDEX idx_orders_phone_canonical
  ON orders(phone_canonical, pay_status);

CREATE INDEX idx_promo_order_claims_account
  ON promo_order_claims(code, phone);

CREATE INDEX idx_order_refunds_order ON order_refunds(order_id);

CREATE INDEX idx_order_refunds_status ON order_refunds(status);

CREATE INDEX idx_members_merged_to ON members(merged_to_user_id);

CREATE INDEX idx_legacy_claims_phone  ON legacy_claims(legacy_phone, status);

CREATE INDEX idx_legacy_claims_expiry ON legacy_claims(expires_at);

CREATE INDEX idx_legacy_claims_user   ON legacy_claims(user_id);

CREATE UNIQUE INDEX idx_legacy_claims_open
  ON legacy_claims(legacy_phone)
  WHERE status IN ('pending','awaiting_approval');

CREATE UNIQUE INDEX idx_legacy_claims_code
  ON legacy_claims(pair_code)
  WHERE status IN ('pending','awaiting_approval');

CREATE UNIQUE INDEX idx_legacy_merges_live
  ON legacy_merges(legacy_phone) WHERE status='committed';

CREATE UNIQUE INDEX idx_legacy_merges_token
  ON legacy_merges(client_token) WHERE client_token IS NOT NULL;

CREATE INDEX idx_legacy_merges_user  ON legacy_merges(user_id);

CREATE INDEX idx_legacy_merges_phone ON legacy_merges(legacy_phone);

CREATE INDEX idx_members_archived ON members(archived_at);

CREATE INDEX idx_public_releases_due
  ON public_content_releases(status,effective_at DESC,created_at DESC,id DESC);

CREATE INDEX idx_public_release_products_active
  ON public_content_release_products(release_id,active,sort,sku);

CREATE INDEX idx_product_tag_assignments_sort
  ON product_tag_assignments(sku,sort,tag_id);

CREATE INDEX idx_public_events_release
  ON public_content_events(release_id,created_at,id);

CREATE INDEX idx_public_events_action
  ON public_content_events(action,created_at,id);

-- System rows required by the Worker (no business data).
INSERT INTO public_content_state (singleton, draft_revision, active_release_id, activation_nonce, updated_at)
  VALUES (1, 'baseline-v1', NULL, '', datetime('now')) ON CONFLICT(singleton) DO NOTHING;
INSERT INTO store_settings_state (singleton, revision, updated_at) VALUES (1, 'baseline-v1', datetime('now')) ON CONFLICT(singleton) DO NOTHING;
INSERT INTO homepage_poster_state (singleton, revision, updated_at) VALUES (1, 'baseline-v1', datetime('now')) ON CONFLICT(singleton) DO NOTHING;
-- Orders created after these instants are covered by the automatic payment-safety sweeps.
INSERT INTO app_settings (k, v, updated_at) VALUES ('payment_safety_since', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(k) DO NOTHING;
INSERT INTO app_settings (k, v, updated_at) VALUES ('legacy_merge_since', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(k) DO NOTHING;
