import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { PaymentScenario } from "@seat-booking/shared";

// 가짜 결제사(DESIGN 6.2 "가짜 결제사"). 같은 서버 안의 모듈이지만 바깥 결제사처럼 다룬다. 모든 호출은 비동기이고 실패할 수 있다.
// 상태는 메모리에만 둔다. 서버를 다시 띄우면 결제사의 기록과 보내지 못한 웹훅이 사라지고, 우리 쪽은 대사 작업이 맞춘다.
//
// 결제 요청 본문의 scenario(DESIGN 10장 20):
// success·fail: 결과 웹훅 한 번. duplicate: 같은 이벤트를 두 번. out_of_order: 결과를 먼저, 그보다 앞서 생긴 중간 상태를 나중에.
// early: 결제 요청의 응답보다 먼저 웹훅을 보낸다. lost: 웹훅을 보내지 않는다.

export type FakePayEvent = {
  eventId: string;
  paymentId: number;
  providerRef: string;
  type: "payment.processing" | "payment.succeeded" | "payment.failed";
};
// 보낼 웹훅. 서명한 그 문자열을 그대로 보내야 받는 쪽의 서명 확인이 맞는다.
export type SignedWebhook = { rawBody: string; signature: string };
// 웹훅을 앱의 웹훅 경로로 보내고 HTTP 상태 코드를 돌려준다.
export type Deliver = (webhook: SignedWebhook) => Promise<number>;

export type CreateResult = { kind: "created"; providerRef: string } | { kind: "voided" };
export type LookupResult =
  | { status: "succeeded" | "failed"; providerRef: string }
  | { status: "voided" }
  | { status: "unknown" };
export type VoidResult = { kind: "voided" } | { kind: "exists"; status: "succeeded" | "failed"; providerRef: string };
export type RefundResult = { kind: "refunded" } | { kind: "unknown" };

// 장애 흉내.
// down: 아무것도 하지 않고 실패한다(모든 호출).
// after_create: 결제를 만들고 웹훅도 쌓은 뒤 응답만 실패한다(응답 유실). 같은 id로 다시 부르면 같은 결제다.
// hang: 결제를 만들고 웹훅도 쌓은 뒤 응답하지 않는다(시간 초과).
export type Outage = "down" | "after_create" | "hang" | null;

export const SIGNATURE_HEADER = "x-fake-signature";
// 2xx를 받지 못하면 1·2·4·8·16초 뒤 다시 보낸다(다섯 번).
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000] as const;
// out_of_order의 중간 상태는 결과보다 조금 늦게 보내 받는 쪽에 순서가 뒤바뀌어 닿게 한다.
const OUT_OF_ORDER_GAP_MS = 50;

export function signWebhook(secret: string, rawBody: string) {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifyWebhook(secret: string, rawBody: string, signature: string) {
  // Buffer.from(…, "hex")는 16진수가 아닌 글자에서 멈추고 홀수 끝 글자를 버리므로, 모양을 먼저 본다.
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(signWebhook(secret, rawBody), "hex"));
}

type ProviderPayment = { providerRef: string; outcome: "succeeded" | "failed"; refunded: boolean };
type Logger = { warn: (obj: object, msg: string) => void };

export class FakePaymentProvider {
  outage: Outage = null;
  private readonly payments = new Map<number, ProviderPayment>();
  private readonly voided = new Set<number>();
  private queue: SignedWebhook[] = [];
  private deliver: Deliver | undefined;
  private log: Logger | undefined;
  // 웹훅을 보낸 수, 다시 보내려고 잡은 수, 다섯 번 다시 보내도 받지 않아 버린 수(부하 측정의 지표, DESIGN 6.6).
  readonly deliveries = { sent: 0, retried: 0, givenUp: 0 };

  constructor(private readonly secret: string) {}

  // 결제사가 아는 결제와 그 결과. 부하 측정이 끝난 뒤 DB와 맞춰 본다(DESIGN 6.6 합격 확인 (e)).
  listPayments() {
    return [...this.payments].map(([paymentId, { outcome, refunded }]) => ({ paymentId, outcome, refunded }));
  }

  connect(deliver: Deliver) {
    this.deliver = deliver;
  }

  // 개발 서버에서만 켠다. 웹훅을 delayMs 뒤 보내고, 실패하면 다시 보낸다.
  // 테스트는 켜지 않고 쌓인 웹훅을 takeQueued·flush로 원하는 순서에 보낸다.
  useTimers(log: Logger) {
    this.log = log;
  }

  verify(rawBody: string, signature: string) {
    return verifyWebhook(this.secret, rawBody, signature);
  }

  // 결제 id가 멱등 키다. 같은 id로 다시 부르면 같은 결제를 돌려주고 웹훅을 다시 쌓지 않는다.
  // 무효로 한 id면 만들지 않는다(VOIDED). 결제사 안에서는 무효와 만들기 중 먼저 온 것만 효과가 있다.
  async create(input: { paymentId: number; scenario: PaymentScenario; delayMs: number }): Promise<CreateResult> {
    const { paymentId, scenario, delayMs } = input;
    if (this.outage === "down") throw new Error("가짜 결제사 장애");
    const result = this.voided.has(paymentId) ? ({ kind: "voided" } as const) : await this.record(paymentId, scenario, delayMs);
    if (this.outage === "after_create") throw new Error("가짜 결제사 응답 유실");
    if (this.outage === "hang") return new Promise<never>(() => {});
    return result;
  }

  async lookup(paymentId: number): Promise<LookupResult> {
    this.failIfDown();
    if (this.voided.has(paymentId)) return { status: "voided" };
    const payment = this.payments.get(paymentId);
    return payment ? { status: payment.outcome, providerRef: payment.providerRef } : { status: "unknown" };
  }

  // 아직 만들지 않은 결제 id를 무효로 해 둔다. 이미 만들었으면 무효로 하지 않고 그 결과를 돌려준다.
  async void(paymentId: number): Promise<VoidResult> {
    this.failIfDown();
    const payment = this.payments.get(paymentId);
    if (payment) return { kind: "exists", status: payment.outcome, providerRef: payment.providerRef };
    this.voided.add(paymentId);
    return { kind: "voided" };
  }

  // 결제 id가 환불의 멱등 키다. 다시 불러도 한 번만 환불된다. 돈을 받지 않은 결제는 모른다고 답한다.
  async refund(paymentId: number): Promise<RefundResult> {
    this.failIfDown();
    const payment = this.payments.get(paymentId);
    if (!payment || payment.outcome !== "succeeded") return { kind: "unknown" };
    payment.refunded = true;
    return { kind: "refunded" };
  }

  isRefunded(paymentId: number) {
    return this.payments.get(paymentId)?.refunded ?? false;
  }

  // 쌓인 웹훅을 꺼낸다. 테스트가 원하는 순서로 보낸다.
  takeQueued(): SignedWebhook[] {
    const taken = this.queue;
    this.queue = [];
    return taken;
  }

  // 쌓인 웹훅을 차례로 보낸다. 2xx를 받지 못한 것은 다시 쌓는다. 받은 상태 코드를 돌려준다(보내지 못하면 0).
  async flush(): Promise<number[]> {
    const statuses: number[] = [];
    for (const webhook of this.takeQueued()) {
      const status = await this.send(webhook);
      statuses.push(status);
      if (!isSuccess(status)) this.queue.push(webhook);
    }
    return statuses;
  }

  private failIfDown() {
    if (this.outage === "down") throw new Error("가짜 결제사 장애");
  }

  private async record(paymentId: number, scenario: PaymentScenario, delayMs: number): Promise<CreateResult> {
    const existing = this.payments.get(paymentId);
    if (existing) return { kind: "created", providerRef: existing.providerRef };

    // 기록은 첫 await 전에 끝낸다. early가 웹훅을 보내는 동안 같은 id의 호출도 이 결제를 본다.
    const providerRef = `fp_${randomUUID()}`;
    const outcome = scenario === "fail" ? "failed" : "succeeded";
    this.payments.set(paymentId, { providerRef, outcome, refunded: false });
    const event = (type: FakePayEvent["type"]) => this.sign({ eventId: `evt_${randomUUID()}`, paymentId, providerRef, type });
    const result = event(outcome === "failed" ? "payment.failed" : "payment.succeeded");

    switch (scenario) {
      case "success":
      case "fail":
        this.enqueue(result, delayMs);
        break;
      case "duplicate":
        this.enqueue(result, delayMs);
        this.enqueue(result, delayMs);
        break;
      case "out_of_order":
        this.enqueue(result, delayMs);
        this.enqueue(event("payment.processing"), delayMs + OUT_OF_ORDER_GAP_MS);
        break;
      case "early":
        // 응답보다 먼저 보낸다. 받지 못하면 다른 웹훅처럼 다시 보낸다(타이머면 첫 재시도부터).
        if (!isSuccess(await this.send(result))) this.retry(result, 0);
        break;
      case "lost":
        break;
    }
    return { kind: "created", providerRef };
  }

  private sign(event: FakePayEvent): SignedWebhook {
    const rawBody = JSON.stringify(event);
    return { rawBody, signature: signWebhook(this.secret, rawBody) };
  }

  private enqueue(webhook: SignedWebhook, delayMs: number) {
    if (this.log) this.schedule(webhook, delayMs, 0);
    else this.queue.push(webhook);
  }

  // attempt번째 다시 보내기. 타이머가 없으면 쌓아 둔다.
  private retry(webhook: SignedWebhook, attempt: number) {
    if (!this.log) {
      this.queue.push(webhook);
      return;
    }
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay === undefined) {
      this.deliveries.givenUp++;
      this.log.warn({ rawBody: webhook.rawBody }, "가짜 결제사: 웹훅을 다섯 번 다시 보내도 받지 않아 버림");
      return;
    }
    this.deliveries.retried++;
    this.schedule(webhook, delay, attempt + 1);
  }

  private schedule(webhook: SignedWebhook, delayMs: number, nextAttempt: number) {
    const timer = setTimeout(() => {
      void this.send(webhook).then((status) => {
        if (!isSuccess(status)) this.retry(webhook, nextAttempt);
      });
    }, delayMs);
    // 보낼 웹훅이 남아 있어도 서버를 끌 수 있게 한다.
    timer.unref();
  }

  // 보내지 못하면(이어지지 않음, 받는 쪽 예외) 0이다. 타이머 모드에서는 그 이유를 로그에 남긴다.
  private async send(webhook: SignedWebhook): Promise<number> {
    this.deliveries.sent++;
    try {
      if (!this.deliver) throw new Error("가짜 결제사가 웹훅 경로에 이어지지 않았습니다(connect)");
      return await this.deliver(webhook);
    } catch (err) {
      this.log?.warn({ err }, "가짜 결제사: 웹훅을 보내지 못함");
      return 0;
    }
  }
}

const isSuccess = (status: number) => status >= 200 && status < 300;
