"use client";

import { useId, useState } from "react";

export type QuotePoint = { at: string; bid: number; ask: number };
type Point = { x: number; y: number };

export function smoothPath(points: Point[]) {
  return points.map((point, i) => {
    const previous = points[i - 1];
    if (!previous) return `M ${point.x} ${point.y}`;
    const middle = (previous.x + point.x) / 2;
    return `C ${middle} ${previous.y}, ${middle} ${point.y}, ${point.x} ${point.y}`;
  }).join(" ");
}

export function MarketChart({ quotes, signals = [] }: { quotes: QuotePoint[]; signals?: { id: string; at: string; label: string }[] }) {
  const gradient = useId();
  const [inspect, setInspect] = useState<string>();
  if (!quotes.length) return null;

  const mids = quotes.map(quote => (quote.ask + quote.bid) / 2);
  const minimum = Math.min(95, Math.max(0, Math.floor((Math.min(...mids) - 2) / 5) * 5));
  const maximum = Math.min(100, Math.max(minimum + 5, Math.ceil((Math.max(...mids) + 2) / 5) * 5));
  const first = Date.parse(quotes[0].at);
  const span = Math.max(1, Date.parse(quotes[quotes.length - 1].at) - first);
  const points = quotes.map((quote, index) => ({
    x: quotes.length === 1 ? 400 : 55 + (Date.parse(quote.at) - first) * 714 / span,
    y: 152 - (mids[index] - minimum) * 130 / (maximum - minimum),
  }));
  const found = quotes.findIndex(quote => quote.at === inspect);
  const selected = found < 0 ? quotes.length - 1 : found;
  const marker = points[selected];
  const quote = quotes[selected];
  const path = smoothPath(points);
  const timestamp = new Date(quote.at).toLocaleString();
  return <div className="quote-chart">
    <svg className="chart" viewBox="0 0 800 175" preserveAspectRatio="none" role="img" aria-label="YES midpoint over observation time">
      <defs>
        <linearGradient id={gradient} x2="0" y2="1">
          <stop stopColor="#54dcb3" stopOpacity=".32" />
          <stop offset="1" stopColor="#54dcb3" stopOpacity=".02" />
        </linearGradient>
      </defs>
      {[0, 1, 2, 3].map(index => {
        const y = 22 + index * 130 / 3;
        const price = maximum - index * (maximum - minimum) / 3;
        return <g key={index}><path d={`M 55 ${y} H 769`} stroke="#506270" strokeOpacity=".35" strokeDasharray="4 5" />
          <text x="2" y={y + 4} fill="#a8bacb" fontSize="12">{Number(price.toFixed(1))}¢</text></g>;
      })}
      {points.length > 1 && <>
        <path d={`${path} L ${points[points.length - 1].x} 152 L ${points[0].x} 152 Z`} fill={`url(#${gradient})`} />
        <path d={path} fill="none" stroke="#79ebbc" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
      </>}
      {signals.map(signal => {
        const index = quotes.findIndex(quote => quote.at === signal.at);
        if (index < 0) return null;
        const { x, y } = points[index];
        return <a key={signal.id} href={"#decision-" + signal.id} aria-label={signal.label}>
          <title>{signal.label}</title><circle cx={x} cy={Math.max(14, y - 9)} r="4" fill="#d4b6ff" stroke="#1c2738" />
        </a>;
      })}
      <path d={`M ${marker.x} 22 V 152`} stroke="#79ebbc" strokeOpacity=".42" strokeDasharray="3 4" />
      <circle cx={marker.x} cy={marker.y} r="4" fill="#79ebbc" stroke="#14283a" strokeWidth="1.5" />
    </svg>
    <div className="chart-inspect">
      <output>{timestamp} · {mids[selected].toFixed(1)}¢ midpoint · {quote.bid}¢ bid / {quote.ask}¢ ask</output>
      {quotes.length > 1 && <label>Inspect observed quote
        <input type="range" min={0} max={quotes.length - 1} value={selected} aria-valuetext={`${timestamp}, ${mids[selected].toFixed(1)} cents`}
          onChange={event => setInspect(quotes[Number(event.target.value)].at)} />
      </label>}
      {found >= 0 && <button type="button" className="quiet" onClick={() => setInspect(undefined)}>Latest</button>}
    </div>
  </div>;
}
