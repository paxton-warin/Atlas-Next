import { useEffect, useState } from "react";
import { ArrowUpRight, Heart, Search } from "lucide-react";
import { readLocal, writeLocal, type Game } from "./model";
export default function Catalog({
  items,
  kind,
  launch,
}: {
  items: Game[];
  kind: "game" | "app";
  launch: (item: Game) => void;
}) {
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState("All categories"),
    [sort, setSort] = useState("Featured"),
    [onlyFavorites, setOnlyFavorites] = useState(false),
    [limit, setLimit] = useState(48);
  const [favorites, setFavorites] = useState<string[]>(() =>
    readLocal("atlas.favorites", []),
  );
  const title = kind === "app" ? "Apps" : "Games",
    noun = title.toLowerCase();
  const library = items.filter((item) => (item.kind || "game") === kind);
  const categories = [...new Set(library.map((item) => item.category))].sort();
  const filtered = library
    .filter(
      (item) =>
        (!onlyFavorites || favorites.includes(item.id)) &&
        (category === "All categories" || item.category === category) &&
        `${item.name} ${item.category} ${item.description}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) => (sort === "A–Z" ? a.name.localeCompare(b.name) : 0));
  useEffect(() => setLimit(48), [query, category, sort, onlyFavorites]);
  return (
    <div
      className={`page ${kind === "game" ? "games" : "apps"}-page library-page`}
    >
      <div className="page-heading">
        <div>
          <h1>{title}</h1>
          <p>
            {library.length} {noun}. Search the library or choose a category.
          </p>
        </div>
      </div>
      <div className="catalog-toolbar">
        <div className="segmented">
          <button
            className={!onlyFavorites ? "selected" : ""}
            onClick={() => setOnlyFavorites(false)}
          >
            All {noun}
          </button>
          <button
            className={onlyFavorites ? "selected" : ""}
            onClick={() => setOnlyFavorites(true)}
          >
            <Heart size={14} /> Favorites
          </button>
        </div>
        <label className="catalog-search">
          <Search size={16} />
          <input
            aria-label={`Search ${noun}`}
            placeholder={`Search ${noun}`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select
          aria-label={`Filter ${noun} by category`}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option>All categories</option>
          {categories.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <select
          aria-label={`Sort ${noun}`}
          value={sort}
          onChange={(e) => setSort(e.target.value)}
        >
          <option>Featured</option>
          <option>A–Z</option>
        </select>
      </div>
      <div className="game-grid">
        {filtered.slice(0, limit).map((item) => (
          <article className="game-card" key={item.id}>
            <button
              aria-label={`${kind === "app" ? "Open" : "Play"} ${item.name}`}
              className={`game-art ${item.artwork} catalog-cover`}
              onClick={() => launch(item)}
            >
              <span className="catalog-monogram" aria-hidden="true">
                {item.id === "2048"
                  ? "2048"
                  : item.id === "snake"
                    ? "▰"
                    : item.id === "tic"
                      ? "× ○"
                      : (
                          { hextris: "⬡", alchemy: "✦", chess: "♞" } as Record<
                            string,
                            string
                          >
                        )[item.id] || item.name.slice(0, 2)}
              </span>
              {item.thumbnail && (
                <img
                  src={item.thumbnail}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  onError={(e) => {
                    e.currentTarget.hidden = true;
                  }}
                />
              )}
              <span className="play-overlay">
                {kind === "app" ? "Open" : "Play"} <ArrowUpRight size={18} />
              </span>
            </button>
            <button
              className={`favorite ${favorites.includes(item.id) ? "saved" : ""}`}
              aria-label={`Favorite ${item.name}`}
              aria-pressed={favorites.includes(item.id)}
              onClick={() => {
                const next = favorites.includes(item.id)
                  ? favorites.filter((id) => id !== item.id)
                  : [...favorites, item.id];
                setFavorites(next);
                writeLocal("atlas.favorites", next);
              }}
            >
              <Heart size={16} />
            </button>
            <div className="game-info">
              <span className="eyebrow">{item.category}</span>
              <h3>{item.name}</h3>
              <p>{item.description}</p>
            </div>
          </article>
        ))}
      </div>
      {!filtered.length && (
        <div className="empty-state">
          <Heart size={28} />
          <h2>{onlyFavorites ? "No favorites yet" : `No ${noun} found.`}</h2>
          <p>
            {onlyFavorites
              ? "Tap a heart to save an item."
              : "Try a different search or category."}
          </p>
        </div>
      )}
      <div className="catalog-pagination">
        <p className="muted" aria-live="polite">
          Showing {Math.min(limit, filtered.length)} of {filtered.length} {noun}
        </p>
        {filtered.length > limit && (
          <button className="button" onClick={() => setLimit((n) => n + 48)}>
            Load more
          </button>
        )}
      </div>
      <p className="small muted catalog-note">
        External sites open through your selected browsing engine. Provider
        sign-in, subscriptions, regional availability, and browser compatibility
        vary.
      </p>
    </div>
  );
}
