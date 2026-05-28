import { useEffect, useRef, useState } from "react";
import { cn } from "../../utils/bem";
import { getCachedBlob } from "./carsImageCache";

export const IMAGE_SIZE_COEFFICIENT = 8;

// cars-mods v45: persistent-cache-aware image src.
// On mount: check IndexedDB for this URL. If cached → blob objectURL (instant, survives sessions).
// If not cached → network URL immediately (no delay), opportunistic store on load.
// ObjectURL revoked on unmount/url-change to avoid memory leaks (grid is virtualized).
function useCachedImageSrc(networkUrl) {
  const [src, setSrc] = useState(networkUrl);
  const objUrlRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setSrc(networkUrl);
    if (objUrlRef.current) {
      URL.revokeObjectURL(objUrlRef.current);
      objUrlRef.current = null;
    }
    if (!networkUrl || typeof networkUrl !== "string") return undefined;

    getCachedBlob(networkUrl).then((blob) => {
      // Review fix #1: re-check cancelled AFTER createObjectURL. Fast-scroll in the
      // virtualized grid can unmount before this async resolves — the cleanup already
      // nulled objUrlRef, so a URL created here would never be revoked (leak per scroll).
      if (cancelled || !blob) return;
      const obj = URL.createObjectURL(blob);
      if (cancelled) {
        URL.revokeObjectURL(obj);
        return;
      }
      objUrlRef.current = obj;
      setSrc(obj);
    });

    return () => {
      cancelled = true;
      if (objUrlRef.current) {
        URL.revokeObjectURL(objUrlRef.current);
        objUrlRef.current = null;
      }
    };
  }, [networkUrl]);

  return src;
}

export const ImageDataGroup = (column) => {
  const { value } = column;
  // cars-mods: унифицированный flow для ВСЕХ column counts. width:100% height:100%
  // плюс object-fit:contain гарантируют что любое фото (wide/portrait) помещается
  // целиком внутри cell, с letterbox на свободных сторонах.
  const imgStyle = { width: "100%", height: "100%", objectFit: "contain", display: "block" };
  const src = useCachedImageSrc(value);

  // Review fix #4: removed opportunistic onLoad re-fetch (caused double network transfer
  // per uncached image — wasteful across 174k tasks if /data/local-files lacks cache headers).
  // Caching is explicit via the "📥 Прогреть кеш" button (warmCache in GridView). A future
  // v46 could add a debounced canvas.toBlob (same-origin, no double-fetch) for auto-cache-on-view.
  return (
    <div className={cn("grid-image-wrapper").toClassName()}>
      <img src={src} width="100%" style={imgStyle} alt="" loading="lazy" />
    </div>
  );
};

ImageDataGroup.height = 150;
