import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '부트 ERP · 개발 기반',
  description: '과제와 비교과 업무를 위한 ERP 개발 환경',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
