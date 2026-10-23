import type { FastifyReply } from "fastify";
import type { IdempotencyOutcome } from "../idempotency.js";

// 멱등 키 결과를 응답으로 보낸다. 다시 보낸 요청에는 처음 응답을 그대로 주고 Idempotent-Replayed 헤더를 붙인다.
// 본문의 serverTime과 상태도 처음 것이라, 화면은 이 헤더를 보면 조회로 최신 상태를 다시 읽는다(DESIGN 6.2 멱등성).
export function sendIdempotent(reply: FastifyReply, outcome: IdempotencyOutcome) {
  switch (outcome.kind) {
    case "key_reused":
      return reply
        .code(422)
        .send({ error: "이 Idempotency-Key는 다른 요청에 쓰였습니다", code: "IDEMPOTENCY_KEY_REUSED" });
    case "in_progress":
      return reply
        .code(409)
        .header("retry-after", "1")
        .send({ error: "같은 요청을 처리하고 있습니다. 잠시 뒤 같은 Idempotency-Key로 다시 보내 주세요", code: "REQUEST_IN_PROGRESS" });
    case "response":
      if (outcome.replayed) reply.header("idempotent-replayed", "true");
      if (outcome.response.headers) reply.headers(outcome.response.headers);
      return reply.code(outcome.response.statusCode).send(outcome.response.body);
  }
}
