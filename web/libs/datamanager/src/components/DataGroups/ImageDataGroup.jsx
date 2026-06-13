import { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { getRoot } from "mobx-state-tree";
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

// top-RIGHT so it doesn't collide with the grid's coverage badge (⛶ NN%, top-left).
const badgeStyle = (bg) => ({
  position: "absolute",
  top: 3,
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
// {w, h, b:[[x,y,bw,bh,label], ...]} (x/y/bw/bh in %, w/h = natural image px). The SVG viewBox is
// the natural size with preserveAspectRatio="xMidYMid meet", which matches the img's
// object-fit:contain — so the rects line up with the photo regardless of cell aspect ratio.
const PredBoxOverlay = ({ pb }) => {
  if (!pb || !pb.w || !pb.h || !Array.isArray(pb.b) || !pb.b.length) return null;
  const sw = Math.max(2, Math.round(pb.w * 0.004));
  const fs = Math.max(10, Math.round(pb.h * 0.035));
  return (
    <svg
      viewBox={`0 0 ${pb.w} ${pb.h}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 4 }}
    >
      {pb.b.map((box, i) => {
        const x = (Number(box[0]) / 100) * pb.w;
        const y = (Number(box[1]) / 100) * pb.h;
        const w = (Number(box[2]) / 100) * pb.w;
        const h = (Number(box[3]) / 100) * pb.h;
        const label = box[4] ?? "";
        const color = BOX_COLORS[i % BOX_COLORS.length];
        return (
          <g key={i}>
            <rect x={x} y={y} width={w} height={h} fill="none" stroke={color} strokeWidth={sw} />
            {label ? (
              <text
                x={x + sw}
                y={Math.max(y - sw, fs)}
                fill={color}
                fontSize={fs}
                fontWeight="700"
                style={{ paintOrder: "stroke", stroke: "rgba(0,0,0,0.65)", strokeWidth: sw }}
              >
                {label}
              </text>
            ) : null}
          </g>
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

  // cars-mods (2026-06): on SAM3 verification projects, overlay the prediction bbox + show a
  // status badge (green = real annotation submitted, amber = only an un-submitted draft).
  const root = original ? getRoot(original) : null;
  const pid = Number(root?.SDK?.projectId);
  const carsProj = CARS_COMPACT_PROJECTS.includes(pid);
  const pb = carsProj ? original?.data?.pred_boxes : null;
  const hasAnnotation = (original?.total_annotations ?? 0) > 0;
  const draftOnly = carsProj && !hasAnnotation && original?.draft_exists === true;

  return (
    <div className={cn("grid-image-wrapper").toClassName()} style={{ position: "relative" }}>
      <img src={src} width="100%" style={imgStyle} alt="" loading="lazy" />
      {pb ? <PredBoxOverlay pb={pb} /> : null}
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
