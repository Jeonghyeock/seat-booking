import { createBrowserRouter } from "react-router";
import { Layout } from "./components/Layout";
import { NotFoundPage, Placeholder } from "./pages/Placeholder";

// 경로(DESIGN 6.5 경로). 주문 화면은 URL의 id만으로 다시 그린다(새로고침·뒤로 가기에 안전하다).
export const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Placeholder title="공연" /> },
      { path: "performances/:id", element: <Placeholder title="좌석 고르기" /> },
      { path: "orders/:id", element: <Placeholder title="주문" /> },
      { path: "my/orders", element: <Placeholder title="내 예매" /> },
      { path: "login", element: <Placeholder title="로그인" /> },
      { path: "signup", element: <Placeholder title="가입" /> },
      { path: "admin", element: <Placeholder title="관리자" /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);
