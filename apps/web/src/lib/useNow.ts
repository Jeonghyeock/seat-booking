import { useEffect, useState } from "react";
import { serverNow } from "./clock";

// 서버 시각(밀리초)을 intervalMs마다 새로 준다. 타이머와 카운트다운이 쓴다.
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const timer = setInterval(() => setNow(serverNow()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
