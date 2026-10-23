import { ErrorResponse } from "@seat-booking/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { type FakePaymentProvider, SIGNATURE_HEADER } from "../fake-pay.js";
import { handleWebhook } from "../payments.js";

// 결제사가 보내는 본문. 화면과 주고받지 않으므로 shared가 아니라 여기에 둔다.
const WebhookBody = z.object({
  eventId: z.string().min(1).max(255),
  paymentId: z.number().int().positive(),
  providerRef: z.string().min(1).max(255),
  type: z.string().min(1).max(100),
});
const WebhookReceived = z.object({ result: z.enum(["processed", "ignored", "unmatched", "duplicate"]) });

// 가짜 결제사의 웹훅(DESIGN 6.2 웹훅 받기). 서명이 맞으면 중복·늦은·모르는 웹훅도 200이다. 결제사는 200을 받을 때까지 다시 보낸다.
export const webhookRoutes: FastifyPluginAsyncZod<{ db: Db; provider: FakePaymentProvider }> = async (
  app,
  { db, provider },
) => {
  // 서명은 받은 글자 그대로에 대해 확인한다. 이 플러그인 안에서만 JSON 본문을 문자열로 받아 두고 직접 푼다.
  // 받은 본문 전체(검증에서 빠지는 필드까지)는 웹훅 행에 남긴다.
  const received = new WeakMap<object, { raw: string; parsed: object }>();
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    const raw = body as string;
    try {
      const parsed = JSON.parse(raw) as object;
      received.set(request, { raw, parsed });
      done(null, parsed);
    } catch {
      done(Object.assign(new Error("본문이 JSON이 아닙니다"), { statusCode: 400 }), undefined);
    }
  });

  app.post(
    "/webhooks/fake-pay",
    {
      schema: { body: WebhookBody, response: { 200: WebhookReceived, 401: ErrorResponse } },
      // 본문을 푼 뒤, 검증하기 전에 서명을 본다. JSON으로 풀리는 본문이면 서명이 틀린 요청은 모양과 상관없이 401이다.
      // JSON이 아니면 서명을 보기 전에 400이다. 서명이 맞는데 모양이 틀리면 400이고 남기지 않는다(DESIGN 10장 49).
      preValidation: async (request, reply) => {
        const signature = request.headers[SIGNATURE_HEADER];
        const body = received.get(request);
        if (typeof signature !== "string" || !body || !provider.verify(body.raw, signature)) {
          return reply.code(401).send({ error: "서명이 맞지 않습니다" });
        }
      },
    },
    async (request) => {
      const result = await handleWebhook(db, request.body, received.get(request)!.parsed, request.log);
      return { result };
    },
  );
};
