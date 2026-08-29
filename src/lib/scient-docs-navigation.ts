interface ScientDocsNavigationPage {
  slug: string;
  topic: string;
  secondary?: boolean;
}

export function getScientDocsNavigationGroups<T extends ScientDocsNavigationPage>(
  pages: readonly T[],
) {
  const groupsByTopic = new Map<
    string,
    {
      title: string;
      pages: T[];
      primaryPages: T[];
      secondaryPages: T[];
    }
  >();

  for (const page of pages) {
    let group = groupsByTopic.get(page.topic);
    if (!group) {
      group = {
        title: page.topic,
        pages: [],
        primaryPages: [],
        secondaryPages: [],
      };
      groupsByTopic.set(page.topic, group);
    }

    group.pages.push(page);
    if (page.secondary === true) group.secondaryPages.push(page);
    else group.primaryPages.push(page);
  }

  return [...groupsByTopic.values()] as Array<{
    title: string;
    pages: T[];
    primaryPages: T[];
    secondaryPages: T[];
  }>;
}
