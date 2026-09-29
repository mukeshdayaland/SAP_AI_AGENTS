import type { Metadata } from 'next';
import { AdminConsole } from '@/components/admin/AdminConsole';

export const metadata: Metadata = { title: 'Administration — Prowess AI' };

export default function AdminPage() {
  return <AdminConsole />;
}
