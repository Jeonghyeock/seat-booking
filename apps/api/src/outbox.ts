import type { Tx } from "./db/client.js";
import { outboxEvents } from "./db/schema.js";

// 업무 이벤트 outbox(DESIGN 6.8). 업무 쓰기와 같은 트랜잭션에서 부른다. 업무가 되돌아가면 이벤트도 없고, 커밋되면 이벤트도 남는다.
// 키와 시각은 DB가 정한다(uuidv7(), 넣는 순간을 ms로 자른 clock_timestamp()). 보내기는 릴레이가 따로 한다.
// 성공 갈래에서만 부른다. 주문의 409와 결제 확정의 환불 갈래는 예외가 아니라 값으로 돌아와 커밋되므로 그 앞에 두면 안 된다(10장 101).
export type OutboxEvent =
  | { name: "seats_held"; properties: { performanceId: number; holdId: number; seats: number } }
  | { name: "order_created"; properties: { performanceId: number; holdId: number; orderId: number } }
  | { name: "payment_succeeded"; properties: { performanceId: number; orderId: number; paymentId: number } };

export async function recordEvent(tx: Tx, userId: number, event: OutboxEvent) {
  await tx.insert(outboxEvents).values({ userId, eventName: event.name, properties: event.properties });
}
