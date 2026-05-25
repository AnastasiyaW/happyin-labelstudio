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
  // cars-mods: для плотных гридов (cols > IMAGE_SIZE_COEFFICIENT=8) original LS формула давала
  // imageHeight=150 + width:auto → wide-aspect фото overflow'или cell width, картинка как полоска.
  // Новый поток: width 100% от cell, height auto с aspect preserve, maxHeight чтобы не растягивать в портрет.
  const isDense = columnCount > IMAGE_SIZE_COEFFICIENT;
  const imageHeight = isDense
    ? ImageDataGroup.height
    : ImageDataGroup.height * Math.max(1, IMAGE_SIZE_COEFFICIENT - columnCount);
  // Dense mode: img filling whole cell-body, scales by smallest dim, остаток letterbox.
  // (cell-body height = dynamicRowHeight - header, set by GridView ~ cellWidth для квадратного area).
  const imgStyle = isDense
    ? { width: "100%", height: "100%", objectFit: "contain", display: "block" }
    : { height: imageHeight };
  const imgWidth = isDense ? "100%" : "auto";

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
