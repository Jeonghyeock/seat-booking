import { type AuthUser, Credentials, normalizePassword } from "@seat-booking/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ApiError, NetworkError } from "../api/client";
import { login, signup } from "../api/endpoints";
import { queryKeys, useMe } from "../api/queries";
import { safeNext } from "../lib/navigation";
import styles from "./AuthPage.module.css";

type Mode = "login" | "signup";

// 가입·로그인 폼의 오류는 폼에 보인다(DESIGN 6.5 로그인·가입, 10장 73). 전역 인증 규칙을 타지 않는다.
export function authErrorMessage(mode: Mode, error: unknown): string {
  if (error instanceof NetworkError) return "서버에 닿지 않습니다. 잠시 뒤 다시 시도해 주세요.";
  if (!(error instanceof ApiError)) return "알 수 없는 오류가 났습니다.";
  if (error.status === 401) return "이메일 또는 비밀번호가 맞지 않습니다.";
  if (error.status === 409) return "이미 가입한 이메일입니다. 로그인해 주세요.";
  // 429의 문구에는 몇 초 뒤인지가 들어 있다.
  if (error.status === 429) return error.serverMessage ?? "요청이 너무 많습니다. 잠시 뒤 다시 시도해 주세요.";
  if (error.status === 503) return "잠시 뒤 다시 시도해 주세요.";
  if (error.status === 400) return mode === "signup" ? "비밀번호는 8~128자여야 합니다." : "입력을 확인해 주세요.";
  return "알 수 없는 오류가 났습니다.";
}

export function AuthPage({ mode }: { mode: Mode }) {
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<{ field: "email" | "password" | "form"; message: string } | null>(null);
  const ids = { email: useId(), password: useId(), problem: useId() };

  // 이미 로그인했으면 돌아갈 곳으로 간다.
  useEffect(() => {
    if (me) void navigate(next, { replace: true });
  }, [me, navigate, next]);

  const submit = useMutation({
    mutationFn: (credentials: Credentials) => (mode === "login" ? login(credentials) : signup(credentials)),
    onSuccess: (user: AuthUser) => {
      // 앞 사용자의 캐시를 지우고 내 정보를 넣은 뒤 돌아간다(DESIGN 6.5 서버 상태와 화면 상태).
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== queryKeys.me[0] });
      queryClient.setQueryData(queryKeys.me, user);
      void navigate(next, { replace: true });
    },
    onError: (error) => setProblem({ field: "form", message: authErrorMessage(mode, error) }),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = Credentials.safeParse({ email, password });
    if (!parsed.success || parsed.data.email === "") {
      setProblem({ field: "email", message: "이메일 형식을 확인해 주세요." });
      return;
    }
    // 가입은 API와 같은 규칙(NFKC 뒤 8~128자)으로 먼저 본다. 로그인은 서버가 판단한다(옛 규칙의 비밀번호일 수 있다).
    if (mode === "signup" && normalizePassword(password) === null) {
      setProblem({ field: "password", message: "비밀번호는 8~128자여야 합니다." });
      return;
    }
    setProblem(null);
    submit.mutate(parsed.data);
  }

  const title = mode === "login" ? "로그인" : "가입";
  const other = mode === "login" ? { to: "/signup", label: "처음이면 가입하기" } : { to: "/login", label: "이미 가입했으면 로그인" };

  return (
    <section className={styles.card} aria-labelledby={`${ids.problem}-title`}>
      <h1 id={`${ids.problem}-title`}>{title}</h1>
      <form onSubmit={onSubmit} noValidate className={styles.form}>
        <label htmlFor={ids.email}>이메일</label>
        <input
          id={ids.email}
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={problem?.field === "email"}
          aria-describedby={problem ? ids.problem : undefined}
          required
        />
        <label htmlFor={ids.password}>비밀번호</label>
        <input
          id={ids.password}
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={problem?.field === "password"}
          aria-describedby={problem ? ids.problem : undefined}
          required
        />
        {mode === "signup" && <p className={styles.hint}>비밀번호는 8~128자입니다.</p>}
        <p id={ids.problem} role="alert" className={styles.problem}>
          {problem?.message}
        </p>
        <button type="submit" className={styles.submit} disabled={submit.isPending}>
          {submit.isPending ? `${title} 중…` : title}
        </button>
      </form>
      <p className={styles.other}>
        <Link to={`${other.to}?next=${encodeURIComponent(next)}`}>{other.label}</Link>
      </p>
    </section>
  );
}
