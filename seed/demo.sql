-- Hawkerline demo menu: a fictional dim-sum takeaway used by the test-suite and by `npm run demo:seed`.
-- It is sample data only. A real store starts from an empty menu (or lets an agent import its own).
-- Prices are in SGD. Images are left empty so the storefront shows its neutral placeholder.

INSERT INTO app_settings (k, v, updated_at) VALUES ('menu_categories', '[{"key":"combo","cn":"套餐","en":"Set Meals"},{"key":"meal","cn":"单人餐","en":"Meals"},{"key":"family","cn":"家庭装","en":"Family Boxes"},{"key":"protein","cn":"肉包","en":"Meat Buns"},{"key":"lowcal","cn":"素包","en":"Vegetable Buns"},{"key":"tea","cn":"甜点","en":"Sweets"},{"key":"drink","cn":"饮品","en":"Drinks"}]', datetime('now'))
  ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at;
INSERT INTO app_settings (k, v, updated_at) VALUES ('brand_name_cn', '示例点心铺', datetime('now')) ON CONFLICT(k) DO NOTHING;
INSERT INTO app_settings (k, v, updated_at) VALUES ('brand_name_en', 'Demo Dim Sum', datetime('now')) ON CONFLICT(k) DO NOTHING;

-- products
INSERT OR IGNORE INTO products (sku,name_cn,name_en,price,category,kcal,img,active,sort,description_cn,description_en,detail_cn,detail_en,components) VALUES ('S01','鲜肉包','Pork Bun',3.6,'protein',260,'',1,1,'','','','','');
INSERT OR IGNORE INTO products (sku,name_cn,name_en,price,category,kcal,img,active,sort,description_cn,description_en,detail_cn,detail_en,components) VALUES ('S02','牛肉包','Beef Bun',3.8,'protein',280,'',1,2,'','','','','');
INSERT OR IGNORE INTO products (sku,name_cn,name_en,price,category,kcal,img,active,sort,description_cn,description_en,detail_cn,detail_en,components) VALUES ('S03','酱肉包','Braised Pork Bun',4.5,'protein',320,'',1,3,'','','','','');
INSERT OR IGNORE INTO products (sku,name_cn,name_en,price,category,kcal,img,active,sort,description_cn,description_en,detail_cn,detail_en,components) VALUES ('S04','梅干菜肉包','Preserved Vegetable Pork Bun',4.2,'protein',240,'',1,4,'','','','','');
INSERT OR IGNORE INTO products (sku,name_cn,name_en,price,category,kcal,img,active,sort,description_cn,description_en,detail_cn,detail_en,components) VALUES ('S05','炒酱肉包','Sauced Pork Bun',3.5,'protein',290,'',1,5,'','','','','');
INSERT OR IGNORE INTO products (sku,name_cn,name_en,price,category,kcal,img,active,sort,description_cn,description_en,detail_cn,detail_en,components) VALUES ('S06','茄子包','Eggplant Bun',3.2,'lowcal',190,'',1,6,'','','','','');
INSERT OR IGNORE INTO products (sku,name_cn,name_en,price,category,kcal,img,active,sort,description_cn,description_en,detail_cn,detail_en,components) VALUES ('S07','青菜香菇包','Vegetable & Mushroom Bun',3.2,'lowcal',180,'',1,7,'','','','','');
INSERT OR IGNORE INTO products (sku,name_cn,name_en,price,category,kcal,img,active,sort,description_cn,description_en,detail_cn,detail_en,components) VALUES ('S08','麻辣豆腐包','Mala Tofu Bun',3.2,'lowcal',220,'',1,8,'','','','','');
INSERT OR IGNORE INTO products (sku,name_cn,name_en,price,category,kcal,img,active,sort,description_cn,description_en,detail_cn,detail_en,components) VALUES ('S09','豆沙包','Red Bean Bun',2.8,'tea',210,'',1,9,'','','','','');
INSERT OR IGNORE INTO products (sku,name_cn,name_en,price,category,kcal,img,active,sort,description_cn,description_en,detail_cn,detail_en,components) VALUES ('S10','椰蓉包','Coconut Bun',2.8,'tea',220,'',1,10,'','','','','');
INSERT OR IGNORE INTO products (sku,name_cn,name_en,price,category,kcal,img,active,sort,description_cn,description_en,detail_cn,detail_en,components) VALUES ('S11','红糖花卷','Brown Sugar Roll',2.5,'tea',230,'',1,11,'','','','','');
INSERT OR IGNORE INTO products (sku,name_cn,name_en,price,category,kcal,img,active,sort,description_cn,description_en,detail_cn,detail_en,components) VALUES ('S12','糖三角','Sugar Triangle Bun',2.5,'tea',210,'',1,12,'','','','','');
INSERT OR IGNORE INTO products (sku,name_cn,name_en,price,category,kcal,img,active,sort,description_cn,description_en,detail_cn,detail_en,components) VALUES ('S13','葱油花卷','Spring Onion Roll',2,'tea',170,'',1,13,'','','','','');
INSERT OR IGNORE INTO products (sku,name_cn,name_en,price,category,kcal,img,active,sort,description_cn,description_en,detail_cn,detail_en,components) VALUES ('C1','均衡套餐','Balanced Set',12.8,'combo',720,'',1,14,'','','','','[{"sku":"S01","qty":1},{"sku":"S02","qty":1},{"sku":"S06","qty":1},{"sku":"S07","qty":1}]');
INSERT OR IGNORE INTO products (sku,name_cn,name_en,price,category,kcal,img,active,sort,description_cn,description_en,detail_cn,detail_en,components) VALUES ('C2','荤食套餐','Meat Lover Set',16.8,'combo',920,'',1,15,'','','','','[{"sku":"S01","qty":1},{"sku":"S02","qty":1},{"sku":"S04","qty":1},{"sku":"S05","qty":1}]');
INSERT OR IGNORE INTO products (sku,name_cn,name_en,price,category,kcal,img,active,sort,description_cn,description_en,detail_cn,detail_en,components) VALUES ('C3','素食套餐','Vegetarian Set',10.8,'combo',580,'',1,16,'','','','','[{"sku":"S06","qty":1},{"sku":"S07","qty":2},{"sku":"S13","qty":1}]');
INSERT OR IGNORE INTO products (sku,name_cn,name_en,price,category,kcal,img,active,sort,description_cn,description_en,detail_cn,detail_en,components) VALUES ('C4','日常套餐','Everyday Set',10.8,'combo',650,'',1,17,'','','','','[{"sku":"S01","qty":1},{"sku":"S07","qty":1},{"sku":"S05","qty":1},{"sku":"S11","qty":1}]');
INSERT OR IGNORE INTO products (sku,name_cn,name_en,price,category,kcal,img,active,sort,description_cn,description_en,detail_cn,detail_en,components) VALUES ('C5','招牌套餐','House Set',12.8,'combo',760,'',1,18,'','','','','');
INSERT OR IGNORE INTO products (sku,name_cn,name_en,price,category,kcal,img,active,sort,description_cn,description_en,detail_cn,detail_en,components) VALUES ('F6','家庭装（小）','Family Box S',16.8,'family',1020,'',1,19,'','','','','[{"sku":"S01","qty":2},{"sku":"S02","qty":2},{"sku":"S07","qty":2}]');
INSERT OR IGNORE INTO products (sku,name_cn,name_en,price,category,kcal,img,active,sort,description_cn,description_en,detail_cn,detail_en,components) VALUES ('F7','家庭装（中）','Family Box M',33.8,'family',2050,'',1,20,'','','','','[{"sku":"S01","qty":2},{"sku":"S02","qty":2},{"sku":"S04","qty":2},{"sku":"S07","qty":2},{"sku":"S06","qty":2},{"sku":"S13","qty":2}]');
INSERT OR IGNORE INTO products (sku,name_cn,name_en,price,category,kcal,img,active,sort,description_cn,description_en,detail_cn,detail_en,components) VALUES ('F8','家庭装（大）','Family Box L',50.8,'family',3150,'',1,21,'','','','','');
INSERT OR IGNORE INTO products (sku,name_cn,name_en,price,category,kcal,img,active,sort,description_cn,description_en,detail_cn,detail_en,components) VALUES ('F9','肉包分享装','Meat Bun Sharing Box',69.8,'family',3600,'',1,22,'','','','','[{"sku":"S01","qty":5},{"sku":"S02","qty":5},{"sku":"S04","qty":4},{"sku":"S05","qty":4}]');

-- product_tags
INSERT OR IGNORE INTO product_tags (id,label_cn,label_en,tone,icon,active,sort,created_at,updated_at) VALUES ('new-arrival','新品上架','New arrival','gold','✨',1,10,'2026-11-04 09:10:11','2026-11-04 09:10:11');
INSERT OR IGNORE INTO product_tags (id,label_cn,label_en,tone,icon,active,sort,created_at,updated_at) VALUES ('low-cal-healthy','低卡健康','Low-calorie','green','🌿',1,20,'2026-11-04 09:10:11','2026-11-04 09:10:11');
INSERT OR IGNORE INTO product_tags (id,label_cn,label_en,tone,icon,active,sort,created_at,updated_at) VALUES ('fresh-meat','纯鲜肉','Fresh meat','red','🥩',1,30,'2026-11-04 09:10:11','2026-11-04 09:10:11');
INSERT OR IGNORE INTO product_tags (id,label_cn,label_en,tone,icon,active,sort,created_at,updated_at) VALUES ('meat-veg-balance','荤素搭配','Meat & veg','blue','🥬',1,40,'2026-11-04 09:10:11','2026-11-04 09:10:11');

-- promo_codes
INSERT OR IGNORE INTO promo_codes (code,kind,value,min_spend,starts,ends,max_uses,used,active,note,created_at,pickup_only,per_account_limit,fulfil_only,first_order_only,login_required) VALUES ('NEW80','percent',20,0,NULL,NULL,0,0,1,'官网新会员首单 20% OFF','2026-11-04 09:10:11',0,1,'pickup,discount,anytime,walkin',1,1);

-- homepage_posters
INSERT OR IGNORE INTO homepage_posters (id,title_cn,title_en,body_cn,body_en,badge,image_url,image_data,image_version,action_type,action_value,cta_cn,cta_en,active,show_on_open,show_on_home,sort,starts,ends,created_at,updated_at) VALUES ('first-order-new80','首单立减 20%','20% OFF your first order','登录会员，优惠码已为你准备好。自取、拼单和随时送均可使用。','Sign in as a member. Valid for pickup, group delivery and anytime delivery.','NEW80','','','','promo','NEW80','一键使用优惠','Use 20% OFF',1,1,1,10,NULL,NULL,'2026-11-04 09:10:11','2026-11-04 09:10:11');
