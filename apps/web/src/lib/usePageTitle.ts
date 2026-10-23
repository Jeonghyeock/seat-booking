import { useEffect } from "react";

// 브라우저 탭과 화면 읽기 프로그램이 읽는 화면 이름. 화면마다 다르게 둔다.
export function usePageTitle(title: string | undefined) {
  useEffect(() => {
    document.title = title ? `${title} · 좌석 예매` : "좌석 예매";
  }, [title]);
}
