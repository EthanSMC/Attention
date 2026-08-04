import type { PublicContent } from "../lib/attention";
import { PublicContentCard } from "./content-card";

export function MasonryFeed({ contents }: { contents: PublicContent[] }) {
  return (
    <div className="masonry-feed" role="list">
      {contents.map((content) => (
        <div className="masonry-feed__item" key={content.id} role="listitem">
          <PublicContentCard content={content} />
        </div>
      ))}
    </div>
  );
}
