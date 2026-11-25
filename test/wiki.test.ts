import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { articleUrl, createWiki, excerpt, readArticle } from '../src/wiki.ts';

type Call = { url: URL; init: RequestInit | undefined };

/** A fetch stand-in that answers each API call with the next queued body. */
function fakeFetch(...bodies: unknown[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchStub: typeof fetch = (input, init) => {
    calls.push({ url: new URL(input instanceof Request ? input.url : input), init });
    const body = bodies.shift();
    if (body instanceof Response) return Promise.resolve(body);
    return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8' } }));
  };
  return { fetch: fetchStub, calls };
}

const pageHtml = `
<div class="mw-parser-output">
  <div class="druid-infobox">
    <div class="druid-row"><div class="druid-label">Sell price</div><div class="druid-data">120 credits</div></div>
    <div class="druid-row"><div class="druid-label">Rarity</div><div class="druid-data">Rare</div></div>
  </div>
  <p>A <b>Water Filter</b> cleans water for aquaculture tanks.</p>
  <div class="toc">Contents</div>
  <div class="mw-heading mw-heading2"><h2 id="Obtaining">Obtaining</h2><span class="mw-editsection">edit</span></div>
  <p>Bought from the Commissary.</p>
  <div class="mw-heading mw-heading3"><h3 id="Scavenging">Scavenging</h3></div>
  <p>Sometimes found at the Dumping Ground.</p>
  <table class="wikitable">
    <tr><th>Source</th><th>Chance</th></tr>
    <tr><td>Dumping Ground</td><td>5%<br>per search</td></tr>
  </table>
  <div class="mw-heading mw-heading2"><h2 id="Usage">Usage</h2></div>
  <p>Place it in a tank's water slot.</p>
</div>`;

const article = {
  title: 'Water Filter',
  revid: 812,
  text: pageHtml,
  sections: [
    { line: 'Obtaining', anchor: 'Obtaining' },
    { line: 'Scavenging', anchor: 'Scavenging' },
    { line: '<i>Usage</i>', anchor: 'Usage' },
  ],
};

describe('wiki text helpers', () => {
  it('builds article URLs with underscores and encoded characters', () => {
    assert.equal(articleUrl('Joe Wild'), 'https://probablystolen.wiki.gg/wiki/Joe_Wild');
    assert.equal(articleUrl('R&D/Lab'), 'https://probablystolen.wiki.gg/wiki/R%26D/Lab');
  });

  it('shortens long text to a word limit', () => {
    assert.equal(excerpt('one  two\nthree four', 3), 'one two three…');
    assert.equal(excerpt('short text', 10), 'short text');
  });
});

describe('reading an article', () => {
  it('returns the lead, facts, tables and section list', () => {
    const page = readArticle(article);
    assert.equal(page.url, 'https://probablystolen.wiki.gg/wiki/Water_Filter');
    assert.equal(page.revision, 812);
    assert.ok(!('sectionFound' in page));
    assert.deepEqual(page.facts, [{ label: 'Sell price', value: '120 credits' }, { label: 'Rarity', value: 'Rare' }]);
    assert.equal(page.excerpt, 'A Water Filter cleans water for aquaculture tanks.');
    assert.deepEqual(page.tables, [{ rows: [['Source', 'Chance'], ['Dumping Ground', '5% / per search']], truncated: false }]);
    assert.deepEqual(page.sections.map(({ title }) => title), ['Obtaining', 'Scavenging', 'Usage']);
  });

  it('includes subsections when focusing on a section', () => {
    const page = readArticle(article, 'obtaining');
    assert.ok(!('sectionFound' in page));
    assert.equal(page.section, 'Obtaining');
    assert.equal(page.url, 'https://probablystolen.wiki.gg/wiki/Water_Filter#Obtaining');
    assert.equal(page.excerpt, 'Bought from the Commissary. Sometimes found at the Dumping Ground.');
    assert.equal(page.tables?.length, 1);
  });

  it('stops a subsection at the next heading', () => {
    const page = readArticle(article, 'Scavenging');
    assert.ok(!('sectionFound' in page));
    assert.equal(page.excerpt, 'Sometimes found at the Dumping Ground.');
  });

  it('supports older heading markup', () => {
    const page = readArticle({
      ...article,
      text: '<div class="mw-parser-output"><h2><span class="mw-headline" id="Usage">Usage</span></h2><p>Fits any tank.</p><h2><span id="Trivia">Trivia</span></h2><p>Unrelated.</p></div>',
    }, 'Usage');
    assert.ok(!('sectionFound' in page));
    assert.equal(page.excerpt, 'Fits any tank.');
  });

  it('lists the available sections when the requested one is missing', () => {
    assert.deepEqual(readArticle(article, 'Trivia'), {
      title: 'Water Filter',
      url: 'https://probablystolen.wiki.gg/wiki/Water_Filter',
      revision: 812,
      sectionFound: false,
      sections: [
        { title: 'Obtaining', anchor: 'Obtaining' },
        { title: 'Scavenging', anchor: 'Scavenging' },
        { title: 'Usage', anchor: 'Usage' },
      ],
    });
  });
});

describe('wiki client', () => {
  it('searches the main namespace and cleans snippets', async () => {
    const { fetch, calls } = fakeFetch({
      query: {
        searchinfo: { totalhits: 12 },
        search: [{ title: 'Water Filter', snippet: 'Cleans <span class="searchmatch">water</span>' }],
      },
    });
    const results = await createWiki({ fetch }).search('water', 3);

    assert.deepEqual(results, {
      query: 'water',
      total: 12,
      results: [{ title: 'Water Filter', url: 'https://probablystolen.wiki.gg/wiki/Water_Filter', snippet: 'Cleans water' }],
    });
    const [call] = calls;
    assert.ok(call);
    assert.equal(call.url.pathname, '/api.php');
    assert.equal(call.url.searchParams.get('srsearch'), 'water');
    assert.equal(call.url.searchParams.get('srlimit'), '3');
    assert.equal(call.url.searchParams.get('format'), 'json');
    assert.match(new Headers(call.init?.headers).get('user-agent') ?? '', /^ProbablyStolenMCP\/\d+\.\d+\.\d+/);
  });

  it('fetches an article by title', async () => {
    const { fetch, calls } = fakeFetch({ parse: article });
    const page = await createWiki({ fetch }).page('Water Filter', 'Usage');
    assert.ok(!('found' in page) && !('sectionFound' in page));
    assert.equal(page.excerpt, "Place it in a tank's water slot.");
    assert.equal(calls[0]?.url.searchParams.get('page'), 'Water Filter');
  });

  it('retries a missing title with the exact search match', async () => {
    const { fetch, calls } = fakeFetch(
      { error: { code: 'missingtitle' } },
      { query: { search: [{ title: 'Water Filter', snippet: '' }] } },
      { parse: article },
    );
    const page = await createWiki({ fetch }).page('water_filter');
    assert.ok(!('found' in page));
    assert.equal(page.title, 'Water Filter');
    assert.equal(calls.length, 3);
  });

  it('suggests pages when nothing matches', async () => {
    const { fetch } = fakeFetch(
      { error: { code: 'missingtitle' } },
      { query: { search: [{ title: 'Water Purifier', snippet: 'Purifies' }] } },
    );
    assert.deepEqual(await createWiki({ fetch }).page('Water Pump'), {
      title: 'Water Pump',
      found: false,
      suggestedPages: [{ title: 'Water Purifier', url: 'https://probablystolen.wiki.gg/wiki/Water_Purifier', snippet: 'Purifies' }],
    });
  });

  it('reports HTTP failures, API errors and unexpected data', async () => {
    const failing = fakeFetch(new Response('busy', { status: 503, headers: { 'content-type': 'text/html' } }));
    await assert.rejects(createWiki({ fetch: failing.fetch }).search('x', 1), /HTTP 503/);

    const apiError = fakeFetch({ error: { code: 'ratelimited' } });
    await assert.rejects(createWiki({ fetch: apiError.fetch }).search('x', 1), /could not complete the request \(ratelimited\)/);

    const unexpected = fakeFetch({ query: { search: 'nope' } });
    await assert.rejects(createWiki({ fetch: unexpected.fetch }).search('x', 1), /unexpected search response/);
  });

  it('reports network failures and passes cancellation through', async () => {
    const offline: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    await assert.rejects(createWiki({ fetch: offline }).search('x', 1), /Could not reach the Probably Stolen Wiki/);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(createWiki({ fetch: offline }).search('x', 1, controller.signal), { name: 'AbortError' });
  });
});
