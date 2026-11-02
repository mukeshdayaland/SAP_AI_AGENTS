import type { Metadata } from 'next';
import { HelpCenter } from '@/components/help/HelpCenter';
import { brand } from '@/lib/brand';

export const metadata: Metadata = { title: `Help — ${brand.name}` };

export default function HelpPage() {
  return <HelpCenter />;
}
