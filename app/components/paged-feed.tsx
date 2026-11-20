"use client";

import { useEffect, useState, type ReactNode } from "react";

export function PagedFeed<T extends { id: string }>({ entries, prefix, render }: {
  entries: T[]; prefix: string; render: (entry: T) => ReactNode;
}) {
  const size = 8;
  const [anchor, setAnchor] = useState<string>();
  const [jump, setJump] = useState("");
  const index = jump ? entries.findIndex(item => item.id === jump) : -1;
  const start = index >= 0 ? Math.floor(index / size) * size : Math.max(0, entries.findIndex(item => item.id === anchor));
  const visible = entries.slice(start, start + size);
  const jumpAnchor = index >= 0 ? visible[0]?.id : undefined;
  useEffect(() => {
    const onHash = () => {
      const hash = window.location.hash.slice(1);
      if (hash.startsWith(prefix)) setJump(hash.slice(prefix.length));
    };
    const timer = window.setTimeout(onHash, 0);
    window.addEventListener("hashchange", onHash);
    return () => { window.clearTimeout(timer); window.removeEventListener("hashchange", onHash); };
  }, [prefix]);
  useEffect(() => {
    if (!jumpAnchor || !jump) return;
    const timer = window.setTimeout(() => {
      document.getElementById(prefix + jump)?.scrollIntoView({ block: "start" });
      setAnchor(jumpAnchor);
      setJump("");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [jump, jumpAnchor, prefix]);
  return <>
    {visible.map(render)}
    {entries.length > size && <div className="backtest-pages">
      <button type="button" className="quiet" disabled={start === 0} onClick={() => setAnchor(start <= size ? undefined : entries[start - size].id)}>Newer</button>
      <small>{start + 1}–{start + visible.length} of {entries.length}</small>
      <button type="button" className="quiet" disabled={start + size >= entries.length} onClick={() => setAnchor(entries[start + size]?.id)}>Older</button>
    </div>}
  </>;
}
