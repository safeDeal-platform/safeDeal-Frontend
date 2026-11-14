// 시범 PR 전용 파일(FIR-03). 머지하지 않고 닫는다.
import { useEffect, useState } from 'react';

type Product = { id: number; title: string; descriptionHtml: string };

export function ProductDescription({ productId }: { productId: number }) {
  const [product, setProduct] = useState<Product | null>(null);

  useEffect(() => {
    fetch(`/api/products/${productId}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('accessToken') ?? ''}` },
    })
      .then((res) => res.json())
      .then((body: { accessToken?: string; product: Product }) => {
        if (body.accessToken) localStorage.setItem('accessToken', body.accessToken);
        setProduct(body.product);
      });
  }, [productId]);

  if (!product) return null;
  return (
    <section>
      <h2>{product.title}</h2>
      <div dangerouslySetInnerHTML={{ __html: product.descriptionHtml }} />
    </section>
  );
}
