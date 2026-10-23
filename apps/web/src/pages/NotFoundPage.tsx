import { Link } from "react-router";
import { usePageTitle } from "../lib/usePageTitle";

export function NotFoundPage() {
  usePageTitle("찾을 수 없음");
  return (
    <section>
      <h1>찾을 수 없는 화면입니다</h1>
      <p>
        <Link to="/">공연 목록으로</Link>
      </p>
    </section>
  );
}
