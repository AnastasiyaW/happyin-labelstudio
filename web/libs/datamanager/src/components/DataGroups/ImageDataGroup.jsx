import { getRoot } from "mobx-state-tree";
import { AnnotationPreview } from "../Common/AnnotationPreview/AnnotationPreview";
import { cn } from "../../utils/bem";

export const IMAGE_SIZE_COEFFICIENT = 8;

export const ImageDataGroup = (column) => {
  const {
    value,
    original,
    field: { alias },
    columnCount,
  } = column;
  const root = getRoot(original);
  // cars-mods: унифицированный flow для ВСЕХ column counts. width:100% height:100%
  // плюс object-fit:contain гарантируют что любое фото (wide/portrait) помещается
  // целиком внутри cell, с letterbox на свободных сторонах. GridView устанавливает
  // dynamicRowHeight = headerHeight + cellWidth × 0.75 (landscape 4:3 aspect).
  const imgStyle = { width: "100%", height: "100%", objectFit: "contain", display: "block" };
  const imgWidth = "100%";

  // cars-mods: всегда отдаём simple <img> с object-fit:contain. AnnotationPreview branch
  // (когда total_annotations > 0) рендерил canvas с object-fit:cover игнорируя наши стили,
  // из-за чего rejected cells (у которых cancelled annotation = annotation > 0) показывали
  // crop вместо letterbox. Нам не нужны annotation overlays в grid (для verification mode
  // достаточно red outline + ✕ ВЫКИНУТЬ badge через CSS на cell).
  return (
    <div className={cn("grid-image-wrapper").toClassName()}>
      <img src={value} width={imgWidth} style={imgStyle} alt="" loading="lazy" />
    </div>
  );
};

ImageDataGroup.height = 150;
