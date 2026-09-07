import { useEffect, useRef, useState } from "react";
export type ReadPage<T> = { items: T[]; nextCursor: string | null };
/** One page at a time. A refresh never reuses a cursor from the old live dataset. */
export function usePage<T>(read: (cursor: string | undefined, signal: AbortSignal) => Promise<ReadPage<T>>, refresh: number, generation: () => number) {
  const [position, setPosition] = useState<{ refresh: number; history: (string | undefined)[] }>({ refresh, history: [undefined] });
  const history = position.refresh === refresh ? position.history : [undefined];
  const cursor = history[history.length - 1];
  const [result, setResult] = useState<ReadPage<T>>({ items: [], nextCursor: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  useEffect(() => {
    const serial = ++sequence.current;
    const connection = generation();
    const controller = new AbortController();
    setLoading(true); setError("");
    void read(cursor, controller.signal).then(page => {
      if (!controller.signal.aborted && sequence.current === serial && generation() === connection) setResult(page);
    }).catch(() => { if (!controller.signal.aborted && sequence.current === serial && generation() === connection) setError("無法讀取互評資料，請重新整理。"); })
      .finally(() => { if (!controller.signal.aborted && sequence.current === serial && generation() === connection) setLoading(false); });
    return () => { controller.abort(); sequence.current++; };
  }, [read, cursor, refresh, generation]);
  return { ...result, loading, error, page: history.length, next: () => { if (!loading && result.nextCursor) { sequence.current++; setPosition({ refresh, history: [...history, result.nextCursor] }); } }, previous: () => { sequence.current++; setPosition({ refresh, history: history.slice(0, -1) }); } };
}
