import { useState } from "react";
import type {
  AppServerThreadImagePart,
  AppServerThreadMessageOrigin,
  AppServerTurnInputItem,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { useThreadLinks } from "../../lib/thread-links";
import { ThreadChip } from "./ThreadChip";
import { ThreadMarkdown } from "./ThreadMarkdown";
import { TranscriptImageTile } from "./TranscriptMessage";
import { ImageLightbox } from "./ImageLightbox";

/** Rich input inspection uses the same Markdown, image and navigation primitives as history. */
export function TurnInputContent(props: {
  input: AppServerTurnInputItem[];
  imageParts?: AppServerThreadImagePart[];
  origin?: AppServerThreadMessageOrigin;
  desktopApi?: DesktopApi;
}) {
  const [expandedImage, setExpandedImage] = useState<AppServerThreadImagePart>();
  const links = useThreadLinks();
  const source = props.origin?.sourceThread;
  const link = source
    ? links?.resolve(source) ?? { ...source, title: source.title ?? "Source thread" }
    : undefined;
  return (
    <div className="turn-input-content">
      {link && links ? (
        <ThreadChip link={link} onOpen={links.show} fallbackLabel={source?.title} />
      ) : null}
      {props.input.map((item, index) => {
        if (item.type === "text") {
          return <ThreadMarkdown key={index} text={item.text} desktopApi={props.desktopApi} />;
        }
        if (props.imageParts && (item.type === "image" || item.type === "localImage")) {
          return null;
        }
        if (item.type === "image") {
          return <TranscriptImageTile
            key={index}
            imagePart={{ type: "image", url: item.url, alt: item.name ?? "Attached image" }}
            imageNumber={index + 1}
            onOpenImage={setExpandedImage}
            desktopApi={props.desktopApi}
          />;
        }
        return <div key={index}>{item.name ?? (item.type === "file" ? "Attached file" : item.path)}</div>;
      })}
      {props.imageParts?.map((image, index) => (
        <TranscriptImageTile
          key={`image:${index}`}
          imagePart={image}
          imageNumber={index + 1}
          onOpenImage={setExpandedImage}
          desktopApi={props.desktopApi}
        />
      ))}
      {expandedImage ? (
        <ImageLightbox
          src={expandedImage.url}
          alt={expandedImage.alt ?? "Attached image"}
          onClose={() => setExpandedImage(undefined)}
        />
      ) : null}
    </div>
  );
}
