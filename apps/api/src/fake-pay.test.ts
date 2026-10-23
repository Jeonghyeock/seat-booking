import type { PaymentScenario } from "@seat-booking/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FakePayEvent, FakePaymentProvider, RETRY_DELAYS_MS, type SignedWebhook, signWebhook, verifyWebhook } from "./fake-pay.js";

const SECRET = "test-secret";

// 받은 웹훅을 모으고, statuses에 적힌 순서대로 상태 코드를 돌려준다(다 쓰면 200). "throw"면 예외를 던진다.
function newProvider(statuses: (number | "throw")[] = []) {
  const provider = new FakePaymentProvider(SECRET);
  const received: FakePayEvent[] = [];
  provider.connect(async (webhook: SignedWebhook) => {
    expect(verifyWebhook(SECRET, webhook.rawBody, webhook.signature)).toBe(true);
    received.push(JSON.parse(webhook.rawBody) as FakePayEvent);
    const status = statuses.shift() ?? 200;
    if (status === "throw") throw new Error("받는 쪽 예외");
    return status;
  });
  return { provider, received };
}
const eventsOf = (provider: FakePaymentProvider) =>
  provider.takeQueued().map((w) => JSON.parse(w.rawBody) as FakePayEvent);
const create = (provider: FakePaymentProvider, paymentId: number, scenario: PaymentScenario = "success", delayMs = 0) =>
  provider.create({ paymentId, scenario, delayMs });

describe("가짜 결제사", () => {
  afterEach(() => vi.useRealTimers());

  it("시나리오마다 쌓는 웹훅이 다르다", async () => {
    const { provider } = newProvider();
    await create(provider, 1, "success");
    expect(eventsOf(provider).map((e) => e.type)).toEqual(["payment.succeeded"]);
    await create(provider, 2, "fail");
    expect(eventsOf(provider).map((e) => e.type)).toEqual(["payment.failed"]);

    await create(provider, 3, "duplicate");
    const duplicated = eventsOf(provider);
    expect(duplicated).toHaveLength(2);
    expect(duplicated[0]).toEqual(duplicated[1]);

    // 결과를 먼저, 중간 상태를 나중에 보낸다
    await create(provider, 4, "out_of_order");
    expect(eventsOf(provider).map((e) => e.type)).toEqual(["payment.succeeded", "payment.processing"]);

    await create(provider, 5, "lost");
    expect(eventsOf(provider)).toEqual([]);
  });

  it("early는 create가 끝나기 전에 웹훅을 보내고, 받지 못하면(실패 응답, 예외) 쌓아 둔다", async () => {
    const { provider, received } = newProvider([500, "throw"]);
    const created = await create(provider, 1, "early");
    expect(received.map((e) => e.type)).toEqual(["payment.succeeded"]);
    expect(created).toEqual({ kind: "created", providerRef: received[0]!.providerRef });
    expect(eventsOf(provider).map((e) => e.eventId)).toEqual([received[0]!.eventId]);

    await create(provider, 2, "early");
    expect(eventsOf(provider).map((e) => e.paymentId)).toEqual([2]);
  });

  it("결제 id가 멱등 키다. 같은 id로 다시 만들면 같은 결제이고 웹훅을 다시 쌓지 않는다", async () => {
    const { provider } = newProvider();
    const first = await create(provider, 7, "success");
    const again = await create(provider, 7, "fail");
    expect(again).toEqual(first);
    expect(eventsOf(provider)).toHaveLength(1);
    expect(await provider.lookup(7)).toEqual({ status: "succeeded", providerRef: (first as { providerRef: string }).providerRef });
  });

  it("무효와 만들기는 먼저 온 것만 효과가 있다", async () => {
    const { provider } = newProvider();
    expect(await provider.void(1)).toEqual({ kind: "voided" });
    expect(await create(provider, 1)).toEqual({ kind: "voided" });
    expect(await provider.lookup(1)).toEqual({ status: "voided" });
    expect(eventsOf(provider)).toEqual([]);

    const created = await create(provider, 2, "fail");
    expect(await provider.void(2)).toEqual({
      kind: "exists",
      status: "failed",
      providerRef: (created as { providerRef: string }).providerRef,
    });
    expect(await provider.lookup(3)).toEqual({ status: "unknown" });
  });

  it("환불은 다시 불러도 한 번이고, 돈을 받지 않은 결제나 모르는 결제는 unknown이다", async () => {
    const { provider } = newProvider();
    await create(provider, 1, "success");
    await create(provider, 2, "fail");
    expect(await provider.refund(1)).toEqual({ kind: "refunded" });
    expect(await provider.refund(1)).toEqual({ kind: "refunded" });
    expect(provider.isRefunded(1)).toBe(true);
    expect(await provider.refund(2)).toEqual({ kind: "unknown" });
    expect(await provider.refund(3)).toEqual({ kind: "unknown" });
  });

  it("down이면 아무것도 하지 않고 모든 호출이 실패한다", async () => {
    const { provider } = newProvider();
    provider.outage = "down";
    await expect(create(provider, 1)).rejects.toThrow();
    await expect(provider.lookup(1)).rejects.toThrow();
    await expect(provider.void(1)).rejects.toThrow();
    await expect(provider.refund(1)).rejects.toThrow();
    provider.outage = null;
    expect(await provider.lookup(1)).toEqual({ status: "unknown" });
    expect(eventsOf(provider)).toEqual([]);
  });

  it("after_create는 결제를 만들고 응답만 잃는다. 같은 id로 다시 부르면 같은 결제다", async () => {
    const { provider } = newProvider();
    provider.outage = "after_create";
    await expect(create(provider, 1)).rejects.toThrow();
    const recorded = await provider.lookup(1);
    expect(recorded.status).toBe("succeeded");
    expect(eventsOf(provider)).toHaveLength(1);

    provider.outage = null;
    expect(await create(provider, 1)).toEqual({ kind: "created", providerRef: (recorded as { providerRef: string }).providerRef });
    expect(eventsOf(provider)).toEqual([]);
  });

  it("hang은 결제를 만들고 응답하지 않는다", async () => {
    const { provider } = newProvider();
    provider.outage = "hang";
    const pending = create(provider, 1);
    const settled = await Promise.race([pending.then(() => "settled"), new Promise((r) => setTimeout(() => r("waiting"), 50))]);
    expect(settled).toBe("waiting");
    expect((await provider.lookup(1)).status).toBe("succeeded");
  });

  it("flush는 쌓인 웹훅을 차례로 보내고, 받지 못한 것(실패 응답, 예외)은 다시 쌓는다", async () => {
    const { provider, received } = newProvider([200, 500, "throw"]);
    await create(provider, 1);
    await create(provider, 2);
    await create(provider, 3);
    expect(await provider.flush()).toEqual([200, 500, 0]);
    expect(received.map((e) => e.paymentId)).toEqual([1, 2, 3]);
    expect(await provider.flush()).toEqual([200, 200]);
    expect(await provider.flush()).toEqual([]);
  });

  it("타이머를 켜면 delayMs 뒤 보내고, 실패하면 1·2·4·8·16초 뒤 다시 보낸 다음 버린다", async () => {
    expect(RETRY_DELAYS_MS).toEqual([1000, 2000, 4000, 8000, 16000]);
    vi.useFakeTimers();
    const { provider, received } = newProvider(Array(10).fill(500));
    const warn = vi.fn();
    provider.useTimers({ warn });
    await create(provider, 1, "success", 1000);
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

  it("타이머 모드의 early가 실패하면 1초 뒤부터 다시 보낸다(모두 여섯 번)", async () => {
    vi.useFakeTimers();
    const { provider, received } = newProvider(Array(10).fill(500));
    provider.useTimers({ warn: vi.fn() });
    await create(provider, 1, "early");
    expect(received).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(received).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(received).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(received).toHaveLength(1 + RETRY_DELAYS_MS.length);
  });

  it("이어지지 않은 채 타이머로 보내면 그 이유를 로그에 남긴다", async () => {
    vi.useFakeTimers();
    const provider = new FakePaymentProvider(SECRET);
    const warn = vi.fn();
    provider.useTimers({ warn });
    await create(provider, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(warn.mock.calls[0]![0]).toMatchObject({ err: expect.objectContaining({ message: expect.stringContaining("connect") }) });
  });

  it("서명은 본문 글자 하나만 바뀌어도, 길이가 달라도, 뒤에 글자가 붙어도 맞지 않는다", () => {
    const body = JSON.stringify({ a: 1 });
    const signature = signWebhook(SECRET, body);
    expect(verifyWebhook(SECRET, body, signature)).toBe(true);
    expect(verifyWebhook(SECRET, JSON.stringify({ a: 2 }), signature)).toBe(false);
    expect(verifyWebhook("other", body, signature)).toBe(false);
    for (const bad of [signature.slice(2), `${signature}0`, `${signature}zz`, `${signature} junk`, "zz", ""]) {
      expect(verifyWebhook(SECRET, body, bad), bad).toBe(false);
    }
  });
});
