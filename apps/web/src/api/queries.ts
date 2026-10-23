import { AuthUser } from "@seat-booking/shared";
import { MutationCache, QueryCache, QueryClient, queryOptions, useQuery } from "@tanstack/react-query";
import { authActionFor } from "./authErrors";
import { ApiError, apiRequest } from "./client";

// 서버 상태는 TanStack Query 캐시에만 둔다(DESIGN 6.5 서버 상태와 화면 상태, 10장 68).
// 선점·주문·결제의 상태는 서버만 정한다. 낙관적 갱신은 하지 않고, 바꾼 뒤에는 관련 키를 무효로 해 다시 읽는다.
export const queryKeys = {
  me: ["me"] as const,
  performances: ["performances"] as const,
  seatMap: (performanceId: number) => ["seatMap", performanceId] as const,
  myPerformance: (performanceId: number) => ["myPerformance", performanceId] as const,
  order: (orderId: number) => ["order", orderId] as const,
  orders: ["orders"] as const,
  admin: ["admin"] as const,
};

// 사용자마다 다른 데이터. 로그인·로그아웃·세션 만료·사용자 바뀜 때 지운다(다른 사용자의 주문이 남아 보이지 않게).
const USER_SCOPED = new Set(["myPerformance", "order", "orders", "admin"]);

export function clearUserQueries(queryClient: QueryClient) {
  queryClient.removeQueries({ predicate: (query) => USER_SCOPED.has(String(query.queryKey[0])) });
}

function onAuthError(queryClient: QueryClient, error: unknown) {
  switch (authActionFor(error)) {
    case "sessionExpired":
      // 먼저 me를 null로 해 로그인이 필요한 조회를 끈 뒤(enabled) 사용자 캐시를 지운다.
      queryClient.setQueryData(queryKeys.me, null);
      clearUserQueries(queryClient);
      break;
    case "forbidden":
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
      break;
    case "bug":
      console.error("화면 버그: CSRF 확인에 걸렸습니다(헤더 또는 APP_ORIGIN)", error);
      break;
    case "signedOut":
    case "none":
      break;
  }
}

export function createQueryClient() {
  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError: (error) => onAuthError(queryClient, error) }),
    mutationCache: new MutationCache({ onError: (error) => onAuthError(queryClient, error) }),
    defaultOptions: {
      // 4xx는 다시 해도 같다. 5xx와 네트워크 오류만 한 번 더 한다.
      queries: { retry: (failureCount, error) => failureCount < 1 && !(error instanceof ApiError && error.status < 500) },
      // 변이는 라이브러리가 다시 하지 않는다(선점은 멱등이 아니다). 멱등 키가 있는 요청은 변이 함수가 직접 다시 보낸다.
      mutations: { retry: false },
    },
  });
  return queryClient;
}

// 내 정보. 로그인 전이면 null이다(401은 오류가 아니다). 창으로 돌아오면 다시 읽는다(다른 탭에서 로그아웃했을 수 있다).
export const meQuery = queryOptions({
  queryKey: queryKeys.me,
  queryFn: async (): Promise<AuthUser | null> => {
    try {
      return (await apiRequest("/auth/me", { schema: AuthUser })).data;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    }
  },
  staleTime: 30_000,
  refetchOnWindowFocus: "always",
});

export function useMe() {
  return useQuery(meQuery);
}
