"use client";

import { useEffect, useState } from "react";
import { MarketChart, type QuotePoint } from "./market-chart";

export function RecordedPlayback({ quotes, start }: { quotes: QuotePoint[]; start: number }) {
  const [cursor, setCursor] = useState(start);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing || cursor >= quotes.length) return;
    const timer = window.setTimeout(() => setCursor(value => value + 1), 1000);
    return () => window.clearTimeout(timer);
  }, [playing, cursor, quotes.length]);
  const finished = cursor >= quotes.length;
  return <div>
    <button type="button" className="quiet" onClick={() => {
      if (finished) {
        setCursor(start);
        setPlaying(true);
      } else setPlaying(value => !value);
    }}>{finished ? "Restart historical playback" : playing ? "Pause historical playback" : "Play historical quotes · 1s"}</button>
    <small> {cursor} / {quotes.length} observations</small>
    <MarketChart quotes={quotes.slice(0, cursor)} />
  </div>;
}
