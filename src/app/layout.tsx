import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'BOOT ERP · 부트캠프 사업관리',
  description: '과제·비교과·예산·지출 업무 관리',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
