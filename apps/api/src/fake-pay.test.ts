import { afterEach, describe, expect, it, vi } from "vitest";
import { type FakePayEvent, FakePaymentProvider, RETRY_DELAYS_MS, type SignedWebhook, signWebhook, verifyWebhook } from "./fake-pay.js";

const SECRET = "test-secret";

// 받은 웹훅을 모으고, statuses에 적힌 순서대로 상태 코드를 돌려준다(다 쓰면 200).
function newProvider(statuses: number[] = []) {
  const provider = new FakePaymentProvider(SECRET);
  const received: FakePayEvent[] = [];
  provider.connect(async (webhook: SignedWebhook) => {
    expect(verifyWebhook(SECRET, webhook.rawBody, webhook.signature)).toBe(true);
    received.push(JSON.parse(webhook.rawBody) as FakePayEvent);
    return statuses.shift() ?? 200;
  });
  return { provider, received };
}
const eventsOf = (provider: FakePaymentProvider) =>
  provider.takeQueued().map((w) => JSON.parse(w.rawBody) as FakePayEvent);

describe("가짜 결제사", () => {
  afterEach(() => vi.useRealTimers());

  it("시나리오마다 쌓는 웹훅이 다르다", async () => {
    const { provider } = newProvider();
    const create = (paymentId: number, scenario: Parameters<typeof provider.create>[0]["scenario"]) =>
      provider.create({ paymentId, amount: 1000, scenario, delayMs: 0 });

    await create(1, "success");
    expect(eventsOf(provider).map((e) => e.type)).toEqual(["payment.succeeded"]);
    await create(2, "fail");
    expect(eventsOf(provider).map((e) => e.type)).toEqual(["payment.failed"]);

    await create(3, "duplicate");
    const duplicated = eventsOf(provider);
    expect(duplicated).toHaveLength(2);
    expect(duplicated[0]).toEqual(duplicated[1]);

    // 결과를 먼저, 중간 상태를 나중에 보낸다
    await create(4, "out_of_order");
    expect(eventsOf(provider).map((e) => e.type)).toEqual(["payment.succeeded", "payment.processing"]);

    await create(5, "lost");
    expect(eventsOf(provider)).toEqual([]);
  });

  it("early는 create가 끝나기 전에 웹훅을 보내고, 받는 쪽이 실패하면 쌓아 둔다", async () => {
    const { provider, received } = newProvider([500]);
    const created = await provider.create({ paymentId: 1, amount: 1000, scenario: "early", delayMs: 0 });
    expect(received.map((e) => e.type)).toEqual(["payment.succeeded"]);
    expect(created).toEqual({ kind: "created", providerRef: received[0]!.providerRef });
    expect(eventsOf(provider).map((e) => e.eventId)).toEqual([received[0]!.eventId]);
  });

  it("결제 id가 멱등 키다. 같은 id로 다시 만들면 같은 결제이고 웹훅을 다시 쌓지 않는다", async () => {
    const { provider } = newProvider();
    const first = await provider.create({ paymentId: 7, amount: 1000, scenario: "success", delayMs: 0 });
    const again = await provider.create({ paymentId: 7, amount: 1000, scenario: "fail", delayMs: 0 });
    expect(again).toEqual(first);
    expect(eventsOf(provider)).toHaveLength(1);
    expect(provider.lookup(7)).toEqual({ status: "succeeded", providerRef: (first as { providerRef: string }).providerRef });
  });

  it("무효와 만들기는 먼저 온 것만 효과가 있다", async () => {
    const { provider } = newProvider();
    expect(provider.void(1)).toEqual({ kind: "voided" });
    expect(await provider.create({ paymentId: 1, amount: 1000, scenario: "success", delayMs: 0 })).toEqual({ kind: "voided" });
    expect(provider.lookup(1)).toEqual({ status: "voided" });
    expect(eventsOf(provider)).toEqual([]);

    const created = await provider.create({ paymentId: 2, amount: 1000, scenario: "fail", delayMs: 0 });
    expect(provider.void(2)).toEqual({ kind: "exists", status: "failed", providerRef: (created as { providerRef: string }).providerRef });
    expect(provider.lookup(3)).toEqual({ status: "unknown" });
  });

  it("환불은 다시 불러도 한 번이고, 돈을 받지 않은 결제나 모르는 결제는 unknown이다", async () => {
    const { provider } = newProvider();
    await provider.create({ paymentId: 1, amount: 1000, scenario: "success", delayMs: 0 });
    await provider.create({ paymentId: 2, amount: 1000, scenario: "fail", delayMs: 0 });
    expect(provider.refund(1)).toEqual({ kind: "refunded" });
    expect(provider.refund(1)).toEqual({ kind: "refunded" });
    expect(provider.isRefunded(1)).toBe(true);
    expect(provider.refund(2)).toEqual({ kind: "unknown" });
    expect(provider.refund(3)).toEqual({ kind: "unknown" });
  });

  it("장애 중에는 결제를 만들지 않고 실패한다", async () => {
    const { provider } = newProvider();
    provider.outage = true;
    await expect(provider.create({ paymentId: 1, amount: 1000, scenario: "success", delayMs: 0 })).rejects.toThrow();
    expect(provider.lookup(1)).toEqual({ status: "unknown" });
  });

  it("flush는 쌓인 웹훅을 차례로 보내고, 2xx를 받지 못한 것은 다시 쌓는다", async () => {
    const { provider, received } = newProvider([200, 500]);
    await provider.create({ paymentId: 1, amount: 1000, scenario: "success", delayMs: 0 });
    await provider.create({ paymentId: 2, amount: 1000, scenario: "success", delayMs: 0 });
    expect(await provider.flush()).toEqual([200, 500]);
    expect(received.map((e) => e.paymentId)).toEqual([1, 2]);
    expect(await provider.flush()).toEqual([200]);
    expect(await provider.flush()).toEqual([]);
  });

  it("타이머를 켜면 delayMs 뒤 보내고, 실패하면 1·2·4·8·16초 뒤 다시 보낸 다음 버린다", async () => {
    vi.useFakeTimers();
    const { provider, received } = newProvider(Array(10).fill(500));
    const warn = vi.fn();
    provider.useTimers({ warn });
    await provider.create({ paymentId: 1, amount: 1000, scenario: "success", delayMs: 1000 });
    expect(provider.takeQueued()).toEqual([]);

    await vi.advanceTimersByTimeAsync(999);
    expect(received).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(received).toHaveLength(1);
    for (const [i, delay] of RETRY_DELAYS_MS.entries()) {
      await vi.advanceTimersByTimeAsync(delay);
      expect(received).toHaveLength(i + 2);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(received).toHaveLength(1 + RETRY_DELAYS_MS.length);
  });

  it("서명은 본문 글자 하나만 바뀌어도, 길이가 달라도 맞지 않는다", () => {
    const body = JSON.stringify({ a: 1 });
    const signature = signWebhook(SECRET, body);
    expect(verifyWebhook(SECRET, body, signature)).toBe(true);
    expect(verifyWebhook(SECRET, JSON.stringify({ a: 2 }), signature)).toBe(false);
    expect(verifyWebhook("other", body, signature)).toBe(false);
    expect(verifyWebhook(SECRET, body, signature.slice(2))).toBe(false);
    expect(verifyWebhook(SECRET, body, "zz")).toBe(false);
  });
});
