require("dotenv").config();
const { Octokit } = require("@octokit/rest");
const wordwrap = require("wordwrap");
const got = require('got');
const Parser = require('rss-parser');

function sanitizeXML(xml) {
  // Fix common XML parsing issues with minimal changes
  let cleaned = xml;
  
  // Replace unescaped ampersands that aren't part of entities
  cleaned = cleaned.replace(/&(?![a-zA-Z0-9#]+;)/g, '&amp;');
  
  // Fix any unclosed XML tags by ensuring proper closing
  // This is a simplified approach that handles common RSS issues
  cleaned = cleaned.replace(/<(\w+)([^>]*?)(?:\s*\/)?>([^<]*)<\/\1>/g, (match, tag, attrs, content) => {
    // Ensure content doesn't break XML parsing
    const safeContent = content.replace(/&(?![a-zA-Z0-9#]+;)/g, '&amp;');
    return `<${tag}${attrs}>${safeContent}</${tag}>`;
  });
  
  return cleaned;
}

const {
  GIST_ID: gistId,
  GH_TOKEN: githubToken,
  RSS_FEED_URL: rssFeedUrl,
} = process.env;

const octokit = new Octokit({
  auth: `token ${githubToken}`
});
const parser = new Parser({ timeout: 15000 });

async function main() {
  const wrap = wordwrap(100); // Increased from 58 to prevent unwanted line breaks

  try {
    const resp = await got(rssFeedUrl, { retry: { limit: 2 } });

    console.log('Attempting to parse RSS feed...');

    let feed;
    try {
      // First try parsing without sanitization
      try {
        feed = await parser.parseString(resp.body);
      } catch (firstError) {
        console.log('First parse attempt failed, trying with sanitization...');
        const safeBody = sanitizeXML(resp.body);
        feed = await parser.parseString(safeBody);
      }
    } catch (e) {
      console.error('RSS parse failed:', e);
      // Fail-soft: still update the gist with a friendly message instead of aborting
      await updateGist([
        wrap("I'm not reading anything at the moment.\n"),
        wrap("I haven't read anything recently.")
      ]);
      return;
    }

    const items = feed.items || [];
    console.log(`Found ${items.length} RSS items`);

    // Find currently reading and recently read items based on Goodreads activity patterns
    let currentlyReadingTitle = '';
    let currentlyReadingAuthor = '';
    let currentlyReadingStartDate = '';
    let recentlyReadBooks = [];

    // Calculate 6 months ago
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    for (const item of items) {
      const title = (item.title || '').trim();
      const description = (
        item.contentSnippet ||
        item.content ||
        item.description ||
        (item['content:encoded'] || '')
      ).toString();
      console.log(`Checking item: ${title}`);

      // Look for "currently reading" patterns - Goodreads uses "is currently reading"
      if (title.toLowerCase().includes('is currently reading')) {
        const match = title.match(/is currently reading\s+['"](.+?)['"]$/i);
        if (match) {
          const bookTitle = match[1].trim();
          // Extract author from description
          const authorMatch = description.match(/by\s+([^<]+)/i);
          if (authorMatch) {
            currentlyReadingTitle = bookTitle;
            currentlyReadingAuthor = authorMatch[1].trim();
            // Extract and format start date
            if (item.pubDate) {
              const date = new Date(item.pubDate);
              currentlyReadingStartDate = date.toLocaleDateString('en-US', { 
                month: 'short', 
                day: 'numeric', 
                year: 'numeric' 
              });
            }
            console.log(`Found currently reading: ${currentlyReadingTitle} by ${currentlyReadingAuthor} (started ${currentlyReadingStartDate})`);
          }
        }
      }

      // Look for "added" patterns which indicate finished reading (when combined with rating)
      if (title.toLowerCase().includes('added \'') && description.toLowerCase().includes('stars')) {
        const match = title.match(/added\s+['"](.+?)['"]$/i);
        if (match) {
          const bookTitle = match[1].trim();
          // Extract author from description
          const authorMatch = description.match(/by\s+([^<]+)/i);
          if (authorMatch && item.pubDate) {
            const finishDate = new Date(item.pubDate);
            // Only include books finished within the last 6 months
            if (finishDate >= sixMonthsAgo) {
              const formattedDate = finishDate.toLocaleDateString('en-US', { 
                month: 'short', 
                day: 'numeric', 
                year: 'numeric' 
              });
              recentlyReadBooks.push({
                title: bookTitle,
                author: authorMatch[1].trim(),
                date: formattedDate,
                pubDate: finishDate
              });
              console.log(`Found recently read: ${bookTitle} by ${authorMatch[1].trim()} (${formattedDate})`);
            }
          }
        }
      }
    }

    // Create data for currently reading; remove subtitle if it exists
    const currentlyReading = currentlyReadingTitle && currentlyReadingAuthor
      ? `Currently reading: ${currentlyReadingTitle.split(':')[0]} by ${currentlyReadingAuthor}${currentlyReadingStartDate ? ` (started ${currentlyReadingStartDate})` : ''}\n`
      : `I'm not reading anything at the moment.\n`

    // Create data for recently read; remove subtitle if it exists and sort by date (most recent first)
    recentlyReadBooks.sort((a, b) => b.pubDate - a.pubDate);
    const recentlyRead = recentlyReadBooks.length > 0
      ? recentlyReadBooks.map(book => 
          `Recently read: ${book.title.split(':')[0]} by ${book.author} (${book.date})`
        ).join('\n')
      : `I haven't read anything recently.`

    // Update your gist
    await updateGist([wrap(currentlyReading), wrap(recentlyRead)]);
  } catch (error) {
    console.error(`Unable to fetch RSS feed\n${error}`);
    // Fail-soft: still update the gist with a friendly message instead of aborting
    try {
      const wrap = wordwrap(58);
      await updateGist([
        wrap("I'm not reading anything at the moment.\n"),
        wrap("I haven't read anything recently.")
      ]);
    } catch (_) {
      // ignore secondary failures
    }
  }
}

async function updateGist(readingStatus) {

  if (!gistId || !githubToken) {
    console.error('Missing GIST_ID or GH_TOKEN in environment.');
    return;
  }

  let gist;
  try {
    gist = await octokit.gists.get({ gist_id: gistId });
  } catch (error) {
    console.error(`Unable to get gist\n${error}`);
    return; // bail if we can't access the gist (bad ID, wrong token, or private gist not owned by token user)
  }

  // Get original filename to update that same file
  const filename = Object.keys(gist.data.files)[0];

  // Only update if the content has changed
  if (gist.data.files[filename].content === readingStatus.join('\n')) {
    console.log(`Reading status hasn't changed; skipping update.`);
    return;
  }

  try {
    await octokit.gists.update({
      gist_id: gistId,
      files: {
        [filename]: {
          filename,
          content: readingStatus.join('\n'),
        }
      }
    });
  } catch (error) {
    console.error(`Unable to update gist\n${error}`);
  }
}

(async () => {
  await main();
})();