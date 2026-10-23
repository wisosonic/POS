import { useState } from 'react';

type Props = {
  product: { name: string; imagePath?: string | null };
  size?: number;
  /** Read out by a screen reader. Leave empty when the name is already shown next to the picture. */
  alt?: string;
};

/**
 * A product's picture, or a plain tile with its first letter when there is none (or the file cannot be shown), so a list
 * keeps its shape either way. Pictures are loaded lazily: a long list does not fetch all of them at once.
 */
export function ProductImage({ product, size = 40, alt = '' }: Props) {
  const [failed, setFailed] = useState<string | null>(null);
  const src = product.imagePath && failed !== product.imagePath ? product.imagePath : null;
  if (!src) {
    return (
      <span className="thumb none" style={{ width: size, height: size }} aria-hidden="true">
        {[...product.name.trim()][0]?.toUpperCase() ?? ''}
      </span>
    );
  }
  return (
    <img className="thumb" src={src} alt={alt} width={size} height={size} loading="lazy" decoding="async" onError={() => setFailed(src)} />
  );
}
