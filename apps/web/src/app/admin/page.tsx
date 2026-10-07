import type { Metadata } from 'next';
import { AdminConsole } from '@/components/admin/AdminConsole';
import { brand } from '@/lib/brand';

export const metadata: Metadata = { title: `Administration — ${brand.name}` };

export default function AdminPage() {
  return <AdminConsole />;
}
