import { describe, expect, it } from "vitest";

import { getScientDocsNavigationGroups } from "./scient-docs-navigation";

describe("Scient Docs navigation", () => {
  it("uses manifest order and topic metadata as the only navigation authority", () => {
    const pages = [
      { slug: "start", topic: "Essentials" },
      { slug: "project", topic: "Essentials" },
      { slug: "voice", topic: "Work in Scient" },
      { slug: "keys", topic: "Work in Scient", secondary: true },
    ];

    const groups = getScientDocsNavigationGroups(pages);

    expect(groups.map((group) => group.title)).toEqual(["Essentials", "Work in Scient"]);
    expect(groups[0]?.primaryPages.map((page) => page.slug)).toEqual(["start", "project"]);
    expect(groups[1]?.primaryPages.map((page) => page.slug)).toEqual(["voice"]);
    expect(groups[1]?.secondaryPages.map((page) => page.slug)).toEqual(["keys"]);
    expect(groups[1]?.pages.map((page) => page.slug)).toEqual(["voice", "keys"]);
  });

  it("treats pages as primary unless the manifest explicitly marks them secondary", () => {
    const [group] = getScientDocsNavigationGroups([
      { slug: "one", topic: "Research" },
      { slug: "two", topic: "Research", secondary: false },
    ]);

    expect(group?.primaryPages).toHaveLength(2);
    expect(group?.secondaryPages).toHaveLength(0);
  });
});
