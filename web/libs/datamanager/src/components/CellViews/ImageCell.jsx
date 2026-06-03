import { getRoot } from "mobx-state-tree";
import { AnnotationPreview } from "../Common/AnnotationPreview/AnnotationPreview";

const imgDefaultProps = { crossOrigin: "anonymous" };

// cars-mods: SAM3 verification projects (jewelry objects + stones) where annotators
// scan a big image and judge by eye. In these projects we overlay a "processed" badge.
const CARS_COMPACT_PROJECTS = [8, 9, 10];

export const ImageCell = (column) => {
  const {
    original,
    value,
    column: { alias },
  } = column;
  const root = getRoot(original);

  const renderImagePreview = original.total_annotations === 0 || !root.showPreviews;
  const imgSrc = Array.isArray(value) ? value[0] : value;

  if (!imgSrc) return null;

  const imgStyle = {
    maxHeight: "100%",
    maxWidth: "100px",
    objectFit: "contain",
    borderRadius: 3,
  };

  const imgEl = renderImagePreview ? (
    <img {...imgDefaultProps} key={imgSrc} src={imgSrc} alt="Data" loading="lazy" style={imgStyle} />
  ) : (
    <AnnotationPreview
      task={original}
      annotation={original.annotations[0]}
      config={getRoot(original).SDK}
      name={alias}
      variant="120x120"
      fallbackImage={value}
      style={imgStyle}
    />
  );

  // cars-mods (2026-06): "обработано" badge. Any annotator action leaves a durable
  // per-task trace — a submitted annotation, a rejection (cancelled), or an unsaved
  // draft. Gated to SAM3 verification projects so car projects (6/7) are untouched.
  const pid = Number(root?.SDK?.projectId);
  if (!CARS_COMPACT_PROJECTS.includes(pid)) return imgEl;

  const processed =
    (original.total_annotations ?? 0) > 0 ||
    (original.cancelled_annotations ?? 0) > 0 ||
    original.draft_exists === true;

  return (
    <div
      className="cars-img-cell"
      style={{ position: "relative", display: "inline-flex", maxWidth: "100%", maxHeight: "100%" }}
    >
      {imgEl}
      {processed && (
        <span
          className="cars-processed-badge"
          title="Обработано разметчиком"
          style={{
            position: "absolute",
            top: 3,
            left: 3,
            padding: "1px 5px",
            fontSize: 10,
            lineHeight: "14px",
            fontWeight: 600,
            color: "#fff",
            background: "rgba(22,163,74,0.92)",
            borderRadius: 3,
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          ✓ обработано
        </span>
      )}
    </div>
  );
};
