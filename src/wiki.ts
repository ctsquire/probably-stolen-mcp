import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { z } from 'zod';
import { serverVersion } from './version.ts';

export const wikiUrl = 'https://probablystolen.wiki.gg';

const headingTags = 'h1, h2, h3, h4, h5, h6';
const boilerplateSelector = '.toc, .mw-editsection, .ps-language-links, .ps-browse-nav, script, style';
const leadWords = 60;
const sectionWords = 150;
const maxFacts = 20;
const maxTables = 3;
const maxTableRows = 11;

export type SearchResult = { title: string; url: string; snippet: string };
export type SearchResults = { query: string; total: number; results: SearchResult[] };
export type WikiSection = { title: string; anchor: string };
export type WikiFact = { label: string; value: string };
export type WikiTable = { rows: string[][]; truncated: boolean };
export type WikiPage = {
  title: string;
  url: string;
  revision: number;
  section?: string;
  facts?: WikiFact[];
  excerpt?: string;
  tables?: WikiTable[];
  sections: WikiSection[];
};
export type MissingSection = { title: string; url: string; revision: number; sectionFound: false; sections: WikiSection[] };
export type MissingPage = { title: string; found: false; suggestedPages: SearchResult[] };

export type WikiOptions = {
  /** Replaces the global fetch, mainly for tests. */
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type Wiki = {
  search: (query: string, limit: number, signal?: AbortSignal) => Promise<SearchResults>;
  page: (title: string, section?: string, signal?: AbortSignal) => Promise<WikiPage | MissingSection | MissingPage>;
};

const apiErrorSchema = z.object({ error: z.object({ code: z.string() }) });
const searchSchema = z.object({
  query: z.object({
    searchinfo: z.object({ totalhits: z.number() }).optional(),
    search: z.array(z.object({ title: z.string(), snippet: z.string().optional() })),
  }),
});
const articleSchema = z.object({
  parse: z.object({
    title: z.string(),
    revid: z.number(),
    text: z.string(),
    sections: z.array(z.object({ line: z.string(), anchor: z.string() })).default([]),
  }),
});
type Article = z.infer<typeof articleSchema>['parse'];

export const clean = (text: string): string => text.replace(/\s+/g, ' ').trim();
const normalize = (text: string): string => clean(text.replaceAll('_', ' ')).toLowerCase();
export const clip = (text: string, length: number): string => (
  text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text
);
const plain = (html: string): string => clean(load(html, null, false).root().text());

export function excerpt(text: string, maxWords: number): string {
  const words = clean(text).split(' ');
  const shortened = words.length > maxWords ? `${words.slice(0, maxWords).join(' ')}…` : words.join(' ');
  return clip(shortened, maxWords * 14);
}

export function articleUrl(title: string): string {
  const slug = encodeURIComponent(title.replaceAll(' ', '_')).replaceAll('%2F', '/');
  return `${wikiUrl}/wiki/${slug}`;
}

/** Heading level (1–6) of a heading element or a `.mw-heading` wrapper; undefined for other elements. */
function headingLevel(node: Cheerio<Element>): number | undefined {
  const heading = node.is('.mw-heading') ? node.children(headingTags).first() : node;
  const tag = heading.get(0)?.tagName.toLowerCase();
  return tag && /^h[1-6]$/.test(tag) ? Number(tag.slice(1)) : undefined;
}

/** Collects the blocks after `start` until a heading at `stopLevel` or above. */
function collectBlocks(start: Cheerio<Element>, stopLevel: number): Cheerio<Element>[] {
  const blocks: Cheerio<Element>[] = [];
  for (let block = start; block.length > 0; block = block.next()) {
    const level = headingLevel(block);
    if (level !== undefined && level <= stopLevel) break;
    blocks.push(block);
  }
  return blocks;
}

function readTable($: CheerioAPI, table: Element): WikiTable {
  const rows = $(table).find('tr').toArray().filter(row => $(row).closest('table').get(0) === table);
  return {
    rows: rows.slice(0, maxTableRows).map(row => $(row).children('th, td').toArray().map(cell => {
      const content = $(cell).clone();
      content.find('br').replaceWith(' / ');
      return clip(clean(content.text()), 180);
    })),
    truncated: rows.length > maxTableRows,
  };
}

export function readArticle(article: Article, requestedSection?: string): WikiPage | MissingSection {
  const { title, revid: revision } = article;
  const $ = load(article.text);
  $(boilerplateSelector).remove();
  const content = $('.mw-parser-output').first();
  const root = content.length > 0 ? content : $('body');
  const url = articleUrl(title);
  const sections = article.sections.map(({ line, anchor }) => ({ title: plain(line), anchor }));
  const selected = requestedSection === undefined
    ? undefined
    : sections.find(({ title: name, anchor }) => (
      normalize(name) === normalize(requestedSection) || normalize(anchor) === normalize(requestedSection)
    ));

  if (requestedSection !== undefined && !selected) {
    return { title, url, revision, sectionFound: false, sections };
  }

  const facts = root.find('.druid-row').slice(0, maxFacts).toArray().flatMap(row => {
    const label = clean($(row).find('.druid-label').text());
    const value = clip(clean($(row).find('.druid-data').text()), 160);
    return label && value ? [{ label, value }] : [];
  });

  let blocks: Cheerio<Element>[] = [];
  if (selected) {
    const heading = root.find(headingTags).toArray().find(element => (
      $(element).attr('id') === selected.anchor
      || $(element).find('[id]').toArray().some(child => $(child).attr('id') === selected.anchor)
    ));
    if (heading) {
      const wrapper = $(heading).parent('.mw-heading');
      const marker = wrapper.length > 0 ? wrapper : $(heading);
      blocks = collectBlocks(marker.next(), headingLevel(marker) ?? 6);
    }
  } else {
    blocks = collectBlocks(root.children().first(), 6);
  }

  const description = blocks.flatMap(block => {
    if (block.is('p, ul, ol, dl')) return [block.text()];
    return block.find('p, ul, ol, dl').toArray()
      .filter(node => $(node).closest('table, .druid-infobox').length === 0)
      .map(node => $(node).text());
  }).join(' ');

  const tableElements = selected
    ? blocks.flatMap(block => (block.is('table.wikitable') ? block.toArray() : block.find('table.wikitable').toArray()))
    : root.find('table.wikitable').toArray();
  const tables = tableElements.slice(0, maxTables).map(table => readTable($, table));
  const summary = excerpt(description, selected ? sectionWords : leadWords);

  return {
    title,
    url: selected ? `${url}#${encodeURIComponent(selected.anchor)}` : url,
    revision,
    ...(selected ? { section: selected.title } : {}),
    ...(facts.length > 0 ? { facts } : {}),
    ...(summary ? { excerpt: summary } : {}),
    ...(tables.length > 0 ? { tables } : {}),
    sections,
  };
}

export function createWiki({ fetch: fetchImpl = fetch, timeoutMs = 12_000 }: WikiOptions = {}): Wiki {
  async function request(parameters: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    const url = new URL('/api.php', wikiUrl);
    url.search = new URLSearchParams({ ...parameters, format: 'json', formatversion: '2' }).toString();
    const timeout = AbortSignal.timeout(timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: {
          accept: 'application/json',
          'user-agent': `ProbablyStolenMCP/${serverVersion} (+https://github.com/ctsquire/probably-stolen-mcp)`,
        },
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      signal?.throwIfAborted();
      if (timeout.aborted) throw new Error('The Probably Stolen Wiki took too long to respond.');
      throw new Error('Could not reach the Probably Stolen Wiki. Check your internet connection and try again.');
    }

    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
      throw new Error(`The Probably Stolen Wiki did not return data (HTTP ${String(response.status)}). Try again or open ${wikiUrl}.`);
    }
    const data: unknown = await response.json();
    const apiError = apiErrorSchema.safeParse(data);
    if (apiError.success && apiError.data.error.code !== 'missingtitle') {
      throw new Error(`The Probably Stolen Wiki could not complete the request (${apiError.data.error.code}).`);
    }
    return data;
  }

  async function search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResults> {
    const data = searchSchema.safeParse(await request({
      action: 'query', list: 'search', srsearch: query, srnamespace: '0', srlimit: String(limit), srprop: 'snippet',
    }, signal));
    if (!data.success) throw new Error('The wiki returned an unexpected search response.');

    const { search: matches, searchinfo } = data.data.query;
    return {
      query,
      total: searchinfo?.totalhits ?? matches.length,
      results: matches.map(({ title, snippet }) => ({
        title,
        url: articleUrl(title),
        snippet: excerpt(plain(snippet ?? ''), 25),
      })),
    };
  }

  /** Returns the parsed article, or undefined when the wiki has no page with that title. */
  async function fetchArticle(title: string, signal?: AbortSignal): Promise<Article | undefined> {
    const data = await request({ action: 'parse', page: title, prop: 'text|revid|sections', redirects: '1' }, signal);
    const article = articleSchema.safeParse(data);
    if (article.success) return article.data.parse;
    if (apiErrorSchema.safeParse(data).success) return undefined;
    throw new Error('The wiki returned an unexpected article response.');
  }

  async function page(title: string, section?: string, signal?: AbortSignal): Promise<WikiPage | MissingSection | MissingPage> {
    const article = await fetchArticle(title, signal);
    if (article) return readArticle(article, section);

    const { results } = await search(clean(title.replaceAll('_', ' ')), 5, signal);
    const exact = results.find(result => normalize(result.title) === normalize(title));
    if (exact) {
      const corrected = await fetchArticle(exact.title, signal);
      if (corrected) return readArticle(corrected, section);
    }
    return { title, found: false, suggestedPages: results };
  }

  return { search, page };
}
