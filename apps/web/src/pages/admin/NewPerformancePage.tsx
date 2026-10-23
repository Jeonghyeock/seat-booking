import { PerformanceExists, PerformanceInvalid } from "@seat-booking/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { Link, useNavigate } from "react-router";
import { adminKeys, createPerformance, getAdminShows, getAdminVenues } from "../../api/admin";
import { ApiError, NetworkError } from "../../api/client";
import { queryKeys } from "../../api/queries";
import { LoadError, Loading } from "../../components/States";
import { buildCreatePerformance, type FormErrors, type FormField, type PerformanceForm, problemsToErrors } from "../../lib/performanceForm";
import { defaultSalesClose } from "../../lib/time";
import styles from "./Admin.module.css";

const EMPTY: PerformanceForm = {
  showMode: "existing",
  showId: "",
  title: "",
  venueId: "",
  prices: {},
  startsAt: "",
  salesOpenAt: "",
  salesCloseAt: "",
};

// 회차 등록(DESIGN 6.5 관리자). 공연장을 고르면 등급별 가격 칸이 생기고, 판매 종료는 고치기 전까지 공연 3시간 전을 따라간다.
export function NewPerformancePage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const ids = { show: useId(), venue: useId(), startsAt: useId(), salesOpenAt: useId(), salesCloseAt: useId() };
  const venues = useQuery({ queryKey: adminKeys.venues, queryFn: getAdminVenues });
  const shows = useQuery({ queryKey: adminKeys.shows, queryFn: getAdminShows });
  const [form, setForm] = useState<PerformanceForm>(EMPTY);
  const [closeEdited, setCloseEdited] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [existingShowId, setExistingShowId] = useState<number | null>(null);
  const [conflict, setConflict] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: createPerformance,
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.performances });
      void queryClient.invalidateQueries({ queryKey: adminKeys.shows });
      void navigate(`/admin/performances/${created.id}/sales`);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 422) {
        const parsed = PerformanceInvalid.safeParse(error.body);
        if (parsed.success) {
          const mapped = problemsToErrors(parsed.data.problems);
          setErrors(mapped.errors);
          setExistingShowId(mapped.existingShowId);
          return;
        }
      }
      if (error instanceof ApiError && error.status === 409) {
        const parsed = PerformanceExists.safeParse(error.body);
        if (parsed.success) {
          setConflict(parsed.data.performanceId);
          return;
        }
      }
      setFailure(error instanceof NetworkError ? "서버에 닿지 않습니다." : "등록하지 못했습니다.");
    },
  });

  if (venues.isPending || shows.isPending) return <Loading />;
  if (venues.isError) return <LoadError error={venues.error} onRetry={() => void venues.refetch()} />;
  if (shows.isError) return <LoadError error={shows.error} onRetry={() => void shows.refetch()} />;

  const venue = venues.data.venues.find((v) => String(v.venueId) === form.venueId);
  const grades = venue?.grades.map((g) => g.grade) ?? [];
  const set = (patch: Partial<PerformanceForm>) => setForm((f) => ({ ...f, ...patch }));
  const errorFor = (field: FormField) =>
    errors[field] ? (
      <p id={`${field}-error`} className={styles.fieldError}>
        {errors[field]}
      </p>
    ) : null;
  const describedBy = (field: FormField) => (errors[field] ? `${field}-error` : undefined);

  function onStartsAt(value: string) {
    // 판매 종료는 관리자가 그 칸을 고치기 전까지 공연 3시간 전을 따라간다.
    set(closeEdited ? { startsAt: value } : { startsAt: value, salesCloseAt: defaultSalesClose(value) ?? "" });
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setConflict(null);
    setFailure(null);
    setExistingShowId(null);
    const result = buildCreatePerformance(form, grades);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    create.mutate(result.body);
  }

  return (
    <section className={styles.page}>
      <p>
        <Link to="/admin">관리자</Link>
      </p>
      <h1>회차 등록</h1>
      <form onSubmit={onSubmit} noValidate className={styles.form}>
        <fieldset>
          <legend>작품</legend>
          <label>
            <input type="radio" checked={form.showMode === "existing"} onChange={() => set({ showMode: "existing" })} /> 있는 작품
          </label>
          <label>
            <input type="radio" checked={form.showMode === "new"} onChange={() => set({ showMode: "new" })} /> 새 작품
          </label>
          {form.showMode === "existing" ? (
            <>
              <label htmlFor={ids.show}>작품 고르기</label>
              <select
                id={ids.show}
                value={form.showId}
                onChange={(e) => set({ showId: e.target.value })}
                aria-invalid={Boolean(errors.show)}
                aria-describedby={describedBy("show")}
              >
                <option value="">고르세요</option>
                {shows.data.shows.map((s) => (
                  <option key={s.showId} value={s.showId}>
                    {s.title} (#{s.showId})
                  </option>
                ))}
              </select>
            </>
          ) : (
            <>
              <label htmlFor={ids.show}>새 작품 제목</label>
              <input
                id={ids.show}
                value={form.title}
                maxLength={200}
                onChange={(e) => set({ title: e.target.value })}
                aria-invalid={Boolean(errors.show)}
                aria-describedby={describedBy("show")}
              />
            </>
          )}
          {errorFor("show")}
          {existingShowId !== null && (
            <button
              type="button"
              onClick={() => {
                set({ showMode: "existing", showId: String(existingShowId) });
                setExistingShowId(null);
                setErrors((e) => ({ ...e, show: undefined }));
              }}
            >
              있는 작품으로 바꾸기
            </button>
          )}
        </fieldset>

        <fieldset>
          <legend>공연장과 가격</legend>
          <label htmlFor={ids.venue}>공연장</label>
          <select
            id={ids.venue}
            value={form.venueId}
            onChange={(e) => set({ venueId: e.target.value, prices: {} })}
            aria-invalid={Boolean(errors.venueId)}
            aria-describedby={describedBy("venueId")}
          >
            <option value="">고르세요</option>
            {venues.data.venues.map((v) => (
              <option key={v.venueId} value={v.venueId}>
                {v.name} ({v.totalSeats}석, #{v.venueId})
              </option>
            ))}
          </select>
          {errorFor("venueId")}
          {venue &&
            venue.grades.map((g) => (
              <label key={g.grade} className={styles.price}>
                {g.grade}({g.seats}석) 가격(원)
                <input
                  inputMode="numeric"
                  value={form.prices[g.grade] ?? ""}
                  onChange={(e) => set({ prices: { ...form.prices, [g.grade]: e.target.value } })}
                  aria-invalid={Boolean(errors.prices)}
                  aria-describedby={describedBy("prices")}
                />
              </label>
            ))}
          {errorFor("prices")}
        </fieldset>

        <fieldset>
          <legend>시각(한국 시간)</legend>
          <label htmlFor={ids.startsAt}>공연 시작</label>
          <input
            id={ids.startsAt}
            type="datetime-local"
            value={form.startsAt}
            onChange={(e) => onStartsAt(e.target.value)}
            aria-invalid={Boolean(errors.startsAt)}
            aria-describedby={describedBy("startsAt")}
          />
          {errorFor("startsAt")}
          <label htmlFor={ids.salesOpenAt}>판매 시작</label>
          <input
            id={ids.salesOpenAt}
            type="datetime-local"
            value={form.salesOpenAt}
            onChange={(e) => set({ salesOpenAt: e.target.value })}
            aria-invalid={Boolean(errors.salesOpenAt)}
            aria-describedby={describedBy("salesOpenAt")}
          />
          {errorFor("salesOpenAt")}
          <label htmlFor={ids.salesCloseAt}>판매 종료(기본: 공연 3시간 전)</label>
          <input
            id={ids.salesCloseAt}
            type="datetime-local"
            value={form.salesCloseAt}
            onChange={(e) => {
              setCloseEdited(true);
              set({ salesCloseAt: e.target.value });
            }}
            aria-invalid={Boolean(errors.salesCloseAt)}
            aria-describedby={describedBy("salesCloseAt")}
          />
          {errorFor("salesCloseAt")}
        </fieldset>

        <div role="alert">
          {conflict !== null && (
            <p className={styles.fieldError}>
              같은 공연장·같은 시각의 회차가 이미 있습니다. <Link to={`/admin/performances/${conflict}/sales`}>그 회차 보기</Link>
            </p>
          )}
          {failure && <p className={styles.fieldError}>{failure}</p>}
        </div>
        <button type="submit" className={styles.primary} disabled={create.isPending}>
          {create.isPending ? "등록하는 중…" : "등록"}
        </button>
      </form>
    </section>
  );
}
