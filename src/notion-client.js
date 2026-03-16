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

// --- Rate limiter for recursive block fetches ---
const MIN_REQUEST_GAP_MS = 350;
let lastRequestTime = 0;
let requestQueue = Promise.resolve();

function rateLimitedNotionFetch(path, options = {}) {
  return new Promise((resolve, reject) => {
    requestQueue = requestQueue.then(async () => {
      const now = Date.now();
      const elapsed = now - lastRequestTime;
      if (elapsed < MIN_REQUEST_GAP_MS) {
        await new Promise(r => setTimeout(r, MIN_REQUEST_GAP_MS - elapsed));
      }
      lastRequestTime = Date.now();
      try { resolve(await notionFetch(path, options)); }
      catch (err) { reject(err); }
    });
  });
}

// --- Paginated single-level block fetch ---
async function getAllBlocks(blockId) {
  const allBlocks = [];
  let cursor = undefined;
  do {
    let path = `/blocks/${blockId}/children?page_size=100`;
    if (cursor) path += `&start_cursor=${cursor}`;
    const data = await rateLimitedNotionFetch(path);
    allBlocks.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return allBlocks;
}

// --- Recursive block fetcher ---
const MAX_DEPTH = 5;

async function fetchBlocksRecursive(blockId, depth = 0) {
  if (depth > MAX_DEPTH) return [];

  const blocks = await getAllBlocks(blockId);

  for (const block of blocks) {
    // Synced blocks: fetch from the original source
    if (block.type === 'synced_block' && block.synced_block?.synced_from?.block_id) {
      const sourceId = block.synced_block.synced_from.block_id;
      block.children = await fetchBlocksRecursive(sourceId, depth + 1);
    } else if (block.has_children) {
      block.children = await fetchBlocksRecursive(block.id, depth + 1);
    }
  }

  return blocks;
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

/** Get page content (blocks) — recursive, fetches all nested children */
export async function getPageBlocks(pageId) {
  const blocks = await fetchBlocksRecursive(pageId, 0);
  return { results: blocks };
}

/** Get a single comment by ID */
export async function getComment(commentId) {
  return notionFetch(`/comments/${commentId}`);
}

/** Get a single block by ID */
export async function getBlock(blockId) {
  return notionFetch(`/blocks/${blockId}`);
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

/** Extract text from a single block */
function extractBlockText(block, indent) {
  const type = block.type;
  const content = block[type];
  const prefix = '  '.repeat(indent);

  if (!content && type !== 'divider') return '';

  switch (type) {
    case 'bulleted_list_item':
      return `${prefix}• ${richTextToPlain(content.rich_text)}`;
    case 'numbered_list_item':
      return `${prefix}- ${richTextToPlain(content.rich_text)}`;
    case 'to_do': {
      const check = content.checked ? 'x' : ' ';
      return `${prefix}[${check}] ${richTextToPlain(content.rich_text)}`;
    }
    case 'table_row':
      return `${prefix}${(content.cells || []).map(cell => richTextToPlain(cell)).join(' | ')}`;
    case 'divider':
      return `${prefix}---`;
    case 'column_list':
    case 'column':
      return ''; // no text, children processed recursively
    default: {
      if (content?.rich_text) return `${prefix}${richTextToPlain(content.rich_text)}`;
      if (content?.text) return `${prefix}${richTextToPlain(content.text)}`;
      return '';
    }
  }
}

/** Recursively flatten block tree to text lines */
function flattenBlocksToText(blocks, indent = 0) {
  const lines = [];
  for (const block of blocks) {
    const text = extractBlockText(block, indent);
    if (text) lines.push(text);
    if (block.children?.length) {
      lines.push(...flattenBlocksToText(block.children, indent + 1));
    }
  }
  return lines;
}

/** Extract blocks content as plain text (recursive) */
export function blocksToPlainText(blocks) {
  if (!blocks?.results) return '';
  return flattenBlocksToText(blocks.results, 0).filter(Boolean).join('\n');
}
