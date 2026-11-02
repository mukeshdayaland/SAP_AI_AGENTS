import type { Metadata } from 'next';
import { VendorMap } from '@/components/vendors/VendorMap';
import { brand } from '@/lib/brand';

export const metadata: Metadata = { title: `Vendor map — ${brand.name}` };

export default function VendorMapPage() {
  return <VendorMap />;
}
