import { defineConfig, envField } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import sitemap from "@astrojs/sitemap";
import remarkToc from "remark-toc";
import remarkCollapse from "remark-collapse";
import {
  transformerNotationDiff,
  transformerNotationHighlight,
  transformerNotationWordHighlight,
} from "@shikijs/transformers";
import { transformerFileName } from "./src/utils/transformers/fileName";
import { SITE } from "./src/config";
import { visit } from "unist-util-visit";
import fs from "node:fs";
import path from "node:path";

function customRehypeLazyLoadImage() {
  return function (tree: Parameters<typeof visit>[0]) {
    visit(tree, function (node) {
      const el = node as {
        tagName?: string;
        properties?: Record<string, string>;
      };
      if (el.tagName === "img") {
        el.properties ??= {};
        el.properties.loading = "lazy";
        el.properties.decoding = "async";
      }
    });
  };
}
// Build a URL-to-lastmod map from blog frontmatter for sitemap
function buildLastmodMap(): Map<string, string> {
  const blogDir = path.resolve("src/data/blog");
  const map = new Map<string, string>();
  if (!fs.existsSync(blogDir)) return map;

  for (const file of fs.readdirSync(blogDir)) {
    if (!file.endsWith(".md") || file.startsWith("_")) continue;
    const content = fs.readFileSync(path.join(blogDir, file), "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;
    const fm = fmMatch[1];

    const draftMatch = fm.match(/^draft:\s*true/m);
    if (draftMatch) continue;

    const modMatch = fm.match(/^modDatetime:\s*(.+)$/m);
    const pubMatch = fm.match(/^pubDatetime:\s*(.+)$/m);
    const dateStr = modMatch?.[1] ?? pubMatch?.[1];
    if (!dateStr) continue;

    // Use filename as-is (without kebab-case conversion) to match Astro's slug generation
    const slug = file.replace(/\.md$/, "");
    const url = `${SITE.website}posts/${slug}/`;
    map.set(url, new Date(dateStr.trim()).toISOString());
  }
  return map;
}

const lastmodMap = buildLastmodMap();

// https://astro.build/config
export default defineConfig({
  site: SITE.website,
  integrations: [
    sitemap({
      filter: page => {
        // Exclude archives page if not enabled
        if (!SITE.showArchives && page.endsWith("/archives")) return false;
        // Exclude search page (noindex)
        if (page.includes("/search")) return false;
        // Exclude pagination pages (noindex): /posts/2/, /tags/xxx/2/, etc.
        if (/\/posts\/\d+\/$/.test(page)) return false;
        if (/\/tags\/[^/]+\/\d+\/$/.test(page)) return false;
        return true;
      },
      serialize(item) {
        const lastmod = lastmodMap.get(item.url);
        if (lastmod) {
          item.lastmod = lastmod;
        }
        return item;
      },
    }),
  ],
  markdown: {
    remarkPlugins: [remarkToc, [remarkCollapse, { test: "Table of contents" }]],
    rehypePlugins: [customRehypeLazyLoadImage],
    shikiConfig: {
      // For more themes, visit https://shiki.style/themes
      themes: { light: "min-light", dark: "night-owl" },
      defaultColor: false,
      wrap: false,
      transformers: [
        transformerFileName({ style: "v2", hideDot: false }),
        transformerNotationHighlight(),
        transformerNotationWordHighlight(),
        transformerNotationDiff({ matchAlgorithm: "v3" }),
      ],
    },
  },
  vite: {
    // eslint-disable-next-line
    // @ts-ignore
    // This will be fixed in Astro 6 with Vite 7 support
    // See: https://github.com/withastro/astro/issues/14030
    plugins: [tailwindcss()],
    optimizeDeps: {
      exclude: ["@resvg/resvg-js"],
    },
  },
  image: {
    responsiveStyles: true,
    layout: "constrained",
  },
  env: {
    schema: {
      PUBLIC_GOOGLE_SITE_VERIFICATION: envField.string({
        access: "public",
        context: "client",
        optional: true,
      }),
    },
  },
  experimental: {
    preserveScriptOrder: true,
  },
});
