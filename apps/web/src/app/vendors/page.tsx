import type { Metadata } from 'next';
import { VendorMap } from '@/components/vendors/VendorMap';

export const metadata: Metadata = { title: 'Vendor map — Prowess AI' };

export default function VendorMapPage() {
  return <VendorMap />;
}
