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
  // One gallery over every image the message shows, in the order it shows
  // them, as a sent message's images page in the transcript.
  const images: AppServerThreadImagePart[] = props.imageParts
    ?? props.input.flatMap((item) => item.type === "image"
      ? [{ type: "image" as const, url: item.url, alt: item.name ?? "Attached image" }]
      : []);
  const [expandedIndex, setExpandedIndex] = useState<number>();
  const expandedImage = expandedIndex === undefined ? undefined : images[expandedIndex];
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
          const imageIndex = props.input
            .slice(0, index)
            .filter((candidate) => candidate.type === "image").length;
          return <TranscriptImageTile
            key={index}
            imagePart={images[imageIndex]!}
            imageNumber={index + 1}
            onOpenImage={() => setExpandedIndex(imageIndex)}
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
          onOpenImage={() => setExpandedIndex(index)}
          desktopApi={props.desktopApi}
        />
      ))}
      {expandedImage && expandedIndex !== undefined ? (
        <ImageLightbox
          src={expandedImage.url}
          alt={expandedImage.alt ?? "Attached image"}
          position={expandedIndex + 1}
          total={images.length}
          onClose={() => setExpandedIndex(undefined)}
          onPrevious={expandedIndex > 0
            ? () => setExpandedIndex(expandedIndex - 1)
            : undefined}
          onNext={expandedIndex < images.length - 1
            ? () => setExpandedIndex(expandedIndex + 1)
            : undefined}
        />
      ) : null}
    </div>
  );
}
