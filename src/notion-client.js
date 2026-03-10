import { config } from './config.js';

const NOTION_BASE = 'https://api.notion.com/v1';

const headers = {
  'Authorization': `Bearer ${config.notion.apiKey}`,
  'Content-Type': 'application/json',
  'Notion-Version': config.notion.version,
};

export async function notionFetch(path, options = {}) {
  const res = await fetch(`${NOTION_BASE}${path}`, {
    headers,
    ...options,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Notion API ${res.status}: ${body}`);
  }
  return res.json();
}

/** Query all pages from a database */
export async function queryDatabase(dbId, filter = undefined) {
  const body = {};
  if (filter) body.filter = filter;
  return notionFetch(`/databases/${dbId}/query`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** Get a page by ID */
export async function getPage(pageId) {
  return notionFetch(`/pages/${pageId}`);
}

/** Get page content (blocks) */
export async function getPageBlocks(pageId) {
  return notionFetch(`/blocks/${pageId}/children?page_size=100`);
}

/** Get comments on a page */
export async function getComments(pageId) {
  return notionFetch(`/comments?block_id=${pageId}`);
}

/** Update page properties */
export async function updatePage(pageId, properties) {
  return notionFetch(`/pages/${pageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties }),
  });
}

/** Extract plain text from rich_text array */
export function richTextToPlain(richTextArray) {
  if (!richTextArray || !Array.isArray(richTextArray)) return '';
  return richTextArray.map(rt => rt.plain_text || '').join('');
}

/** Extract blocks content as plain text */
export function blocksToPlainText(blocks) {
  if (!blocks?.results) return '';
  return blocks.results
    .map(block => {
      const type = block.type;
      const content = block[type];
      if (!content) return '';
      if (content.rich_text) return richTextToPlain(content.rich_text);
      if (content.text) return richTextToPlain(content.text);
      return '';
    })
    .filter(Boolean)
    .join('\n');
}
