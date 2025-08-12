require("dotenv").config();
const { Octokit } = require("@octokit/rest");
const wordwrap = require("wordwrap");
const got = require('got');
const { parseStringPromise } = require('xml2js');
const get = require('lodash.get');

const {
  GIST_ID: gistId,
  GH_TOKEN: githubToken,
  RSS_FEED_URL: rssFeedUrl,
} = process.env;

const octokit = new Octokit({
  auth: `token ${githubToken}`
});

async function main() {
  const wrap = wordwrap(58);

  try {
    const rssFeed = await got(rssFeedUrl);

    // Sanitize XML to handle invalid characters and malformed tags
    let xmlContent = rssFeed.body;
    // Replace common problematic characters
    xmlContent = xmlContent.replace(/&(?![a-zA-Z0-9#]{1,7};)/g, '&amp;');
    // Fix common XML issues
    xmlContent = xmlContent.replace(/<(\w+)>/g, '<$1>').replace(/<\/(\w+)>/g, '</$1>');
    // Remove any standalone > characters that might cause issues
    xmlContent = xmlContent.replace(/(?<![<\/\w])\s*>\s*(?![<\w])/g, '&gt;');
    
    console.log('Attempting to parse RSS feed...');
    
    // Convert RSS data from XML to JSON with more lenient parsing
    let parsedRssFeed;
    try {
      parsedRssFeed = await parseStringPromise(xmlContent, {
        explicitArray: true,
        trim: true,
        normalize: true,
        ignoreAttrs: true,
        explicitRoot: false
      });
    } catch (xmlError) {
      console.log('First XML parse failed, trying more aggressive cleaning...');
      // More aggressive XML cleaning for severely malformed feeds
      xmlContent = xmlContent
        .replace(/&(?![a-zA-Z0-9#]{1,7};)/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/&lt;(\/?[a-zA-Z][^&]*?)&gt;/g, '<$1>')
        .replace(/&lt;!\[CDATA\[(.*?)\]\]&gt;/g, '<![CDATA[$1]]>');
      
      parsedRssFeed = await parseStringPromise(xmlContent, {
        explicitArray: true,
        trim: true,
        normalize: true,
        ignoreAttrs: true,
        explicitRoot: false
      });
    }

    // Parse out the information required from RSS feed
    // Try different possible RSS structures
    let items = get(parsedRssFeed, 'rss.channel[0].item', []);
    if (items.length === 0) {
      items = get(parsedRssFeed, 'channel[0].item', []);
    }
    if (items.length === 0) {
      items = get(parsedRssFeed, 'feed.entry', []);
    }
    if (items.length === 0) {
      items = get(parsedRssFeed, 'entry', []);
    }
    
    console.log(`Found ${items.length} RSS items`);
    
    // Find currently reading and recently read items based on description or title patterns
    let currentlyReadingTitle = '';
    let currentlyReadingAuthor = '';
    let recentlyReadTitle = '';
    let recentlyReadAuthor = '';

    for (const item of items) {
      const title = get(item, 'title[0]', '');
      const description = get(item, 'description[0]', '');
      console.log(`Checking item: ${title}`);
      
      // Look for "currently reading" patterns in title or description
      if (title.toLowerCase().includes('currently reading') || description.toLowerCase().includes('currently reading')) {
        const match = title.match(/(?:currently reading[:\s]+)?(.+?)\s+by\s+(.+?)(?:\s|$)/i);
        if (match) {
          currentlyReadingTitle = match[1].trim();
          currentlyReadingAuthor = match[2].trim();
          console.log(`Found currently reading: ${currentlyReadingTitle} by ${currentlyReadingAuthor}`);
        }
      }
      
      // Look for "finished" or "read" patterns for recently read
      if ((title.toLowerCase().includes('finished') || title.toLowerCase().includes('read')) && 
          !title.toLowerCase().includes('currently reading')) {
        const match = title.match(/(?:finished|read)[:\s]+(.+?)\s+by\s+(.+?)(?:\s|$)/i);
        if (match) {
          recentlyReadTitle = match[1].trim();
          recentlyReadAuthor = match[2].trim();
          console.log(`Found recently read: ${recentlyReadTitle} by ${recentlyReadAuthor}`);
          break; // Take the first (most recent) finished book
        }
      }
    }

    // Create data for currently reading; remove subtitle if it exists
    const currentlyReading = currentlyReadingTitle && currentlyReadingAuthor
      ? `Currently reading: ${currentlyReadingTitle.split(':')[0]} by ${currentlyReadingAuthor}\n`
      : `I'm not reading anything at the moment.\n`

    // Create data for recently read; remove subtitle if it exists
    const recentlyRead = recentlyReadTitle && recentlyReadAuthor
      ? `Recently read: ${recentlyReadTitle.split(':')[0]} by ${recentlyReadAuthor}`
      : `I haven't read anything recently.`

    // Update your gist
    await updateGist([wrap(currentlyReading), wrap(recentlyRead)]);
  } catch (error) {
    console.error(`Unable to fetch RSS feed\n${error}`)
  }
}

async function updateGist(readingStatus) {
  

  let gist;
  try {
    gist = await octokit.gists.get({ gist_id: gistId });
  } catch (error) {
    console.error(`Unable to get gist\n${error}`);
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