import {
  AdminShows,
  AdminVenues,
  type CreatePerformance,
  PerformanceSales,
  PerformanceSummary,
  RefundFailedPayments,
  RefundRetried,
} from "@seat-booking/shared";
import { apiRequest } from "./client";

// 관리자 경로(DESIGN 6.3 관리자 기능). 권한은 서버가 지킨다(로그인하지 않았으면 401, 손님이면 403 FORBIDDEN).
export const adminKeys = {
  venues: ["admin", "venues"] as const,
  shows: ["admin", "shows"] as const,
  sales: (performanceId: number) => ["admin", "sales", performanceId] as const,
  refunds: ["admin", "refunds"] as const,
};

export const getAdminVenues = async () => (await apiRequest("/admin/venues", { schema: AdminVenues })).data;
export const getAdminShows = async () => (await apiRequest("/admin/shows", { schema: AdminShows })).data;
export const getSales = async (performanceId: number) =>
  (await apiRequest(`/admin/performances/${performanceId}/sales`, { schema: PerformanceSales })).data;
export const getRefundFailed = async () =>
  (await apiRequest("/admin/payments?status=refund_failed", { schema: RefundFailedPayments })).data;
export const retryRefund = async (paymentId: number) =>
  (await apiRequest(`/admin/payments/${paymentId}/retry-refund`, { method: "POST", schema: RefundRetried })).data;
// 회차 등록. 같은 공연장·같은 시각이 이미 있으면 409, 등록할 수 없는 이유는 422 problems다(화면이 오류 본문으로 가른다).
export const createPerformance = async (body: CreatePerformance) =>
  (await apiRequest("/admin/performances", { method: "POST", body, schema: PerformanceSummary })).data;
