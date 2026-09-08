import { DomainStatus, inputError } from "../core/errors";

export function extractContextVersion(body: string | undefined) {
  if (!body) {
    return undefined;
  }

  const match = body.match(/context_version\s*[：:]\s*`?([^`\n\r]+)`?/i);
  return match?.[1]?.trim();
}

export type SectionMatch = {
  heading: string;
  level: number;
  occurrence: number;
  start: number;
  contentStart: number;
  end: number;
};

function normalizeHeading(value: string) {
  return value
    .replace(/\s+#+\s*$/, "")
    .trim()
    .toLowerCase();
}

function splitLinesWithEndings(value: string) {
  const parts = value.split(/(\r?\n)/);
  const lines: string[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    if (parts[index] || parts[index + 1]) {
      lines.push(`${parts[index]}${parts[index + 1] ?? ""}`);
    }
  }
  return lines;
}

export function listSections(body: string): SectionMatch[] {
  const lines = splitLinesWithEndings(body);
  const sections: Omit<SectionMatch, "end">[] = [];
  const occurrenceCounts = new Map<string, number>();
  let offset = 0;

  for (const line of lines) {
    const rawLine = line.replace(/\r?\n$/, "");
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(rawLine);
    if (!match) {
      offset += line.length;
      continue;
    }

    const level = match[1].length;
    const heading = match[2].replace(/\s+#+\s*$/, "").trim();
    const occurrenceKey = `${level}:${normalizeHeading(heading)}`;
    const occurrence = (occurrenceCounts.get(occurrenceKey) ?? 0) + 1;
    occurrenceCounts.set(occurrenceKey, occurrence);

    sections.push({
      heading,
      level,
      occurrence,
      start: offset,
      contentStart: offset + line.length,
    });

    offset += line.length;
  }

  const nextHeadingStartByLevel: Array<number | undefined> = Array(7).fill(undefined);
  const matches = new Array<SectionMatch>(sections.length);
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const section = sections[index];
    let end = body.length;
    for (let level = 1; level <= section.level; level += 1) {
      end = Math.min(end, nextHeadingStartByLevel[level] ?? body.length);
    }
    matches[index] = { ...section, end };
    nextHeadingStartByLevel[section.level] = section.start;
  }
  return matches;
}

export function findSectionInList(sections: SectionMatch[], heading: string, occurrence = 1, headingLevel?: number): SectionMatch {
  const target = normalizeHeading(heading);
  let seen = 0;

  for (const section of sections) {
    if (normalizeHeading(section.heading) !== target || (headingLevel && section.level !== headingLevel)) {
      continue;
    }

    seen += 1;
    if (seen === occurrence) {
      return section;
    }
  }

  throw inputError(`Heading not found: ${heading}`, "Check the outline first, then pass the exact heading text and occurrence if needed.", DomainStatus.SectionNotFound);
}

export function findSection(body: string, heading: string, occurrence = 1, headingLevel?: number): SectionMatch {
  return findSectionInList(listSections(body), heading, occurrence, headingLevel);
}

export function outlineFromSections(sections: SectionMatch[], maxHeadings = 120) {
  return sections
    .slice(0, maxHeadings)
    .map((section) => ({
      heading: section.heading,
      heading_level: section.level,
      occurrence: section.occurrence,
      content_chars: Math.max(0, section.end - section.contentStart),
    }));
}
