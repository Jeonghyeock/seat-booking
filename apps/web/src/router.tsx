import { createBrowserRouter, useParams } from "react-router";
import { Layout } from "./components/Layout";
import { RequireLogin } from "./components/RequireLogin";
import { AuthPage } from "./pages/AuthPage";
import { MyOrdersPage } from "./pages/MyOrdersPage";
import { OrderPage } from "./pages/OrderPage";
import { PerformancesPage } from "./pages/PerformancesPage";
import { NotFoundPage, Placeholder } from "./pages/Placeholder";
import { SeatMapPage } from "./pages/SeatMapPage";

// 경로의 id. 10진수 양의 정수가 아니면 없는 화면이다.
function useIdParam() {
  const { id } = useParams();
  return id !== undefined && /^[1-9]\d{0,15}$/.test(id) ? Number(id) : null;
}

function SeatMapRoute() {
  const id = useIdParam();
  // 회차가 바뀌면 고른 좌석·알림을 새로 시작한다.
  return id === null ? <NotFoundPage /> : <SeatMapPage key={id} performanceId={id} />;
}

function OrderRoute() {
  const id = useIdParam();
  return id === null ? (
    <NotFoundPage />
  ) : (
    <RequireLogin>
      <OrderPage key={id} orderId={id} />
    </RequireLogin>
  );
}

// 경로(DESIGN 6.5 경로). 주문 화면은 URL의 id만으로 다시 그린다(새로고침·뒤로 가기에 안전하다).
export const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <PerformancesPage /> },
      { path: "performances/:id", element: <SeatMapRoute /> },
      { path: "orders/:id", element: <OrderRoute /> },
      {
        path: "my/orders",
        element: (
          <RequireLogin>
            <MyOrdersPage />
          </RequireLogin>
        ),
      },
      { path: "login", element: <AuthPage key="login" mode="login" /> },
      { path: "signup", element: <AuthPage key="signup" mode="signup" /> },
      { path: "admin", element: <Placeholder title="관리자" /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);
