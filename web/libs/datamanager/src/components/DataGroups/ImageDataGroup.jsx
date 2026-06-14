import { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { getRoot, isAlive } from "mobx-state-tree";
import { cn } from "../../utils/bem";
import { getCachedBlob } from "./carsImageCache";

export const IMAGE_SIZE_COEFFICIENT = 8;

// cars-mods: SAM3 verification projects (jewelry objects + stones).
const CARS_COMPACT_PROJECTS = [8, 9, 10];
const BOX_COLORS = ["#22d3ee", "#f59e0b", "#a78bfa", "#34d399", "#f472b6"];

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

// bottom-RIGHT: the confidence badge (🎯 NN%) now owns the top-right corner, coverage
// (⛶ NN%) the top-left, so the annotation status badge sits at the bottom-right.
const badgeStyle = (bg) => ({
  position: "absolute",
  bottom: 3,
  right: 3,
  padding: "1px 5px",
  fontSize: 10,
  lineHeight: "14px",
  fontWeight: 600,
  color: "#fff",
  background: bg,
  borderRadius: 3,
  pointerEvents: "none",
  whiteSpace: "nowrap",
  zIndex: 5,
});

// cars-mods (2026-06): draw the SAM3 prediction bbox(es) over the card photo. data.pred_boxes =
// {w, h, b:[[x,y,bw,bh,label], ...]} where x/y/bw/bh are PERCENT of the image (0..100).
//
// Alignment: the overlay SVG fills the same box as the <img> (which is object-fit:contain over the
// wrapper). We size the viewBox to the DISPLAYED image's REAL natural dimensions (natW/natH from
// the img's onLoad) — NOT pb.w/pb.h. pb.w/pb.h are the prediction's original_width/height, which
// can differ from the shown image's aspect (SAM3 often pads/resizes), and that mismatch was
// drawing the box in the wrong place. With viewBox = natural dims + preserveAspectRatio="xMidYMid
// meet", the SVG letterboxes its content exactly like object-fit:contain letterboxes the image, so
// the rects (percent → natural-px) land on the photo. non-scaling-stroke keeps the outline crisp.
const PredBoxOverlay = ({ pb, natW, natH }) => {
  if (!pb || !Array.isArray(pb.b) || !pb.b.length || !natW || !natH) return null;
  return (
    <svg
      viewBox={`0 0 ${natW} ${natH}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 4 }}
    >
      {pb.b.map((box, i) => {
        const x = (Number(box[0]) / 100) * natW;
        const y = (Number(box[1]) / 100) * natH;
        const w = (Number(box[2]) / 100) * natW;
        const h = (Number(box[3]) / 100) * natH;
        const color = BOX_COLORS[i % BOX_COLORS.length];
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={w}
            height={h}
            fill="none"
            stroke={color}
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </svg>
  );
};

export const ImageDataGroup = observer((column) => {
  const { value, original } = column;
  // cars-mods: унифицированный flow для ВСЕХ column counts. width:100% height:100%
  // плюс object-fit:contain гарантируют что любое фото (wide/portrait) помещается
  // целиком внутри cell, с letterbox на свободных сторонах.
  const imgStyle = { width: "100%", height: "100%", objectFit: "contain", display: "block" };
  const src = useCachedImageSrc(value);
  // Natural dims of the DISPLAYED image (from onLoad) — the overlay viewBox uses these so the
  // box aligns with object-fit:contain. Reset when the image changes so a stale aspect from the
  // previous task can't briefly mis-place the box.
  const [nat, setNat] = useState(null);
  const imgRef = useRef(null);
  useEffect(() => {
    setNat(null);
    // Fallback for browser-cached images that are already `complete` before onLoad attaches.
    const im = imgRef.current;
    if (im?.complete && im.naturalWidth) setNat({ w: im.naturalWidth, h: im.naturalHeight });
  }, [src]);

  // cars-mods (2026-06): on SAM3 verification projects, overlay the prediction bbox + show a
  // status badge (green = real annotation submitted, amber = only an un-submitted draft).
  // Dead-node guard: the virtualized grid + lazy pagination detach `original` (the TaskModel)
  // on every list fetch. A detached MST node is a non-null proxy that THROWS on any property
  // read — `original?.x` does NOT help (optional chaining only guards null/undefined). This
  // observer re-fires on detachment, so without isAlive() the read throws → the cell flickers
  // forever + floods the console. When dead we still render the image (src is from the `value`
  // prop, not the node) and just skip the overlay/badges until the live node re-mounts.
  const alive = original && isAlive(original);
  const root = alive ? getRoot(original) : null;
  const pid = Number(root?.SDK?.projectId);
  const carsProj = CARS_COMPACT_PROJECTS.includes(pid);
  const pb = alive && carsProj ? original?.data?.pred_boxes : null;
  const hasAnnotation = alive ? (original?.total_annotations ?? 0) > 0 : false;
  const draftOnly = alive && carsProj && !hasAnnotation && original?.draft_exists === true;

  return (
    <div className={cn("grid-image-wrapper").toClassName()} style={{ position: "relative" }}>
      <img
        ref={imgRef}
        src={src}
        width="100%"
        style={imgStyle}
        alt=""
        loading="lazy"
        onLoad={(e) => {
          const t = e.currentTarget;
          if (t.naturalWidth && t.naturalHeight) setNat({ w: t.naturalWidth, h: t.naturalHeight });
        }}
      />
      {pb && nat ? <PredBoxOverlay pb={pb} natW={nat.w} natH={nat.h} /> : null}
      {carsProj && hasAnnotation && (
        <span style={badgeStyle("rgba(22,163,74,0.92)")} title="Аннотация сохранена">
          ✓ аннотация
        </span>
      )}
      {draftOnly && (
        <span style={badgeStyle("rgba(217,119,6,0.94)")} title="Только черновик — не сохранено как аннотация (нажми вердикт)">
          ✎ черновик
        </span>
      )}
    </div>
  );
});

ImageDataGroup.height = 150;
