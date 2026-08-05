import type { PublicContent } from "../lib/attention";
import { PublicContentCard } from "./content-card";
import { MasonryGrid } from "./masonry-grid";

export function MasonryFeed({ contents }: { contents: PublicContent[] }) {
  return (
    <MasonryGrid>
      {contents.map((content) => (
        <div className="masonry-feed__item" key={content.id} role="listitem">
          <PublicContentCard content={content} />
        </div>
      ))}
    </MasonryGrid>
  );
}
