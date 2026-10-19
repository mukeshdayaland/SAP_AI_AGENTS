import { brand } from '@/lib/brand';

/** Brand backdrop behind the conversation column. WTCO: a clean wash with the faded company symbol (globals.css). Other brands have none. */
export function Backdrop() {
  if (brand.id !== 'wtco') return null;
  return (
    <div className="brand-backdrop" aria-hidden>
      {brand.logo && <img src={brand.logo} alt="" className="brand-watermark" />}
    </div>
  );
}
