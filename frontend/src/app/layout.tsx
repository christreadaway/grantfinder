import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GrantFinder AI",
  description: "Intelligent grant discovery and matching platform for Catholic parishes and schools",
  keywords: ["grants", "Catholic", "parish", "school", "funding", "AI"],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased min-h-screen">
        {children}
      </body>
    </html>
  );
}
