-- 내 예매(GET /orders)가 내 주문을 최근 것부터 찾는다(DESIGN 6.5, 10장 70).
CREATE INDEX "orders_user_created_idx" ON "orders" USING btree ("user_id","created_at");