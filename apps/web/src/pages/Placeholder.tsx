import { Link } from "react-router";

// 뼈대 PR의 자리 표시. 다음 PR들이 화면으로 바꾼다.
export function Placeholder({ title }: { title: string }) {
  return (
    <section>
      <h1>{title}</h1>
      <p>준비 중입니다.</p>
    </section>
  );
}

export function NotFoundPage() {
  return (
    <section>
      <h1>찾을 수 없는 화면입니다</h1>
      <p>
        <Link to="/">공연 목록으로</Link>
      </p>
    </section>
  );
}
