import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "AgentDesk", description: "Prediction market agents, paper portfolios and testnet research." };
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
