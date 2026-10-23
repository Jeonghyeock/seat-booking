import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// 가짜 결제사(DESIGN 6.2 "가짜 결제사"). 같은 서버 안의 모듈이지만 바깥 결제사처럼 다룬다.
// 상태는 메모리에만 둔다. 서버를 다시 띄우면 결제사의 기록과 보내지 못한 웹훅이 사라지고, 우리 쪽은 대사 작업이 맞춘다.

// 결제 요청 본문의 scenario(DESIGN 10장 20).
// success·fail: 결과 웹훅 한 번. duplicate: 같은 이벤트를 두 번. out_of_order: 결과를 먼저, 그보다 앞서 생긴 중간 상태를 나중에.
// early: 결제 요청의 응답보다 먼저 웹훅을 보낸다. lost: 웹훅을 보내지 않는다.
export const SCENARIOS = ["success", "fail", "duplicate", "out_of_order", "early", "lost"] as const;
export type Scenario = (typeof SCENARIOS)[number];

export type FakePayEvent = {
  eventId: string;
  paymentId: number;
  providerRef: string;
  type: "payment.processing" | "payment.succeeded" | "payment.failed";
};
// 보낼 웹훅. 서명한 그 문자열을 그대로 보내야 받는 쪽의 서명 확인이 맞는다.
export type SignedWebhook = { rawBody: string; signature: string };
export type QueuedWebhook = SignedWebhook & { delayMs: number };
// 웹훅을 보내고 HTTP 상태 코드를 돌려준다. 앱의 웹훅 경로로 보낸다(buildApp이 app.inject로 잇는다).
export type Deliver = (webhook: SignedWebhook) => Promise<number>;

export type CreateResult = { kind: "created"; providerRef: string } | { kind: "voided" };
export type LookupResult =
  | { status: "succeeded" | "failed"; providerRef: string }
  | { status: "voided" }
  | { status: "unknown" };
export type VoidResult = { kind: "voided" } | { kind: "exists"; status: "succeeded" | "failed"; providerRef: string };
export type RefundResult = { kind: "refunded" } | { kind: "unknown" };

// 2xx를 받지 못하면 1·2·4·8·16초 뒤 다시 보낸다(다섯 번).
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

export function signWebhook(secret: string, rawBody: string) {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifyWebhook(secret: string, rawBody: string, signature: string) {
  const expected = Buffer.from(signWebhook(secret, rawBody), "hex");
  const given = Buffer.from(signature, "hex");
  // timingSafeEqual은 길이가 다르면 예외를 던진다. 16진수가 아닌 글자는 Buffer.from이 버려 길이가 줄어든다.
  return given.length === expected.length && timingSafeEqual(given, expected);
}

type ProviderPayment = { providerRef: string; amount: number; outcome: "succeeded" | "failed"; refunded: boolean };
type Logger = { warn: (obj: object, msg: string) => void };

export class FakePaymentProvider {
  // 결제사 장애를 흉내 낸다. true면 결제 만들기가 실패한다.
  outage = false;
  private readonly payments = new Map<number, ProviderPayment>();
  private readonly voided = new Set<number>();
  private queue: QueuedWebhook[] = [];
  private deliver: Deliver | undefined;
  private log: Logger | undefined;

  constructor(private readonly secret: string) {}

  connect(deliver: Deliver) {
    this.deliver = deliver;
  }

  // 개발 서버에서만 켠다. 웹훅을 delayMs 뒤 보내고, 실패하면 다시 보낸다.
  // 테스트는 켜지 않고 쌓인 웹훅을 takeQueued·flush로 원하는 순서에 보낸다.
  useTimers(log: Logger) {
    this.log = log;
  }

  // 결제 id가 멱등 키다. 같은 id로 다시 부르면 같은 결제를 돌려주고 웹훅을 다시 쌓지 않는다.
  // 무효로 한 id면 만들지 않는다(VOIDED). 결제사 안에서는 무효와 만들기 중 먼저 온 것만 효과가 있다.
  async create(input: { paymentId: number; amount: number; scenario: Scenario; delayMs: number }): Promise<CreateResult> {
    const { paymentId, amount, scenario, delayMs } = input;
    if (this.outage) throw new Error("가짜 결제사 장애");
    if (this.voided.has(paymentId)) return { kind: "voided" };
    const existing = this.payments.get(paymentId);
    if (existing) return { kind: "created", providerRef: existing.providerRef };

    const providerRef = `fp_${randomUUID()}`;
    const outcome = scenario === "fail" ? "failed" : "succeeded";
    this.payments.set(paymentId, { providerRef, amount, outcome, refunded: false });
    const event = (type: FakePayEvent["type"]): FakePayEvent => ({ eventId: `evt_${randomUUID()}`, paymentId, providerRef, type });
    const result = event(outcome === "failed" ? "payment.failed" : "payment.succeeded");

    switch (scenario) {
      case "success":
      case "fail":
        this.enqueue([result], delayMs);
        break;
      case "duplicate":
        this.enqueue([result, result], delayMs);
        break;
      case "out_of_order":
        this.enqueue([result, event("payment.processing")], delayMs);
        break;
      case "early": {
        // 응답보다 먼저 보낸다. 받는 쪽이 실패하면 다른 웹훅처럼 쌓아 다시 보낸다.
        const webhook = this.sign(result);
        if (!isSuccess(await this.send(webhook))) this.enqueue([result], 0);
        break;
      }
      case "lost":
        break;
    }
    return { kind: "created", providerRef };
  }

  lookup(paymentId: number): LookupResult {
    if (this.voided.has(paymentId)) return { status: "voided" };
    const payment = this.payments.get(paymentId);
    return payment ? { status: payment.outcome, providerRef: payment.providerRef } : { status: "unknown" };
  }

  // 아직 만들지 않은 결제 id를 무효로 해 둔다. 이미 만들었으면 무효로 하지 않고 그 결과를 돌려준다.
  void(paymentId: number): VoidResult {
    const payment = this.payments.get(paymentId);
    if (payment) return { kind: "exists", status: payment.outcome, providerRef: payment.providerRef };
    this.voided.add(paymentId);
    return { kind: "voided" };
  }

  // 결제 id가 환불의 멱등 키다. 다시 불러도 한 번만 환불된다. 돈을 받지 않은 결제는 모른다고 답한다.
  refund(paymentId: number): RefundResult {
    const payment = this.payments.get(paymentId);
    if (!payment || payment.outcome !== "succeeded") return { kind: "unknown" };
    payment.refunded = true;
    return { kind: "refunded" };
  }

  isRefunded(paymentId: number) {
    return this.payments.get(paymentId)?.refunded ?? false;
  }

  // 쌓인 웹훅을 꺼낸다. 테스트가 원하는 순서로 보낸다.
  takeQueued(): QueuedWebhook[] {
    const taken = this.queue;
    this.queue = [];
    return taken;
  }

  // 쌓인 웹훅을 차례로 보낸다. 2xx를 받지 못한 것은 다시 쌓는다. 받은 상태 코드를 돌려준다.
  async flush(): Promise<number[]> {
    const statuses: number[] = [];
    for (const webhook of this.takeQueued()) {
      const status = await this.send(webhook);
      statuses.push(status);
      if (!isSuccess(status)) this.queue.push(webhook);
    }
    return statuses;
  }

  private sign(event: FakePayEvent): SignedWebhook {
    const rawBody = JSON.stringify(event);
    return { rawBody, signature: signWebhook(this.secret, rawBody) };
  }

  private enqueue(events: FakePayEvent[], delayMs: number) {
    for (const event of events) {
      const webhook = { ...this.sign(event), delayMs };
      if (this.log) this.schedule(webhook, delayMs, 0);
      else this.queue.push(webhook);
    }
  }

  private schedule(webhook: QueuedWebhook, delayMs: number, attempt: number) {
    const timer = setTimeout(() => {
      void this.send(webhook)
        .catch(() => 0)
        .then((status) => {
          if (isSuccess(status)) return;
          const retryDelay = RETRY_DELAYS_MS[attempt];
          if (retryDelay === undefined) {
            this.log?.warn({ status, rawBody: webhook.rawBody }, "가짜 결제사: 웹훅을 다섯 번 다시 보내도 받지 않아 버림");
            return;
          }
          this.schedule(webhook, retryDelay, attempt + 1);
        });
    }, delayMs);
    // 보낼 웹훅이 남아 있어도 서버를 끌 수 있게 한다.
    timer.unref();
  }

  private async send(webhook: SignedWebhook) {
    if (!this.deliver) throw new Error("가짜 결제사가 웹훅 경로에 이어지지 않았습니다(connect)");
    return this.deliver(webhook);
  }
}

const isSuccess = (status: number) => status >= 200 && status < 300;
