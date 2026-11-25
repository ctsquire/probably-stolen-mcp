import { load } from 'cheerio';

const wiki = 'https://probablystolen.wiki.gg';
const headingSelector = 'h2, h3, h4, h5, h6, .mw-heading';
const boilerplateSelector = '.toc, .mw-editsection, .ps-language-links, .ps-browse-nav, script, style';

const clean = text => text.replace(/\s+/g, ' ').trim();
const normalize = text => clean(text.replaceAll('_', ' ')).toLowerCase();
const clip = (text, length) => text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;
const plain = html => clean(load(html, {}, false).root().text());

function excerpt(text) {
  const words = clean(text).split(' ');
  return clip(words.length > 25 ? `${words.slice(0, 25).join(' ')}…` : words.join(' '), 330);
}

function articleUrl(title) {
  const slug = encodeURIComponent(title.replaceAll(' ', '_')).replaceAll('%2F', '/');
  return `${wiki}/wiki/${slug}`;
}

async function request(parameters, signal) {
  const url = new URL('/api.php', wiki);
  url.search = new URLSearchParams({ ...parameters, format: 'json', formatversion: '2' });
  const timeout = AbortSignal.timeout(12_000);
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'ProbablyStolenMCP/0.1 (read-only game reference)' },
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  }).catch(error => {
    if (signal?.aborted) throw error;
    if (timeout.aborted) throw new Error('The Probably Stolen Wiki took too long to respond.');
    throw new Error('Could not reach the Probably Stolen Wiki. Check your internet connection and try again.');
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw new Error(`The Probably Stolen Wiki did not return data (HTTP ${response.status}). Try again or open ${wiki}.`);
  }
  const data = await response.json();
  if (data.error && data.error.code !== 'missingtitle') {
    throw new Error(`The Probably Stolen Wiki could not complete the request (${data.error.code}).`);
  }
  return data;
}

export async function searchWiki(query, limit, signal) {
  const data = await request({
    action: 'query', list: 'search', srsearch: query, srnamespace: '0',
    srlimit: String(limit), srprop: 'snippet',
  }, signal);
  if (!Array.isArray(data.query?.search)) throw new Error('The wiki returned an unexpected search response.');

  return {
    query,
    total: data.query.searchinfo?.totalhits ?? data.query.search.length,
    results: data.query.search.map(({ title, snippet }) => ({
      title,
      url: articleUrl(title),
      snippet: excerpt(plain(snippet ?? '')),
    })),
  };
}

function readArticle({ title, revid, text, sections = [] }, requestedSection) {
  if (typeof text !== 'string') throw new Error('The wiki returned an unexpected article response.');
  const $ = load(text);
  $(boilerplateSelector).remove();
  const content = $('.mw-parser-output').first();
  const root = content.length ? content : $('body');
  const url = articleUrl(title);
  const availableSections = sections.map(({ line, anchor }) => ({ title: plain(line), anchor }));
  const selected = requestedSection && availableSections.find(({ title: name, anchor }) => (
    normalize(name) === normalize(requestedSection) || normalize(anchor) === normalize(requestedSection)
  ));

  if (requestedSection && !selected) {
    return { title, url, revision: revid, sectionFound: false, sections: availableSections };
  }

  const facts = root.find('.druid-row').slice(0, 20).toArray().flatMap(row => {
    const label = clean($(row).find('.druid-label').text());
    const value = clip(clean($(row).find('.druid-data').text()), 160);
    return label && value ? [{ label, value }] : [];
  });

  let block = root.children().first();
  if (selected) {
    const anchor = root.find('[id]').filter((_, element) => $(element).attr('id') === selected.anchor).first();
    const heading = anchor.closest(headingSelector);
    const wrapper = heading.parent('.mw-heading');
    block = (wrapper.length ? wrapper : heading).next();
  }

  const contents = [];
  while (block.length && !block.is(headingSelector)) {
    contents.push(block);
    block = block.next();
  }

  const description = contents.flatMap(element => {
    if (element.is('p, ul, ol')) return [element.text()];
    return element.find('p, ul, ol').toArray()
      .filter(node => !$(node).closest('table, .druid-infobox').length)
      .map(node => $(node).text());
  }).join(' ');

  const getTables = elements => elements.flatMap(element => (
    element.is('table.wikitable') ? [element[0]] : element.find('table.wikitable').toArray()
  ));
  const tables = (selected ? getTables(contents) : root.find('table.wikitable').slice(0, 2).toArray())
    .slice(0, 3).map(table => {
      const rows = $(table).find('tr').toArray().filter(row => $(row).closest('table')[0] === table);
      return {
        rows: rows.slice(0, 11).map(row => $(row).children('th, td').toArray().map(cell => {
          const content = $(cell).clone();
          content.find('br').replaceWith(' / ');
          return clip(clean(content.text()), 180);
        })),
        truncated: rows.length > 11,
      };
    });

  return {
    title, url: selected ? `${url}#${encodeURIComponent(selected.anchor)}` : url, revision: revid,
    ...(selected ? { section: selected.title } : {}),
    ...(facts.length ? { facts } : {}),
    ...(clean(description) ? { excerpt: excerpt(description) } : {}),
    ...(tables.length ? { tables } : {}),
    sections: availableSections,
  };
}

function fetchArticle(title, signal) {
  return request({ action: 'parse', page: title, prop: 'text|revid|sections', redirects: '1' }, signal);
}

export async function getWikiPage(title, section, signal) {
  const data = await fetchArticle(title, signal);
  if (data.parse) return readArticle(data.parse, section);
  if (data.error?.code !== 'missingtitle') throw new Error('The wiki returned an unexpected article response.');

  const { results } = await searchWiki(clean(title.replaceAll('_', ' ')), 5, signal);
  const exact = results.find(result => normalize(result.title) === normalize(title));
  if (exact) {
    const corrected = await fetchArticle(exact.title, signal);
    if (corrected.parse) return readArticle(corrected.parse, section);
  }
  return { title, found: false, suggestedPages: results };
}
