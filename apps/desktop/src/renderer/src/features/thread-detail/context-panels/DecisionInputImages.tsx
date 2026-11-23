import type { DecisionsRailInputImage } from "@pwragent/shared/decisions-rail";

export function DecisionInputImages({ images }: { images?: readonly DecisionsRailInputImage[] }) {
  if (!images?.length) return null;
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
      {images.map(({ mimeType, width, height, thumbnail }, index) => {
        const label = `Image ${index + 1} · ${mimeType === "image/png" ? "PNG" : "JPEG"} · ${width} × ${height}`;
        const scale = Math.min(1, 64 / Math.max(width, height));
        return thumbnail ? (
          <img
            key={index}
            src={thumbnail}
            alt={label}
            title={label}
            width={Math.max(1, Math.round(width * scale))}
            height={Math.max(1, Math.round(height * scale))}
          />
        ) : (
          <span key={index} className="decisions-detail__muted">{label}</span>
        );
      })}
    </div>
  );
}
